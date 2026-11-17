"""Run the existing interactive IMU calibration with browser-controlled input."""

import codecs
import datetime
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import threading
import time

from app.paths import CALIBRATION_DEFAULTS
from vendor.imu.imu_accel_calibration import check_active_access, validate_report as validate_accel_report


LOG_TAIL_CHARS = 8192
SAMPLE_PREFIX = "@imu-sample "
PREVIEW_ERROR_PREFIX = "@imu-preview-error "

FACES = ("+X", "-X", "+Y", "-Y", "+Z", "-Z")


class Calibration:
    def __init__(self, script, port, maintenance=False):
        self.script = Path(script).resolve()
        self.directory = self.script.parents[2] / "calibrations"
        self.port = port
        self.maintenance = maintenance
        self.lock = threading.Lock()
        self.process = None
        self.worker = None
        self.master = None
        self.owner = None
        self.sample_at = None
        self.state = dict(active=False, waiting=False, message="未开始", report="", log="", log_tail="")

    def snapshot(self):
        with self.lock:
            state = dict(self.state)
            if "pending_faces" in state:
                state["pending_faces"] = list(state["pending_faces"])
            if self.sample_at is not None:
                state["sample_age_ms"] = round((time.monotonic() - self.sample_at) * 1000)
            return state

    def prepare(self, command, client):
        if self.snapshot()["active"]:
            raise ValueError("标定正在进行")
        sensor = command.get("sensor")
        if sensor not in ("gyro", "accel"):
            raise ValueError("标定类型无效")
        if not self.script.is_file():
            raise ValueError("找不到现有 IMU 标定脚本")
        argv = [sys.executable, "-u", str(self.script), "--port", self.port, "--sensor", sensor]
        restoring = command.get("action") == "calibration_restore"
        if restoring:
            name = {"accel": "imu-accel.json", "gyro": "imu-gyro-fixed.json"}[sensor]
            default = CALIBRATION_DEFAULTS / name
            if not default.is_file():
                raise ValueError(f"躯体 IMU {'加速度' if sensor == 'accel' else '陀螺仪'}默认标定文件未设置")
            report = json.loads(default.read_text(encoding="utf-8"))
            if sensor == "accel":
                validate_accel_report(report, self.port, require_installed=True)
            else:
                spec = importlib.util.spec_from_file_location("gyro_calibration_restore", self.script)
                if spec is None or spec.loader is None:
                    raise RuntimeError("无法加载陀螺仪标定检查")
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                module.validate_report(report, self.port)
            argv += ["--install-existing", str(default), "--no-backup"]
        resume = command.get("resume", "")
        face = command.get("face", "")
        if not isinstance(resume, str) or face not in ("", *FACES):
            raise ValueError("重采参数无效")
        if resume:
            path = Path(resume).resolve()
            if sensor != "accel" or path.parent != self.directory or not path.is_file():
                raise ValueError("请选择 calibrations 目录中的加速度记录")
            argv += ["--resume", str(path)]
            if face:
                argv += ["--face=" + face]
        elif face:
            raise ValueError("重采面需要已有记录")
        check_active_access()
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        self.directory.mkdir(parents=True, exist_ok=True)
        output = self.directory / f"imu-{sensor}-{stamp}.json"
        log = output.with_suffix(".log")
        argv += ["--output", str(output)]
        return argv, output, log, client, sensor, restoring

    def start(self, prepared):
        argv, output, log, client, sensor, restoring = prepared
        master, slave = pty.openpty()
        try:
            environment = dict(os.environ, CONSOLE_IMU_SAMPLES="1")
            if self.maintenance:
                environment["CONSOLE_MAINTENANCE"] = "1"
            process = subprocess.Popen(argv, stdin=slave, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, close_fds=True, env=environment)
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        self.master, self.process, self.owner = master, process, client
        with self.lock:
            self.sample_at = None
            self.state = dict(active=True, waiting=False, sensor=sensor,
                              operation="restore" if restoring else "calibrate", message="启动中",
                              report=str(output), log=str(log), report_exists=False, result="running", log_tail="")
        if restoring and sensor == "accel":
            os.write(master, b"\n")
        self.worker = threading.Thread(target=self._read, args=(output, log),
                                       name="imu-calibration", daemon=True)
        self.worker.start()

    def control(self, action, client):
        with self.lock:
            if not self.state["active"]:
                raise ValueError("没有进行中的标定")
            if client != self.owner:
                raise PermissionError("标定由另一浏览器操作")
            if action == "calibration_next":
                if not self.state["waiting"]:
                    raise ValueError("当前无需继续，请等待采集结束")
                os.write(self.master, b"\n")
                self.state.update(waiting=False, message="处理中")
            else:
                self.process.send_signal(signal.SIGINT)
                self.state.update(waiting=False, message="取消中", cancel_requested=True)
        return self.snapshot()

    def _line(self, line, prompt=False):
        line = line.strip()
        with self.lock:
            if prompt and self.state.get("operation") != "restore":
                self.state.update(waiting=True, message=("放稳并松手，点击继续"
                                  if "摆放" in line else "支撑卸力并固定，点击继续"))
            elif line.startswith("本次待采集："):
                faces = line.split("：", 1)[1].split()
                if any(face not in FACES for face in faces) or len(set(faces)) != len(faces):
                    raise ValueError("校准进程返回了无效的待采面")
                self.state.update(faces=" ".join(faces), pending_faces=faces, current_face=None)
            elif line.startswith("识别 "):
                face = line.split("，", 1)[0][len("识别 "):]
                if face not in FACES:
                    raise ValueError("校准进程返回了无效的当前面")
                self.state["current_face"] = face
            elif "剩余" in line:
                self.state["message"] = line.split("|", 1)[0].strip()
            elif "即时检查" in line or "静止性、朝向" in line:
                self.state["face_check"] = line
            elif "未接受" in line or "失败" in line or "未通过" in line:
                self.state["message"] = line
                self.state["error"] = line
                if "未接受" in line:
                    self.state["current_face"] = None
            elif line.startswith("已保存 "):
                face = line.split("；", 1)[0][len("已保存 "):]
                if face not in FACES:
                    raise ValueError("校准进程返回了无效的已采面")
                pending = self.state.get("pending_faces", [])
                if face in pending:
                    pending.remove(face)
                self.state.update(last_face=face, current_face=None, faces=" ".join(pending))
                self.state["message"] = line.split("；", 1)[0]
            elif "开始写入 MCU" in line:
                self.state["message"] = "写入 MCU 中"

    def _output(self, text, destination, prompt=False):
        if text.startswith(SAMPLE_PREFIX):
            sample = json.loads(text[len(SAMPLE_PREFIX):])
            with self.lock:
                self.state["sample"] = sample
                self.state.pop("sample_error", None)
                self.sample_at = time.monotonic()
            return
        if text.startswith(PREVIEW_ERROR_PREFIX):
            error = json.loads(text[len(PREVIEW_ERROR_PREFIX):])
            with self.lock:
                self.state.pop("sample", None)
                self.state["sample_error"] = error
                self.sample_at = None
            return
        with self.lock:
            self.state["log_tail"] = (self.state["log_tail"] + text)[-LOG_TAIL_CHARS:]
        destination.write(text)
        destination.flush()
        self._line(text, prompt=prompt)

    def _read(self, output, log):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        pending = ""
        try:
            with log.open("w", encoding="utf-8") as destination:
                while True:
                    if not select.select([self.process.stdout], [], [], .2)[0]:
                        continue
                    chunk = os.read(self.process.stdout.fileno(), 8192)
                    if not chunk:
                        break
                    text = decoder.decode(chunk)
                    pending += text
                    while "\n" in pending:
                        line, pending = pending.split("\n", 1)
                        self._output(line + "\n", destination,
                                     prompt="按回车" in line and line.rstrip().endswith("："))
                    if "按回车" in pending and pending.rstrip().endswith("："):
                        self._output(pending, destination, prompt=True)
                        pending = ""
                if pending.strip():
                    self._output(pending, destination)
            code = self.process.wait()
            details = {}
            if output.exists():
                report = json.loads(output.read_text(encoding="utf-8"))
                details = {key: report[key] for key in ("failed_faces", "pending_faces") if key in report}
                incomplete = report.get("status") == "incomplete"
            else:
                incomplete = False
            with self.lock:
                result = "cancelled" if code == 130 or self.state.get("cancel_requested") else "failed" if code else "incomplete" if incomplete else "passed"
                restoring = self.state.get("operation") == "restore"
                message = {"cancelled": "已取消", "failed": "恢复默认失败" if restoring else "标定未通过",
                           "incomplete": "已保存，仍有待采面",
                           "passed": "已恢复默认并生效" if restoring else "标定完成并保存"}[result]
                self.state.update(details, active=False, waiting=False, result=result, message=message,
                                  current_face=None, report_exists=output.exists())
                if result == "passed":
                    self.state.pop("error", None)
        except Exception as error:
            if self.process.poll() is None:
                self.process.send_signal(signal.SIGINT)
                self.process.wait(timeout=5)
            with self.lock:
                self.state.update(active=False, waiting=False, result="failed", message=str(error), error=str(error))
        finally:
            os.close(self.master)
            self.process.stdout.close()

    def close(self):
        if self.snapshot()["active"]:
            self.process.send_signal(signal.SIGINT)
        if self.worker:
            self.worker.join(timeout=5)
        if self.process and self.process.poll() is None:
            raise RuntimeError("标定进程尚未退出，串口不能交回")
