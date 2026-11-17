"""Publish a fetched policy through the robot's existing model manager."""

import argparse
import hashlib
from http.client import HTTPConnection, HTTPException, HTTPSConnection
import ipaddress
import json
from pathlib import Path
import re
import shlex
import ssl
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid


# The server may wait up to 120 seconds for model validation and publication.
REQUEST_TIMEOUT = 180
RECONCILE_TIMEOUT = 15
RECONCILE_INTERVAL = .5
RECEIVER_BOOTSTRAP = (
    "import os,runpy,sys;"
    "p=os.path.expanduser('~/wonderduck/extensions/wonderduck_studio/console/model_deploy.py');"
    "sys.path.insert(0,os.path.dirname(p));runpy.run_path(p,run_name='__main__')"
)


class ModelDeploymentError(ValueError):
    """The model was not confirmed as installed on the robot."""


class ModelDeploymentUnknown(ModelDeploymentError):
    """A submitted operation may have taken effect; it must not be retried automatically."""


class ModelControlConflict(ModelDeploymentError):
    """The server rejected rest before receiving or applying a model."""


class StudioUnavailable(ModelDeploymentError):
    """Studio cannot be reached before a model was submitted."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def add_robot_deployment_arguments(parser):
    """Add the same optional robot destination to each model-fetch command."""
    parser.add_argument("--deploy-robot", action="store_true",
                        help="将通过本机校验的模型更新到实机对应槽位，后台停止时下次启动生效")
    parser.add_argument("--robot-url", help="实机 Studio 地址；启用 --deploy-robot 时必须指定")


def _base_url(value):
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme in ("http", "https") and parsed.hostname and parsed.port != 0
                 and not parsed.username and not parsed.password and parsed.path in ("", "/")
                 and not parsed.query and not parsed.fragment)
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ValueError("实机地址须为 http(s)://主机[:端口]")
    return value.rstrip("/")


def _interpret_response(payload, code, *, submitted=False, unavailable_on_503=False):
    if code >= 300:
        try:
            detail = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            detail = {}
        reason = detail.get("error") if isinstance(detail, dict) else None
        reason = reason if isinstance(reason, str) and reason else f"HTTP {code}"
        if unavailable_on_503 and not submitted and code == 503:
            raise StudioUnavailable(f"实机模型服务不可用：{reason}")
        if submitted and code == 400 and isinstance(detail, dict) and detail.get("uncertain") is not True and reason in (
                "机器人拒绝休息：another control source owns the robot",
                "机器人拒绝休息：autonomous control owns the robot"):
            raise ModelControlConflict(reason)
        if submitted and (code >= 500 or (isinstance(detail, dict) and detail.get("uncertain") is True)):
            raise ModelDeploymentUnknown(f"模型更新结果未知：{reason}；请在实机模型管理中核对")
        raise ModelDeploymentError(f"实机模型操作失败：{reason}")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        if submitted:
            raise ModelDeploymentUnknown("模型更新返回无效数据，结果未知；请在实机模型管理中核对") from error
        raise ModelDeploymentError("实机返回了无效的模型管理数据") from error
    if not isinstance(value, dict):
        if submitted:
            raise ModelDeploymentUnknown("模型更新结果格式无效；请在实机模型管理中核对")
        raise ModelDeploymentError("实机模型管理数据格式无效")
    return value


def _response(opener, request, *, submitted=False, unavailable_on_503=False, timeout=REQUEST_TIMEOUT):
    try:
        with opener.open(request, timeout=timeout) as response:
            payload, code = response.read(), response.status
    except HTTPError as error:
        try:
            payload = error.read()
        except (OSError, HTTPException):
            payload = b""
        code = error.code
    except (URLError, OSError, TimeoutError, HTTPException) as error:
        if submitted:
            raise ModelDeploymentUnknown(f"模型请求连接中断，结果未知；请在实机模型管理中核对：{error}") from error
        if isinstance(error, HTTPException) or isinstance(error, ssl.SSLError) or (
                isinstance(error, URLError) and isinstance(error.reason, ssl.SSLError)):
            raise ModelDeploymentError(f"实机 Studio 连接异常：{error}") from error
        raise StudioUnavailable(f"无法连接实机 Studio：{error}") from error
    return _interpret_response(payload, code, submitted=submitted, unavailable_on_503=unavailable_on_503)


def _upload_response(request):
    """Read an early rejection even if the peer closes while the body is being sent."""
    url = urlsplit(request.full_url)
    connection_type = HTTPSConnection if url.scheme == "https" else HTTPConnection
    connection = connection_type(url.hostname, url.port, timeout=REQUEST_TIMEOUT)
    selector = url.path or "/"
    if url.query:
        selector += "?" + url.query
    try:
        try:
            connection.request("POST", selector, body=request.data, headers=dict(request.header_items()))
        except (OSError, TimeoutError, HTTPException) as send_error:
            try:
                response = connection.getresponse()
            except (OSError, TimeoutError, HTTPException) as response_error:
                raise ModelDeploymentUnknown(
                    f"模型请求连接中断，结果未知；请在实机模型管理中核对：{send_error}") from response_error
        else:
            try:
                response = connection.getresponse()
            except (OSError, TimeoutError, HTTPException) as error:
                raise ModelDeploymentUnknown(
                    f"模型请求连接中断，结果未知；请在实机模型管理中核对：{error}") from error
        with response:
            try:
                payload = response.read()
            except (OSError, TimeoutError, HTTPException) as error:
                raise ModelDeploymentUnknown(
                    f"模型更新响应中断，结果未知；请在实机模型管理中核对：{error}") from error
            code = response.status
        return _interpret_response(payload, code, submitted=True)
    finally:
        connection.close()


def _model(models, slot):
    if type(models.get("enabled")) is not bool or not isinstance(models.get("models"), list):
        raise ModelDeploymentError("实机模型列表格式无效")
    if not models["enabled"]:
        raise ModelDeploymentError("实机未启用策略模型，无法更新")
    matches = [item for item in models["models"] if isinstance(item, dict) and item.get("id") == slot]
    if not matches:
        raise ModelDeploymentError(f"该模型当前未加载：{slot}")
    if len(matches) != 1:
        raise ModelDeploymentError(f"实机模型槽位重复：{slot}")
    model = matches[0]
    if (model.get("loaded") is not True or type(model.get("active")) is not bool
            or not isinstance(model.get("path"), str) or not Path(model["path"]).is_absolute()
            or not isinstance(model.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", model["sha256"])):
        raise ModelDeploymentError(f"实机模型槽位 {slot} 的状态无效")
    if model.get("error"):
        raise ModelDeploymentError(f"实机当前模型状态异常：{model['error']}")
    return model


def _report(status, model, base, mode=None):
    label = "内容相同，已跳过" if status == "unchanged" else (
        "已更新，下次启动生效" if mode == "offline" else "已更新")
    print(f"实机模型{label}：{base}，槽位 {model['id']}\n"
          f"当前路径：{model['path']}\nSHA256：{model['sha256']}", flush=True)
    return {"status": status, "model": model}


def _local_receiver_path():
    return Path(__file__).resolve().with_name("model_deploy.py")


def _loopback(host):
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _receiver_command(base, slot, digest=None, filename=None):
    host = urlsplit(base).hostname
    if _loopback(host):
        receiver = _local_receiver_path()
        if not receiver.is_file():
            raise ModelDeploymentError(f"设备本机模型接收程序不存在：{receiver}")
        command = [sys.executable, str(receiver)]
    else:
        arguments = ["python3", "-c", RECEIVER_BOOTSTRAP]
        arguments += ["--slot", slot]
        arguments += ["--status"] if digest is None else ["--sha256", digest]
        if filename is not None:
            arguments += [f"--name={filename}"]
        return ["ssh", "-T", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
                "-o", "ServerAliveCountMax=3",
                f"wonderduck@{host}", shlex.join(arguments)]
    command += ["--slot", slot]
    command += ["--status"] if digest is None else ["--sha256", digest]
    if filename is not None:
        command += [f"--name={filename}"]
    return command


def _run_receiver(base, slot, *, blob=None, digest=None, filename=None):
    submitted = digest is not None
    command = _receiver_command(base, slot, digest, filename)
    try:
        result = subprocess.run(command, input=blob, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                check=False)
    except FileNotFoundError as error:
        raise ModelDeploymentError(f"无法启动实机模型接收程序：{error}") from error
    except (OSError, subprocess.SubprocessError) as error:
        if submitted:
            raise ModelDeploymentUnknown(f"模型传输中断，结果未知：{error}") from error
        raise ModelDeploymentError(f"无法读取实机模型状态：{error}") from error
    try:
        payload = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        suffix = f"：{detail}" if detail else ""
        if submitted:
            raise ModelDeploymentUnknown(f"设备接收程序未返回完整结果，模型更新结果未知{suffix}") from error
        raise ModelDeploymentError(f"设备接收程序未返回有效模型状态{suffix}") from error
    if not isinstance(payload, dict):
        if submitted:
            raise ModelDeploymentUnknown("设备接收程序的结果无效，模型更新结果未知")
        raise ModelDeploymentError("设备接收程序的模型状态无效")
    if result.returncode != 0 or payload.get("error"):
        reason = payload.get("error")
        if not isinstance(reason, str) or not reason:
            reason = result.stderr.decode("utf-8", errors="replace").strip() or f"退出码 {result.returncode}"
        if submitted and payload.get("uncertain") is not False:
            raise ModelDeploymentUnknown(f"模型更新结果未知：{reason}")
        raise ModelDeploymentError(f"实机模型操作失败：{reason}")
    return payload


def _receiver_model(payload, slot, digest, *, status):
    model = payload.get("model")
    if (payload.get("status") not in status or payload.get("mode") not in ("online", "offline")
            or not isinstance(model, dict) or model.get("id") != slot
            or model.get("sha256") != digest or model.get("error")
            or not isinstance(model.get("path"), str) or not Path(model["path"]).is_absolute()):
        raise ModelDeploymentUnknown("设备返回的模型信息不匹配，更新结果未知")
    return model


def _deploy_receiver(base, slot, blob, digest, filename):
    try:
        result = _run_receiver(base, slot, blob=blob, digest=digest, filename=filename)
        model = _receiver_model(result, slot, digest, status=("applied", "unchanged"))
    except ModelDeploymentUnknown as uncertain:
        try:
            current = _run_receiver(base, slot)
            model = _receiver_model(current, slot, digest, status=("current",))
        except ModelDeploymentError as error:
            raise uncertain from error
        return _report("applied", model, base, current["mode"])
    return _report(result["status"], model, base, result["mode"])


def _confirm_after_disconnect(opener, base, headers, slot, digest):
    deadline = time.monotonic() + RECONCILE_TIMEOUT
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            current = _model(_response(opener, Request(base + "/api/models", headers=headers),
                                       timeout=min(5, remaining)), slot)
            if current["sha256"] == digest:
                return current
        except ModelDeploymentError:
            pass
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(RECONCILE_INTERVAL, remaining))


def deploy_model(path, slot, args, *, expected_sha256=None):
    """Apply a validated local ONNX once and confirm its device-side hash.

    The existing model manager owns staging, validation, history, and restart persistence.
    A lost response is explicitly uncertain and is never resubmitted here.
    """
    if not args.deploy_robot:
        return None
    if not getattr(args, "robot_url", None):
        raise ValueError("请使用 --robot-url 指定实机 Studio 地址")
    base = _base_url(args.robot_url)
    if not isinstance(slot, str) or not slot:
        raise ModelDeploymentError("该模型没有对应的实机已加载槽位，不能直接更新")
    target = Path(path)
    if not target.is_file():
        raise FileNotFoundError(f"待更新模型不存在：{target}")
    blob = target.read_bytes()
    if not blob:
        raise ValueError("待更新模型为空")
    digest = hashlib.sha256(blob).hexdigest()
    if expected_sha256 is not None and digest != expected_sha256:
        raise ValueError("本机模型与已校验的 SHA256 不一致，未上传")

    opener = build_opener(ProxyHandler({}), _NoRedirect())
    try:
        info = _response(opener, Request(base + "/api/info"))
        token = info.get("token")
        if (not isinstance(token, str) or not token or info.get("studio") is not True
                or info.get("demo") is not False or info.get("readonly") is not False):
            raise ModelDeploymentError("实机未运行支持模型管理的 Studio")
        headers = {"X-Console-Token": token, "X-Console-Client": "fetch-" + uuid.uuid4().hex,
                   "X-Studio-Workspace": "models"}
        model = _model(_response(opener, Request(base + "/api/models", headers=headers),
                                 unavailable_on_503=True), slot)
    except StudioUnavailable:
        return _deploy_receiver(base, slot, blob, digest, target.name)
    if model["sha256"] == digest:
        return _report("unchanged", model, base)
    if model["active"]:
        print(f"实机槽位 {slot} 正在运行，更新时机器人可能回 HOME。", flush=True)

    query = urlencode({"slot": slot, "name": target.name})
    upload = Request(base + "/api/models/apply?" + query, data=blob, method="POST",
                     headers={**headers, "Content-Type": "application/octet-stream"})
    try:
        result = _upload_response(upload)
    except ModelControlConflict:
        # An older Studio may still be running after the updated receiver was
        # installed. This particular rejection happens before model submission.
        print("控制权被占用，正在通过设备端更新程序停止当前控制并重试……", flush=True)
        return _deploy_receiver(base, slot, blob, digest, target.name)
    except ModelDeploymentUnknown as uncertain:
        print("模型请求中断，正在核对实机当前模型……", flush=True)
        current = _confirm_after_disconnect(opener, base, headers, slot, digest)
        if current is not None:
            return _report("applied", current, base)
        raise uncertain
    applied = result.get("model")
    if (result.get("status") not in ("applied", "unchanged") or not isinstance(applied, dict)
            or applied.get("id") != slot or applied.get("sha256") != digest or applied.get("error")):
        raise ModelDeploymentUnknown("模型更新返回的信息不匹配；请在实机模型管理中核对")
    try:
        current = _model(_response(opener, Request(base + "/api/models", headers=headers)), slot)
    except ModelDeploymentError as error:
        raise ModelDeploymentUnknown(f"模型更新后无法确认实机状态；请在实机模型管理中核对：{error}") from error
    if current["sha256"] != digest:
        raise ModelDeploymentUnknown("实机当前模型哈希与更新结果不同；请在实机模型管理中核对")
    return _report(result["status"], current, base)


def main():
    parser = argparse.ArgumentParser(description="将已有 ONNX 校验并应用到实机模型槽位。")
    parser.add_argument("model", type=Path, help="已有 ONNX 文件")
    parser.add_argument("--slot", required=True, help="已加载的模型槽位，例如 stand 或 walk")
    parser.add_argument("--robot-url", required=True, help="实机 Studio 地址")
    args = parser.parse_args()
    args.deploy_robot = True
    try:
        deploy_model(args.model, args.slot, args)
    except (OSError, ValueError) as error:
        print(f"模型更新失败：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
