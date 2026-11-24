#!/usr/bin/env python3
"""HTTP entry point for the robot maintenance console."""

import argparse
from concurrent.futures import TimeoutError as FutureTimeout
from contextlib import nullcontext
import gzip
import json
import logging
import mimetypes
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from app.actions.action_documents import ActionDocuments
from app.actions.target_export import list_targets, load_targets, save_targets
from app.models.model_management import ModelManager, ModelUncertainError
from app.models.online_update import OnlineModelUpdater, device_versions
from app.models.update_control import UpdateControl
from app.robot.controller import Controller, DemoHardware
from app.robot.protocol import REGISTERS
from app.robot.robotd_state import query_robotd
from app.robot.studio import WORKSPACES
from app.sensors.camera import Camera
from app.sensors.qmi_imu import AuxiliaryImu
from app.sensors.tof import TofReader
from app.system import network, resources, service_control, software_update
from app.system.runtime_config import ModelPaletteStore, NetworkAnnouncementStore, robot_root, software_version
from app.system.secure_transport import SecureTransport


STATE_DIAGNOSTIC_LOCK = threading.Lock()
STATE_DIAGNOSTIC_LAST = 0.0


class RequestBody:
    """Track unread bytes so an early error can be delivered without a TCP reset."""

    def __init__(self, source, length):
        self.source = source
        self.remaining = length

    def read(self, size=-1):
        amount = self.remaining if size < 0 else min(size, self.remaining)
        data = self.source.read(amount)
        self.remaining -= len(data)
        return data

    def discard(self, connection, timeout=5):
        deadline = time.monotonic() + timeout
        while self.remaining:
            remaining_time = deadline - time.monotonic()
            if remaining_time <= 0:
                return
            connection.settimeout(remaining_time)
            data = self.source.read1(min(self.remaining, 64 * 1024))
            if not data:
                return
            self.remaining -= len(data)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Send small JSON bodies immediately instead of waiting for delayed TCP ACKs.
    disable_nagle_algorithm = True

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, message, *args):
        if len(args) < 2 or str(args[1]) not in ("200", "304"):
            logging.info(message, *args)

    def send_json(self, data, status=200):
        # An early POST rejection may leave unread body bytes on this connection.
        if status >= 400:
            self.close_connection = True
        payload = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
        encoding = None
        # Browser responses are highly repetitive. Level 1 keeps API CPU work small.
        accepted = self.headers.get("Accept-Encoding", "").lower().split(",")
        if len(payload) >= 1024 and any(item.strip() == "gzip" for item in accepted):
            payload = gzip.compress(payload, compresslevel=1)
            encoding = "gzip"
        self.send_body(payload, "application/json; charset=utf-8", status, "no-store", encoding)

    def send_post_error(self, data, status, body):
        self.send_json(data, status)
        if body is not None and body.remaining:
            try:
                body.discard(self.connection)
            except (OSError, TimeoutError):
                # The response was already sent; the sender may have disconnected.
                pass

    def send_body(self, data, content_type, status=200, cache="no-cache", encoding=None):
        self.send_headers(len(data), content_type, status, cache, encoding)
        try:
            self.wfile.write(data)
        except (ConnectionError, TimeoutError):
            self.close_connection = True

    def send_headers(self, length, content_type, status=200, cache="no-cache", encoding=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        self.send_header("Vary", "Accept-Encoding")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()

    @property
    def controller(self):
        return self.server.controller

    @property
    def client(self):
        return self.headers.get("X-Console-Client", "")[:80]

    @property
    def head_subscription_revision(self):
        text = self.headers.get("X-Head-Subscription-Revision", "")
        return int(text) if text.isascii() and text.isdigit() and len(text) <= 15 else None

    @property
    def camera(self):
        camera = getattr(self.server, "camera", None)
        if camera is None:
            raise RuntimeError("当前服务未提供摄像头")
        return camera

    def model_manager(self):
        if self.headers.get("X-Console-Token") != self.controller.token or not self.client:
            raise PermissionError("会话无效，请刷新页面")
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            raise PermissionError("不接受跨站操作")
        if (not getattr(self.server, "studio", False) or self.controller.demo
                or getattr(self.controller, "readonly", False)):
            raise PermissionError("当前服务不提供模型管理")
        if self.headers.get("X-Studio-Workspace") != "models":
            raise PermissionError("请先打开模型管理")
        manager = getattr(self.server, "model_manager", None)
        if manager is None:
            raise RuntimeError("当前服务未配置模型管理")
        return manager

    def online_model_updater(self):
        self.model_manager()
        updater = getattr(self.server, "online_model_updater", None)
        if updater is None:
            raise RuntimeError("当前服务未配置在线模型更新")
        return updater

    def model_operation(self):
        return self.online_model_updater().manual_operation()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/software-update":
            if not getattr(self.server, "studio", False) or self.controller.demo:
                self.send_json({"error": "当前服务不提供软件更新"}, 404)
                return
            try:
                self.send_json(software_update.status(self.server.robot_root))
            except (OSError, subprocess.SubprocessError) as error:
                self.send_json({"error": str(error)}, 503)
            return
        if path == "/api/info":
            native_readonly = getattr(self.controller, "readonly", False)
            readonly = native_readonly
            if getattr(self.server, "studio", False) and hasattr(self.controller, "readonly_for"):
                readonly = readonly or self.controller.readonly_for(self.client)
            registers = [dict(item, writable=False) for item in REGISTERS] if readonly else REGISTERS
            updater = getattr(self.server, "online_model_updater", None)
            try:
                versions = device_versions(updater.version_path) if updater else device_versions()
            except ValueError:
                versions = None
            versions = dict(versions or {}, software_version=software_version(getattr(self.server, "robot_root", None)))
            if getattr(self.server, "studio", False):
                try:
                    health = query_robotd(self.controller.path, (("robot.health", {}),), timeout=.5)["robot.health"]
                    firmware = health.get("imu_firmware_version")
                    if not isinstance(firmware, str) or not firmware:
                        firmware = None
                except (OSError, ValueError, AttributeError):
                    firmware = None
                versions = dict(versions or {}, imu_firmware_version=firmware)
            self.send_json(dict(joints=self.controller.joints, registers=registers, token=self.controller.token,
                                demo=self.controller.demo, hz=self.controller.hz,
                                imu_source=self.controller.imu_source, readonly=readonly, device_versions=versions,
                                studio=getattr(self.server, "studio", False),
                                workspaces=sorted(WORKSPACES) if getattr(self.server, "studio", False) else None,
                                supports_software_update=(getattr(self.server, "studio", False) and not self.controller.demo
                                    and software_update.available(self.server.robot_root)),
                                supports_service_restart=(getattr(self.server, "studio", False)
                                    and not self.controller.demo),
                                supports_shutdown=(getattr(self.server, "studio", False)
                                    and not self.controller.demo and hasattr(self.controller, "shutdown")),
                                supports_online_models=getattr(self.server, "online_model_updater", None) is not None,
                                supports_online_model_rest=getattr(self.server, "online_model_updater", None) is not None,
                                supports_model_update_resume=getattr(self.server, "online_model_updater", None) is not None,
                                supports_model_version_gate=getattr(self.server, "online_model_updater", None) is not None,
                                supports_locked_release=not native_readonly,
                                supports_home_targets=not readonly, supports_direct_slider=not readonly,
                                supports_direct_action_frame=not readonly))
        elif path == "/api/internal/maintenance-voltage":
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                self.send_json(dict(error="local access only"), 403)
            elif not getattr(self.server, "studio", False) or not hasattr(self.controller, "maintenance_voltage_snapshot"):
                self.send_json(dict(available=False))
            else:
                self.send_json(self.controller.maintenance_voltage_snapshot())
        elif path == "/api/state":
            state_started = time.monotonic()
            workspace = self.headers.get("X-Studio-Workspace")
            if getattr(self.server, "studio", False):
                self.controller.set_status_visible(self.client, workspace in ("status", "action", "debug", "calibration"))
            state = self.controller.snapshot(self.client)
            control_done = time.monotonic()
            if getattr(self.server, "tof", None) is not None:
                state["tof"] = self.server.tof.snapshot()
            auxiliary = getattr(self.server, "auxiliary_imu", None)
            if auxiliary is not None:
                studio = getattr(self.server, "studio", False)
                with self.controller.lock if studio else nullcontext():
                    entry = self.controller.client_workspaces.get(self.client) if studio else None
                    actual = entry[0] if entry is not None else None
                    current = not studio or actual == workspace
                    hidden_status = studio and actual == "status" and workspace == ""
                    if current or hidden_status:
                        head_calibration = (current and workspace == "calibration" and
                                            self.headers.get("X-Calibration-Source") == "head")
                        active = current and (workspace == "status" or head_calibration)
                        aux_state = auxiliary.snapshot(self.client, active, calibration=head_calibration,
                                                       revision=self.head_subscription_revision)
                        if active:
                            state["aux_imu"] = aux_state
                        if workspace == "calibration":
                            state["head_calibration"] = auxiliary.calibration_snapshot()
            auxiliary_done = time.monotonic()
            now = time.monotonic()
            state["age_ms"] = round((now - state.pop("sampled_monotonic", 0)) * 1000)
            # Each device may have succeeded, failed, or been polled at a different
            # instant. Never substitute the aggregate control-frame timestamp.
            state["servos"] = [dict(item) for item in state.get("servos", [])]
            if "control_servos" in state:
                state["control_servos"] = [dict(item) for item in state["control_servos"]]
            state["imu"] = dict(state.get("imu") or {})
            if isinstance(state["imu"].get("raw_sample"), dict):
                raw_sample = dict(state["imu"]["raw_sample"])
                sampled = raw_sample.pop("sampled_monotonic", None)
                raw_sample["age_us"] = round((now - sampled) * 1_000_000) if sampled is not None else None
                state["imu"]["raw_sample"] = raw_sample
            for item in [*state["servos"], *state.get("control_servos", []), state["imu"]]:
                for source, target in (("sampled_monotonic", "age_ms"),
                                       ("observed_monotonic", "observation_age_ms")):
                    sampled = item.pop(source, None)
                    item[target] = round((now - sampled) * 1000) if sampled is not None else None
                    if source == "sampled_monotonic" and sampled is not None:
                        item.setdefault("t_ns", round(sampled * 1e9))
            self.send_json(state)
            state_done = time.monotonic()
            if (state_done - state_started > .5 and
                    (workspace == "status" or workspace == "calibration" and
                     self.headers.get("X-Calibration-Source") == "head")):
                global STATE_DIAGNOSTIC_LAST
                with STATE_DIAGNOSTIC_LOCK:
                    report = state_done - STATE_DIAGNOSTIC_LAST >= 10.0
                    if report:
                        STATE_DIAGNOSTIC_LAST = state_done
                if report:
                    logging.warning("头部 IMU 页面状态请求慢 total_ms=%.1f control_ms=%.1f auxiliary_ms=%.1f response_ms=%.1f",
                                    (state_done - state_started) * 1000, (control_done - state_started) * 1000,
                                    (auxiliary_done - control_done) * 1000, (state_done - auxiliary_done) * 1000)
        elif path == "/api/model-palette":
            self.send_json(self.server.model_palette.snapshot())
        elif path == "/api/network-announcement":
            try:
                self.send_json(self.server.network_announcement.snapshot())
            except (OSError, ValueError) as error:
                logging.warning("读取开机网络播报设置失败：%s", error)
                self.send_json(dict(error="读取开机网络播报设置失败"), 500)
        elif path == "/api/resources":
            try:
                self.send_json(resources.snapshot())
            except (OSError, ValueError) as error:
                self.send_json(dict(error=str(error)), 503)
        elif path == "/api/camera":
            try:
                self.send_json(self.camera.status())
            except RuntimeError as error:
                self.send_json(dict(error=str(error)), 503)
        elif path == "/api/network":
            try:
                self.send_json(network.status())
            except (RuntimeError, OSError, ValueError) as error:
                self.send_json(dict(error=str(error)), 503)
        elif path == "/api/models":
            try:
                self.send_json(self.model_manager().list_models())
            except PermissionError as error:
                self.send_json(dict(error=str(error)), 403)
            except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
                self.send_json(dict(error=str(error)), 503)
        elif path == "/api/models/online":
            try:
                self.send_json(self.online_model_updater().status())
            except PermissionError as error:
                self.send_json(dict(error=str(error)), 403)
            except RuntimeError as error:
                self.send_json(dict(error=str(error)), 503)
        elif path in ("/api/calibration/log", "/api/calibration/report"):
            if getattr(self.controller, "readonly", False):
                self.send_json(dict(error="robotd 只读模式不提供标定文件"), 404)
                return
            key = "log" if path.endswith("/log") else "report"
            location = self.controller.calibration.snapshot().get(key)
            target = Path(location) if location else None
            if target is None or not target.is_file():
                self.send_json(dict(error="文件尚未生成"), 404)
            else:
                mime = "text/plain; charset=utf-8" if key == "log" else "application/json; charset=utf-8"
                self.send_body(target.read_bytes(), mime, cache="no-store")
        elif path.startswith("/api/"):
            self.send_json(dict(error="不存在的接口"), 404)
        else:
            static = self.server.static
            target = (static / (path.lstrip("/") or "index.html")).resolve()
            if static not in target.parents or not target.is_file():
                self.send_json(dict(error="文件不存在"), 404)
                return
            mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if target.suffix == ".js":
                mime = "text/javascript"
            try:
                with target.open('rb') as source:
                    self.send_headers(target.stat().st_size, mime,
                                      cache="public, max-age=86400" if path.startswith("/assets/") else "no-cache")
                    shutil.copyfileobj(source, self.wfile, length=64 * 1024)
            except (ConnectionError, TimeoutError):
                self.close_connection = True

    def do_POST(self):
        body = None
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 0:
                body = RequestBody(self.rfile, length)
            if self.headers.get("X-Console-Token") != self.controller.token or not self.client:
                raise PermissionError("会话无效，请刷新页面")
            origin = self.headers.get("Origin")
            if origin and urlsplit(origin).netloc != self.headers.get("Host"):
                raise PermissionError("不接受跨站操作")
            path = urlsplit(self.path).path
            if path == "/api/models/apply":
                manager = self.model_manager()
                if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
                    raise ValueError("请选择模型文件")
                query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                slots, names = query.get("slot", []), query.get("name", [])
                if len(slots) != 1:
                    raise ValueError("模型选项无效")
                if len(names) > 1:
                    raise ValueError("模型文件名无效")
                self.connection.settimeout(60)
                try:
                    with self.model_operation():
                        result = manager.apply(slots[0], body, length, names[0] if names else None,
                                               before_apply=self.server.online_model_updater._require_rest)
                finally:
                    self.connection.settimeout(10)
                self.send_json(result)
                return
            maximum = 16 * 1024 * 1024 if path in ("/api/action-document", "/api/action-playback") else 65536
            if not 0 < length <= maximum:
                raise ValueError("请求大小无效")
            command = json.loads(body.read(length))
            if not isinstance(command, dict):
                raise ValueError("请求必须为对象")
            if path == "/api/model-palette":
                self.send_json(self.server.model_palette.save(command.get("palette")))
                return
            if path == "/api/network-announcement":
                self.send_json(self.server.network_announcement.save(command.get("enabled")))
                return
            if path == "/api/models/restore":
                manager = self.model_manager()
                with self.model_operation():
                    result = manager.restore(command.get("slot"),
                                             before_apply=self.server.online_model_updater._require_rest)
                self.send_json(result)
                return
            if path == "/api/models/online":
                updater = self.online_model_updater()
                self.send_json(updater.start())
                return
            if path == "/api/models/online/check":
                updater = self.online_model_updater()
                self.send_json(updater.check())
                return
            if path == "/api/emergency-release":
                release = getattr(self.controller, "emergency_release", None)
                if release is None or getattr(self.controller, "readonly", False):
                    raise PermissionError("当前服务不能操作舵机卸力")
                result = (release(self.client, command.get("run_id")) if getattr(self.server, "studio", False)
                          else release())
                self.send_json(result)
                return
            if path == "/api/shutdown":
                if (not getattr(self.server, "studio", False) or self.controller.demo
                        or not hasattr(self.controller, "shutdown")):
                    raise PermissionError("当前服务不提供关机操作")
                self.send_json(self.controller.shutdown(self.client))
                return
            if path == "/api/service/restart":
                if not getattr(self.server, "studio", False) or self.controller.demo:
                    raise PermissionError("当前服务不提供重启操作")
                self.send_json(service_control.restart_robotd())
                return
            if path == "/api/software-update":
                if (not getattr(self.server, "studio", False) or self.controller.demo
                        or not software_update.available(self.server.robot_root)):
                    raise PermissionError("当前服务不提供软件更新")
                if self.headers.get("X-Studio-Workspace") != "system":
                    raise PermissionError("请先打开系统设置")
                with self.controller.lock:
                    if self.controller.client_workspaces.get(self.client, (None,))[0] != "system":
                        raise PermissionError("请先打开系统设置")
                self.send_json(software_update.handle(self.server.robot_root, self.controller.path, command,
                                                      self.server.server_address[1]))
                return
            if path == "/api/control-actions":
                if not getattr(self.server, "studio", False) or not hasattr(self.controller, "start_library_action"):
                    raise PermissionError("当前服务不提供动作库播放")
                if self.headers.get("X-Studio-Workspace") != "control":
                    raise PermissionError("请先打开运动控制")
                operation = command.get("operation")
                if operation == "list":
                    result = self.server.action_documents.handle(dict(operation="list"))
                elif operation == "start":
                    document = self.server.action_documents.handle(
                        dict(operation="load", name=command.get("name")))["document"]
                    result = self.controller.start_library_action(self.client, document, command.get("run_id"))
                elif operation in ("status", "stop"):
                    result = self.controller.library_action(self.client, operation, command.get("run_id"))
                else:
                    raise ValueError("未知动作库操作")
                self.send_json(result)
                return
            if path == "/api/workspace" and hasattr(self.controller, "switch"):
                operation = command.get("operation", "switch")
                auxiliary = getattr(self.server, "auxiliary_imu", None)
                client = self.client
                revision = self.head_subscription_revision
                if operation == "switch":
                    rest_before = command.get("rest_before", False)
                    if type(rest_before) is not bool:
                        raise ValueError("工作区休息选项无效")
                    workspace = command.get("workspace")

                    def current_request():
                        return auxiliary is None or auxiliary.current_workspace_request(
                            client, revision, workspace, check_subscription=False)

                    def remember_workspace(previous):
                        if auxiliary is None or not current_request():
                            return
                        if previous is None or previous[0] != workspace:
                            auxiliary.leave_workspace(client, revision)
                        auxiliary.remember_workspace_request(client, revision, workspace)

                    with self.controller.lock:
                        if auxiliary is not None and not auxiliary.current_workspace_request(
                                client, revision, workspace):
                            raise ValueError("页面状态已更新，请重新操作")
                        previous = self.controller.client_workspaces.get(self.client)
                        if not rest_before:
                            result = self.controller.switch(client, workspace)
                            remember_workspace(previous)
                    if rest_before:
                        result = self.controller.switch_after_rest(client, workspace, current_request)
                        with self.controller.lock:
                            if result.get("workspace") == workspace:
                                remember_workspace(previous)
                    self.send_json(result)
                elif operation == "leave":
                    if not client or revision is None or auxiliary is None:
                        raise ValueError("工作区会话无效")
                    with self.controller.lock:
                        if not auxiliary.current_workspace_request(client, revision, "system"):
                            raise ValueError("页面状态已更新，请重新操作")
                        auxiliary.leave_workspace(client, revision)
                        auxiliary.remember_workspace_request(client, revision, "system")
                        result = self.controller.leave_workspace(client)
                    self.send_json(result)
                elif operation == "heartbeat":
                    self.send_json(self.controller.heartbeat(self.client))
                else:
                    raise ValueError("未知工作区操作")
                return
            if getattr(self.controller, "readonly", False):
                from app.robot.robotd_state import READ_ONLY_MESSAGE
                camera_paths = {"/api/camera/prepare", "/api/camera/offer",
                                "/api/camera/keepalive", "/api/camera/close"}
                if path not in camera_paths and not (
                        path == "/api/command" and command.get("action") == "registers"):
                    raise PermissionError(READ_ONLY_MESSAGE)
            if path in ("/api/network/scan", "/api/network/connect", "/api/network/hotspot"):
                if not getattr(self.server, "studio", False) or self.controller.demo:
                    raise PermissionError("当前服务不提供网络操作")
                if self.headers.get("X-Studio-Workspace") != "network":
                    raise PermissionError("请先打开网络管理")
                operation = {"/api/network/scan": lambda: network.scan(),
                             "/api/network/connect": lambda: network.connect(command),
                             "/api/network/hotspot": lambda: network.hotspot()}[path]
                self.send_json(operation())
                return
            studio = hasattr(self.controller, "authorize")
            workspace = self.headers.get("X-Studio-Workspace", "") if studio else None
            maintenance_paths = ("/api/arm", "/api/parameter-batch", "/api/action-playback", "/api/command")
            if studio and path not in maintenance_paths:
                with self.controller.lock:
                    self.controller.authorize(self.client, path, workspace)
                    result, status = self.execute_post(path, command)
            else:
                result, status = self.execute_post(path, command, workspace=workspace)
            self.send_json(result, status)
        except PermissionError as error:
            self.send_post_error(dict(error=str(error)), 403, body)
        except (ValueError, KeyError, TypeError) as error:
            self.send_post_error(dict(error=str(error)), 400, body)
        except queue.Full:
            self.send_post_error(dict(error="操作队列已满"), 429, body)
        except FileExistsError:
            self.send_post_error(dict(error="同名文件已存在，请修改名称"), 409, body)
        except ModelUncertainError as error:
            self.send_post_error(dict(error=str(error), uncertain=True), 503, body)
        except (FutureTimeout, RuntimeError, OSError) as error:
            self.send_post_error(dict(error=str(error) or "操作超时；执行结果未知，请读取确认"), 503, body)

    def execute_post(self, path, command, *, workspace=None):
        scope = {"workspace": workspace} if workspace is not None else {}
        if path == "/api/arm":
            if type(command.get("on")) is not bool:
                raise ValueError("开关无效")
            result = self.controller.arm(self.client, command["on"], **scope)
        elif path == "/api/parameter-batch":
            result = self.controller.parameter_task(command, self.client, **scope)
        elif path == "/api/action-document":
            result = self.server.action_documents.handle(command, self.controller.joints,
                                                          self.controller.full_servo_range)
        elif path == "/api/action-playback":
            result = self.controller.action_task(command, self.client, **scope)
        elif path == "/api/command":
            auxiliary = getattr(self.server, "auxiliary_imu", None)
            def validate_calibration():
                if auxiliary.calibration_snapshot()["active"]:
                    raise ValueError("头部 IMU 正在标定")
            if command.get("action") in ("calibration_start", "calibration_restore") and auxiliary is not None:
                if workspace is not None:
                    scope["validate"] = validate_calibration
                else:
                    validate_calibration()
            result = self.controller.submit(command, self.client, **scope)
        elif path == "/api/head-imu/calibration":
            auxiliary = getattr(self.server, "auxiliary_imu", None)
            if not getattr(self.server, "studio", False) or auxiliary is None:
                raise PermissionError("当前服务不提供头部 IMU 标定")
            if command.get("action") in ("start", "restore") and self.controller.calibration_busy():
                raise ValueError("躯体 IMU 正在标定")
            result = auxiliary.calibration_command(self.client, command)
        elif path == "/api/camera/prepare":
            result = self.camera.prepare()
        elif path == "/api/camera/offer":
            if command.get("type") != "offer":
                raise ValueError("摄像头需要offer会话请求")
            result = self.camera.offer(self.client, command.get("sdp"))
        elif path == "/api/camera/keepalive":
            result = self.camera.touch(self.client, command.get("session"))
        elif path == "/api/camera/close":
            result = self.camera.release(self.client, command.get("session"))
        elif path == "/api/export-targets":
            result = save_targets(self.server.actions_directory, command.get("name"),
                                  command.get("targets"), [joint["id"] for joint in self.controller.joints],
                                  command.get("encoders"), command["imu"], self.controller.full_servo_range)
        elif path == "/api/list-targets":
            result = list_targets(self.server.actions_directory)
        elif path == "/api/load-targets":
            result = load_targets(self.server.actions_directory, command.get("name"),
                                  [joint["id"] for joint in self.controller.joints], self.controller.full_servo_range)
        else:
            return dict(error="不存在的接口"), 404
        return result, 200


def create_controller(args):
    if args.studio:
        from app.robot.hardware import Hardware
        from app.robot.studio import StudioController

        def create_hardware():
            if args.demo:
                return DemoHardware(args.full_servo_range, args.imu_source, args.home_policy)
            return Hardware(args.serial, args.source, args.layout, args.full_servo_range,
                            args.imu_source, home_policy=args.home_policy)

        def create_action_hardware():
            hardware = create_hardware()
            for device_id in (35, 36):
                if device_id not in hardware.ids:
                    try:
                        hardware.execute(dict(action="scan_servo", id=device_id))
                    except (OSError, RuntimeError, ValueError) as error:
                        logging.warning("Action editor could not probe servo %d: %s", device_id, error)
            return hardware

        def factory(workspace):
            hardware_factory = create_action_hardware if workspace == "action" else create_hardware
            return Controller(hardware_factory(), args.hz, demo=args.demo, hardware_factory=hardware_factory,
                              port=args.serial, full_servo_range=args.full_servo_range, maintenance=True,
                              imu_only=workspace == "calibration")

        return StudioController(args.robotd_socket, args.hz, factory, demo=args.demo,
                                status_hardware_factory=create_hardware)
    if args.robotd_socket:
        from app.robot.robotd_state import RobotdController
        return RobotdController(args.robotd_socket, args.hz)
    if args.demo:
        hardware = DemoHardware(args.full_servo_range, args.imu_source, args.home_policy)
    else:
        from app.robot.hardware import Hardware
        hardware = Hardware(args.serial, args.source, args.layout, args.full_servo_range,
                            args.imu_source, home_policy=args.home_policy)
    hardware_factory = (lambda: DemoHardware(args.full_servo_range, args.imu_source, args.home_policy)) if args.demo else (
        lambda: Hardware(args.serial, args.source, args.layout, args.full_servo_range,
                         args.imu_source, home_policy=args.home_policy))
    return Controller(hardware, args.hz, args.demo, hardware_factory=hardware_factory,
                      port=args.serial, full_servo_range=args.full_servo_range)


def create_auxiliary_imu(args):
    if args.studio or args.demo:
        return AuxiliaryImu(args.hz, demo=args.demo)
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--serial", default="/dev/ttyS3")
    parser.add_argument("--source", default=str(Path(__file__).parent / "reference"))
    parser.add_argument("--imu-source", choices=("id200", "i2c", "compare"), default="id200",
                        help="启动时选择 IMU：ID200、I2C5 或双路对比")
    parser.add_argument("--static", default=str(Path(__file__).parent / "web" / "build"))
    parser.add_argument("--hz", type=int, default=20, choices=range(5, 51))
    parser.add_argument("--robotd-socket", help="只读订阅 robotd；Studio 状态页另行采集 I2C3 IMU")
    parser.add_argument("--robot-root", type=robot_root, default=robot_root(),
                        help="机器人运行目录，包含 model-current 和 model-defaults")
    parser.add_argument("--studio", action="store_true", help="通过 robotd 协调运动与维护工作区")
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--full-servo-range", action="store_true",
                        help="舵机总览目标范围统一为 0–4096，覆盖控制台机械限位；不改写舵机内部限位")
    parser.add_argument("--layout", default=str(Path(__file__).parent / "servo-layout.json"))
    parser.add_argument("--home-policy", help="Home 姿态来源 ONNX；默认使用本目录中的姿态配置")
    args = parser.parse_args()
    if args.studio and (not args.robotd_socket or args.full_servo_range):
        parser.error("--studio 需要 --robotd-socket，不能与 --full-servo-range 同用")
    if args.robotd_socket and not args.studio and (args.demo or args.full_servo_range):
        parser.error("--robotd-socket 不能与 --demo 或 --full-servo-range 同用")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    controller = create_controller(args)
    camera = None if args.studio else Camera()
    tof = None if args.studio else TofReader(demo=args.demo)
    auxiliary_imu = create_auxiliary_imu(args)
    secure_transport = None
    try:
        server = ThreadingHTTPServer((args.listen, args.port), Handler)
        server.daemon_threads = True
        server.controller = controller
        server.studio = args.studio
        server.robot_root = args.robot_root
        server.camera = camera
        server.tof = tof
        server.auxiliary_imu = auxiliary_imu
        server.static = Path(args.static).resolve()
        server.actions_directory = Path(__file__).resolve().parent / "actions"
        server.action_documents = ActionDocuments(Path(__file__).resolve().parent / "action-groups")
        server.model_palette = ModelPaletteStore()
        server.network_announcement = NetworkAnnouncementStore()
        server.model_manager = (ModelManager(args.robot_root, controller.observer.query)
                                if args.studio and not args.demo else None)
        server.online_model_updater = (OnlineModelUpdater(server.model_manager, lambda: UpdateControl(args.robotd_socket))
                                       if server.model_manager else None)
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
        if args.studio and not args.demo:
            secure_transport = SecureTransport(args.listen, args.port)
            secure_transport.start()
        logging.info("listen http://%s:%s demo=%s sample_hz=%s", args.listen, args.port, args.demo, args.hz)
        server.serve_forever(poll_interval=.2)
        server.server_close()
    finally:
        if secure_transport is not None:
            secure_transport.close()
        if auxiliary_imu is not None:
            auxiliary_imu.close()
        if camera is not None:
            camera.close()
        if tof is not None:
            tof.close()
        controller.close()


if __name__ == "__main__":
    main()
