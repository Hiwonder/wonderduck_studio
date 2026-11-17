"""Download and apply the six standard models, one at a time."""

import copy
from contextlib import ExitStack, contextmanager
import json
import logging
from pathlib import Path
import re
import tempfile
import threading
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

from app.models.model_management import ModelUncertainError, RPC_TIMEOUT


ONLINE_MODELS = (
    ("ground_pick", "ground_pick.onnx"),
    ("sitstand", "sitstand.onnx"),
    ("stand", "stand.onnx"),
    ("walk", "velocity.onnx"),
    ("kick_left", "ball_kick_left.onnx"),
    ("kick_right", "ball_kick_right.onnx"),
)
DOWNLOAD_TIMEOUT = 20
DOWNLOAD_CHUNK_SIZE = 64 * 1024
REST_TIMEOUT = 120
REST_POLL_INTERVAL = .25
VERSION_FILE = "model-version.json"
ONLINE_MODEL_DIRECTORY = "https://wonderrl.hiwonder.com.cn/download/WonderDuck/"
DEVICE_VERSION_FILE = Path("/etc/robot/device-version.json")
VERSION_LIMIT = 16 * 1024
VERSION_PATTERN = re.compile(r"(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\Z")


def directory_file_url(address, name):
    if not isinstance(address, str) or not address.strip():
        raise ValueError("请填写模型目录地址")
    try:
        parts = urlsplit(address.strip())
        _ = parts.port  # Validate an explicitly supplied port.
    except ValueError as error:
        raise ValueError("模型目录地址无效") from error
    if (parts.scheme not in ("http", "https") or not parts.hostname or parts.fragment
            or parts.username is not None or parts.password is not None):
        raise ValueError("请填写有效的 HTTP 或 HTTPS 模型目录地址")
    directory = parts.path.rstrip("/") + "/"
    return urlunsplit((parts.scheme, parts.netloc, directory + name, parts.query, ""))


def model_urls(address):
    return [(slot, name, directory_file_url(address, name)) for slot, name in ONLINE_MODELS]


def parse_versions(raw, label):
    try:
        data = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{label}版本文件不是有效的 JSON") from error
    if not isinstance(data, dict):
        raise ValueError(f"{label}版本文件格式无效")
    result = {}
    for key in ("hardware_version", "image_version"):
        value = data.get(key)
        if not isinstance(value, str) or not VERSION_PATTERN.fullmatch(value):
            raise ValueError(f"{label}版本文件的 {key} 必须为三段数字，例如 1.0.0")
        result[key] = value
    return result


def device_versions(path=DEVICE_VERSION_FILE):
    try:
        with Path(path).open("rb") as stream:
            content = stream.read(VERSION_LIMIT + 1)
    except OSError as error:
        raise ValueError(f"无法读取本机版本文件 {path}：{error.strerror or error}") from error
    if len(content) > VERSION_LIMIT:
        raise ValueError("本机版本文件过大")
    return parse_versions(content, "本机")


def compare_versions(current, required):
    def numbers(value):
        return tuple(map(int, value.split(".")))
    if numbers(current["hardware_version"]) < numbers(required["hardware_version"]):
        return "hardware_incompatible"
    if numbers(current["image_version"]) < numbers(required["image_version"]):
        return "image_too_old"
    return "compatible"


class OnlineModelUpdater:
    def __init__(self, manager, control_factory, opener=urlopen, version_path=DEVICE_VERSION_FILE,
                 directory_url=ONLINE_MODEL_DIRECTORY):
        self.manager = manager
        self.control_factory = control_factory
        self.control = None
        self.opener = opener
        self.version_path = Path(version_path)
        self.directory_url = directory_url
        self.lock = threading.Lock()
        self.operation_lock = threading.Lock()
        self.job = None

    @contextmanager
    def manual_operation(self):
        if not self.operation_lock.acquire(blocking=False):
            raise ValueError("已有模型更新正在进行")
        try:
            with self.control_factory() as control:
                self.control = control
                try:
                    if not self._begin_rest(None):
                        error = self._wait_rest(None, threading.Event(), threading.Event())
                        if error is not None:
                            raise ValueError(f"休息未完成：{error}") from error
                    self._require_rest()
                    try:
                        yield
                    except ModelUncertainError as error:
                        raise ModelUncertainError(f"{error}；未自动启动，请确认模型状态") from error
                    except ValueError as error:
                        try:
                            self._resume()
                        except Exception as resume_error:
                            raise ValueError(f"{error}；重新启动失败：{resume_error}") from resume_error
                        raise
                    except Exception as error:
                        raise ModelUncertainError(f"模型操作结果未知：{error}；未自动启动，请检查模型状态") from error
                    else:
                        try:
                            self._resume()
                        except Exception as error:
                            raise ValueError(f"模型操作已完成，但重新启动失败：{error}") from error
                finally:
                    self.control = None
        finally:
            self.operation_lock.release()

    def status(self):
        with self.lock:
            return {"job": copy.deepcopy(self.job)}

    def check(self, address=None):
        address = self.directory_url if address is None else address
        url = directory_file_url(address, VERSION_FILE)
        current = device_versions(self.version_path)
        try:
            with self.opener(Request(url, headers={"Accept-Encoding": "identity"}), timeout=DOWNLOAD_TIMEOUT) as response:
                raw_size = response.headers.get("Content-Length")
                if raw_size is not None:
                    try:
                        expected = int(raw_size)
                    except ValueError as error:
                        raise ValueError("服务器模型版本文件大小无效") from error
                    if expected < 0 or expected > VERSION_LIMIT:
                        raise ValueError("服务器模型版本文件大小无效")
                content = response.read(VERSION_LIMIT + 1)
                if raw_size is not None and len(content) != expected:
                    raise ValueError("服务器模型版本文件下载不完整")
        except HTTPError as error:
            raise ValueError(f"无法读取服务器模型版本文件：HTTP {error.code}") from error
        except (URLError, OSError, TimeoutError) as error:
            raise ValueError(f"无法读取服务器模型版本文件：{error}") from error
        if len(content) > VERSION_LIMIT:
            raise ValueError("服务器模型版本文件过大")
        required = parse_versions(content, "服务器")
        return dict(status=compare_versions(current, required), current=current, required=required)

    def start(self, address=None):
        address = self.directory_url if address is None else address
        urls = model_urls(address)
        if not self.operation_lock.acquire(blocking=False):
            raise ValueError("已有模型更新正在进行")
        try:
            compatibility = self.check(address)
            if compatibility["status"] != "compatible":
                self.operation_lock.release()
                return {"compatibility": compatibility}
            with self.lock:
                job_id = uuid.uuid4().hex
                self.job = dict(id=job_id, state="running", rest=dict(state="requesting", error=None),
                                resume=dict(state="waiting", error=None), items=[
                    dict(slot=slot, filename=name, state="waiting", downloaded=0, total=None, error=None)
                    for slot, name, _ in urls
                ])
                worker = threading.Thread(target=self._run, args=(job_id, urls), name="model-download", daemon=True)
                worker.start()
                return {"job": copy.deepcopy(self.job)}
        except BaseException:
            with self.lock:
                self.job = None
            self.operation_lock.release()
            raise

    def _item(self, job_id, index, **changes):
        with self.lock:
            if self.job and self.job["id"] == job_id:
                self.job["items"][index].update(changes)

    def _rest(self, job_id, state, error=None):
        with self.lock:
            if self.job and self.job["id"] == job_id and self.job["state"] == "running":
                self.job["rest"] = dict(state=state, error=error)

    def _resume_state(self, job_id, state, error=None):
        with self.lock:
            if self.job and self.job["id"] == job_id and self.job["state"] == "running":
                self.job["resume"] = dict(state=state, error=error)

    def _rest_status(self):
        status = self.manager.query((("robot.policies", {}),), timeout=RPC_TIMEOUT)["robot.policies"]
        if (not isinstance(status, dict) or status.get("rest_phase") not in ("idle", "resting", "rested", "failed")
                or type(status.get("motion_enabled")) is not bool):
            raise ValueError("无法确认机器人休息状态，请检查控制程序版本")
        return status["rest_phase"], status["motion_enabled"]

    def _require_rest(self):
        self.control.verify()
        phase, enabled = self._rest_status()
        if phase != "rested" or enabled:
            raise ValueError("机器人已离开休息状态")

    def _resume(self):
        self._require_rest()
        for method, params, label in (("robot.init", {}, "初始化"),
                                       ("robot.enable", {"on": True, "toggle": False}, "开启策略")):
            reply = self.control.query(((method, params),), timeout=RPC_TIMEOUT)[method]
            if not isinstance(reply, dict) or type(reply.get("accepted")) is not bool:
                raise ValueError(f"{label}结果未确认")
            if not reply["accepted"]:
                raise ValueError(f"{label}被拒绝：{reply.get('reason') or '未知原因'}")
        deadline = time.monotonic() + REST_TIMEOUT
        while True:
            status = self.manager.query((("robot.policies", {}),), timeout=RPC_TIMEOUT)["robot.policies"]
            if (not isinstance(status, dict) or type(status.get("enabled")) is not bool
                    or type(status.get("motion_enabled")) is not bool or type(status.get("homed")) is not bool):
                raise ValueError("无法确认机器人启动状态")
            if not status["enabled"]:
                raise ValueError("机器人未加载策略")
            if not status["motion_enabled"]:
                raise ValueError("策略未保持开启")
            if status["homed"]:
                return
            if time.monotonic() >= deadline:
                raise TimeoutError("等待机器人初始化完成超时")
            time.sleep(REST_POLL_INTERVAL)

    def _begin_rest(self, job_id):
        phase, enabled = self._rest_status()
        if phase == "rested":
            if enabled:
                raise ValueError("机器人休息状态不一致")
            self._rest(job_id, "rested")
            return True
        if phase != "resting":
            reply = self.control.query((("robot.rest", {}),), timeout=RPC_TIMEOUT)["robot.rest"]
            if not isinstance(reply, dict) or type(reply.get("accepted")) is not bool:
                raise ValueError("休息请求结果未确认")
            if not reply["accepted"]:
                # Another client may have started the same rest between the two requests.
                phase, enabled = self._rest_status()
                if phase == "rested" and not enabled:
                    self._rest(job_id, "rested")
                    return True
                if phase != "resting":
                    raise ValueError(f"机器人拒绝休息：{reply.get('reason') or '未知原因'}")
        self._rest(job_id, "resting")
        return False

    def _wait_rest(self, job_id, done, cancelled):
        try:
            deadline = time.monotonic() + REST_TIMEOUT
            while not cancelled.is_set():
                phase, enabled = self._rest_status()
                if phase == "rested":
                    if enabled:
                        raise ValueError("机器人休息状态不一致")
                    self._rest(job_id, "rested")
                    return
                if phase == "failed":
                    raise ValueError("机器人休息失败")
                if phase != "resting":
                    raise ValueError("机器人休息被中断")
                if time.monotonic() >= deadline:
                    raise TimeoutError("等待机器人休息完成超时")
                cancelled.wait(REST_POLL_INTERVAL)
        except Exception as error:
            self._rest(job_id, "failed", str(error) or "休息状态未确认")
            return error
        finally:
            done.set()

    def _skip_pending(self, job_id, reason):
        with self.lock:
            if self.job and self.job["id"] == job_id:
                for item in self.job["items"]:
                    if item["state"] in ("waiting", "downloading", "downloaded"):
                        item.update(state="not_started", error=reason)

    def _run(self, job_id, urls):
        rest_done, cancelled = threading.Event(), threading.Event()
        rest_started = False
        uncertain = False
        control = None
        control_entered = False
        try:
            control = self.control_factory()
            control.__enter__()
            control_entered = True
            self.control = control
            try:
                already_rested = self._begin_rest(job_id)
            except Exception as error:
                reason = str(error) or "休息请求未确认"
                self._rest(job_id, "failed", reason)
                self._skip_pending(job_id, f"休息未完成：{reason}")
                return
            if already_rested:
                rest_done.set()
            else:
                threading.Thread(target=self._wait_rest, args=(job_id, rest_done, cancelled),
                                 name="model-update-rest", daemon=True).start()
            rest_started = True
            with ExitStack() as files:
                candidates = []
                for index, (slot, filename, url) in enumerate(urls):
                    if rest_done.is_set():
                        rest = self.status()["job"]["rest"]
                        if rest["state"] == "failed":
                            self._skip_pending(job_id, f"休息未完成：{rest.get('error') or '状态未确认'}")
                            return
                    self._item(job_id, index, state="downloading")
                    try:
                        downloaded = files.enter_context(tempfile.TemporaryFile())
                        request = Request(url, headers={"Accept-Encoding": "identity"})
                        with self.opener(request, timeout=DOWNLOAD_TIMEOUT) as response:
                            raw_size = response.headers.get("Content-Length")
                            if raw_size is not None:
                                try:
                                    total = int(raw_size)
                                except ValueError as error:
                                    raise ValueError("服务器返回的文件大小无效") from error
                                if total < 0:
                                    raise ValueError("服务器返回的文件大小无效")
                            else:
                                total = None
                            self._item(job_id, index, total=total)
                            size = 0
                            while True:
                                chunk = response.read(DOWNLOAD_CHUNK_SIZE)
                                if not chunk:
                                    break
                                downloaded.write(chunk)
                                size += len(chunk)
                                self._item(job_id, index, downloaded=size)
                            if total is not None and size != total:
                                raise ValueError("模型下载不完整")
                            if size == 0:
                                raise ValueError("下载的模型为空")
                        self._item(job_id, index, state="downloaded")
                        candidates.append((index, slot, filename, downloaded, size))
                    except HTTPError as error:
                        self._item(job_id, index, state="failed", error=f"下载失败：HTTP {error.code}")
                    except URLError as error:
                        self._item(job_id, index, state="failed", error=f"下载失败：{error.reason}")
                    except ValueError as error:
                        self._item(job_id, index, state="failed", error=str(error) or "下载失败")
                    except Exception as error:
                        logging.exception("online model download failed for %s", filename)
                        self._item(job_id, index, state="failed", error=str(error) or "下载失败")
                rest_done.wait()
                rest = self.status()["job"]["rest"]
                if rest["state"] != "rested":
                    self._skip_pending(job_id, f"休息未完成：{rest.get('error') or '状态未确认'}")
                    return
                for index, slot, filename, downloaded, size in candidates:
                    try:
                        self._require_rest()
                    except Exception as error:
                        reason = str(error) or "休息状态未确认"
                        self._rest(job_id, "failed", reason)
                        self._skip_pending(job_id, f"休息未完成：{reason}")
                        break
                    try:
                        downloaded.seek(0)
                        self._item(job_id, index, state="applying")
                        result = self.manager.apply(slot, downloaded, size, filename, before_apply=self._require_rest)
                        if (not isinstance(result, dict) or result.get("status") not in ("applied", "unchanged")
                                or result.get("model", {}).get("id") != slot):
                            raise ModelUncertainError("模型更新结果不完整，请刷新模型列表确认")
                        self._item(job_id, index, state=result["status"])
                    except ModelUncertainError as error:
                        uncertain = True
                        self._item(job_id, index, state="uncertain", error=str(error))
                        self._skip_pending(job_id, "前一项更新结果未确认")
                        break
                    except ValueError as error:
                        self._item(job_id, index, state="failed", error=str(error) or "模型更新失败")
                    except Exception:
                        uncertain = True
                        logging.exception("online model update failed for %s", filename)
                        self._item(job_id, index, state="uncertain", error="更新过程异常，请刷新模型列表确认")
                        self._skip_pending(job_id, "前一项更新结果未确认")
                        break
        except Exception as error:
            logging.exception("online model update stopped unexpectedly")
            if not rest_started:
                self._rest(job_id, "failed", str(error) or "控制会话未就绪")
            self._skip_pending(job_id, f"更新未完成：{str(error) or '服务异常'}")
        finally:
            try:
                if rest_started:
                    rest_done.wait()
                    rest = self.status()["job"]["rest"]
                    if rest["state"] == "rested" and not uncertain:
                        self._resume_state(job_id, "starting")
                        try:
                            self._resume()
                        except Exception as error:
                            self._resume_state(job_id, "failed", str(error) or "启动状态未确认")
                        else:
                            self._resume_state(job_id, "started")
                    else:
                        reason = "模型更新结果未知，请先检查模型状态" if uncertain else "机器人休息未完成"
                        self._resume_state(job_id, "skipped", reason)
                else:
                    self._resume_state(job_id, "skipped", "机器人休息未完成")
            finally:
                cancelled.set()
                self.control = None
                try:
                    if control_entered:
                        control.__exit__(None, None, None)
                except Exception:
                    logging.exception("cannot close model update control")
                finally:
                    with self.lock:
                        if self.job and self.job["id"] == job_id:
                            self.job["state"] = "finished"
                    self.operation_lock.release()
