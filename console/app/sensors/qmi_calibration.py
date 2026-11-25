"""Head IMU calibration using the existing six-face quality checks."""

import datetime
import importlib.util
import json
import math
import os
from pathlib import Path
import tempfile
import time
import uuid

from app.paths import CALIBRATION_DEFAULTS, CONSOLE_ROOT
from app.sensors.qmi_config import ACTIVE_CONFIG, LEGACY_ACTIVE_CONFIG, LEGACY_ASYNC_CONFIG
from vendor.imu import imu_accel_calibration as accel_quality


PROFILE_PATH = CONSOLE_ROOT / "calibrations" / "head-imu.json"
FACES = accel_quality.FACES
WARMUP_SECONDS = 2.0
MEASUREMENT_SECONDS = 5.0
VERIFICATION_SECONDS = 3.0
STALE_SECONDS = 0.5

_gyro_path = CONSOLE_ROOT / "vendor/imu/imu-calibrate-gyro.py"
_gyro_spec = importlib.util.spec_from_file_location("head_gyro_quality", _gyro_path)
if _gyro_spec is None or _gyro_spec.loader is None:
    raise RuntimeError("无法加载陀螺仪标定检查")
gyro_quality = importlib.util.module_from_spec(_gyro_spec)
_gyro_spec.loader.exec_module(gyro_quality)


def empty_profile():
    return dict(schema=1, model="QMI8658", bus="unoq-i2c4" if os.environ.get("WONDERDUCK_UNOQ_ROUTER") else "/dev/i2c-3",
                address=int(os.environ.get("WONDERDUCK_HEAD_IMU_ADDRESS", "0x6a"), 0),
                configuration=ACTIVE_CONFIG.hex(), revision="uncalibrated", accel=None, gyro=None)


def validate_profile(profile):
    expected = empty_profile()
    for key in ("schema", "model", "bus", "address"):
        if profile.get(key) != expected[key]:
            raise ValueError("头部 IMU 标定文件与传感器配置不匹配")
    # Prior profiles store bias in g and rad/s and scale as a unitless factor.
    if profile.get("configuration") not in (
        expected["configuration"], LEGACY_ACTIVE_CONFIG.hex(), LEGACY_ASYNC_CONFIG.hex(),
    ):
        raise ValueError("头部 IMU 标定文件与传感器配置不匹配")
    if not isinstance(profile.get("revision"), str) or not profile["revision"]:
        raise ValueError("头部 IMU 标定文件版本无效")
    if "accel" not in profile or "gyro" not in profile:
        raise ValueError("头部 IMU 标定文件缺少参数")
    accel, gyro = profile.get("accel"), profile.get("gyro")
    if accel is not None:
        if not isinstance(accel, dict):
            raise ValueError("头部 IMU 加速度标定格式无效")
        accel_quality.validate_coefficients(accel["bias_g"], accel["scale"])
    if gyro is not None:
        if not isinstance(gyro, dict) or not isinstance(gyro.get("bias_rad_s"), list) or len(gyro["bias_rad_s"]) != 3:
            raise ValueError("头部 IMU 陀螺仪标定格式无效")
        gyro_quality.require_bias_range(gyro["bias_rad_s"])
    return profile


class ProfileStore:
    def __init__(self, path=PROFILE_PATH):
        self.path = Path(path)

    def load(self):
        try:
            content = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return empty_profile()
        try:
            profile = json.loads(content)
            if not isinstance(profile, dict):
                raise ValueError("标定文件不是对象")
            return validate_profile(profile)
        except (ValueError, TypeError, KeyError) as error:
            raise ValueError(f"头部 IMU 标定文件无效：{error}") from error

    def save(self, profile, *, backup=True):
        validate_profile(profile)
        payload = json.dumps(dict(profile, configuration=ACTIVE_CONFIG.hex()),
                             ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if backup and self.path.exists():
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
            backup_path = self.path.with_name(self.path.name + ".before-" + stamp)
            with backup_path.open("xb") as stream:
                stream.write(self.path.read_bytes())
                stream.flush()
                os.fsync(stream.fileno())
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                         prefix=".head-imu-", delete=False) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(stream.name, self.path)

    def restore_default(self, sensor):
        if sensor not in ("accel", "gyro"):
            raise ValueError("标定类型无效")
        default_path = CALIBRATION_DEFAULTS / "head-imu.json"
        if not default_path.is_file():
            raise ValueError("头部 IMU 默认标定文件未设置")
        default = ProfileStore(default_path).load()
        if default[sensor] is None:
            raise ValueError(f"头部 IMU {'加速度' if sensor == 'accel' else '陀螺仪'}默认标定未设置")
        current = self.load()
        current[sensor] = default[sensor]
        current["revision"] = uuid.uuid4().hex
        self.save(current, backup=False)


def _gyro_statistics(samples):
    vectors = []
    for sample in samples:
        raw = sample["raw_g"]
        length = math.sqrt(sum(value * value for value in raw))
        if not math.isfinite(length) or length == 0:
            raise ValueError("加速度方向无效，无法检查静止姿态")
        vectors.append((sample["gyro_rad_s"], [value / length for value in raw]))
    stats = gyro_quality.statistics_for(vectors)
    gyro_quality.require_stationary(stats)
    return stats


class HeadCalibration:
    """Consume validated samples from the single QMI worker; never open I2C."""

    def __init__(self, hz, store=None, *, warmup_seconds=WARMUP_SECONDS,
                 measurement_seconds=MEASUREMENT_SECONDS, verification_seconds=VERIFICATION_SECONDS):
        self.hz = hz
        self.store = store or ProfileStore()
        self.warmup_seconds = warmup_seconds
        self.measurement_seconds = measurement_seconds
        self.verification_seconds = verification_seconds
        self.warmed_up = False
        self.owner = None
        self.state = dict(active=False, waiting=False, result="idle", message="未开始",
                          session_id="", pending_faces=[], current_face=None, last_face=None)
        self.measurements = {}
        self.verification = {}
        self.samples = []
        self.window_start = None
        self.last_sample_time = None
        self.candidate = None
        self.previous = None
        self.apply_grace_until = None

    def snapshot(self, now=None):
        now = time.monotonic() if now is None else now
        state = dict(self.state)
        state["pending_faces"] = list(state.get("pending_faces", []))
        if self.last_sample_time is not None and state.get("sample") is not None:
            state["sample_age_ms"] = max(0, round((now - self.last_sample_time) * 1000))
            state["sample"] = dict(state["sample"], age_us=state["sample_age_ms"] * 1000)
        return state

    @staticmethod
    def _fresh(latest, now):
        sampled = latest.get("sampled_monotonic")
        return (latest.get("valid") is True and latest.get("status") == "ok" and
                isinstance(sampled, (int, float)) and not isinstance(sampled, bool) and
                math.isfinite(sampled) and 0 <= now - sampled <= STALE_SECONDS and
                isinstance(latest.get("sample"), dict))

    def start(self, client, sensor, latest, now=None):
        now = time.monotonic() if now is None else now
        if self.state["active"]:
            raise ValueError("头部 IMU 标定正在进行")
        if sensor not in ("accel", "gyro"):
            raise ValueError("标定类型无效")
        if not self._fresh(latest, now):
            raise ValueError("头部 IMU 没有新鲜采样")
        self.previous = self.store.load()
        self.owner = client
        self.measurements, self.verification, self.samples = {}, {}, []
        self.warmed_up = False
        self.candidate = None
        self.apply_grace_until = None
        self.window_start = None
        self.last_sample_time = latest["sampled_monotonic"]
        pending = list(FACES) if sensor == "accel" else []
        self.state = dict(active=True, waiting=True, sensor=sensor, result="running",
                          message="摆放并固定后点击继续", pending_faces=pending,
                          faces=" ".join(pending), current_face=None, last_face=None,
                          session_id=uuid.uuid4().hex,
                          sample=latest["sample"])
        return self.snapshot(now)

    def restore_default(self, sensor):
        if self.state["active"]:
            raise ValueError("头部 IMU 标定正在进行")
        self.store.restore_default(sensor)
        self.state = dict(active=False, waiting=False, result="passed", message="已恢复默认",
                          session_id=uuid.uuid4().hex, pending_faces=[], current_face=None, last_face=None)
        return self.snapshot()

    def next(self, client, latest, now=None):
        now = time.monotonic() if now is None else now
        self._require_owner(client)
        if not self.state["waiting"]:
            raise ValueError("当前无需继续，请等待采样结束")
        if not self._fresh(latest, now):
            raise ValueError("头部 IMU 没有新鲜采样")
        self.samples = []
        self.window_start = None
        self.last_sample_time = latest["sampled_monotonic"]
        phase = "measurement" if self.warmed_up else "warmup"
        self.state.update(waiting=False, message="采集中" if self.warmed_up else "预热中",
                          phase=phase, current_face=None)
        self.state.pop("error", None)
        return self.snapshot(now)

    def cancel(self, client, reason="已取消"):
        self._require_owner(client)
        self._finish("cancelled", reason)
        return self.snapshot()

    def _require_owner(self, client):
        if not self.state["active"]:
            raise ValueError("没有进行中的头部 IMU 标定")
        if self.owner != client:
            raise PermissionError("标定由另一浏览器操作")

    def _finish(self, result, message):
        if self.candidate is not None:
            try:
                self.store.save(self.previous)
            except OSError as error:
                self.state.update(active=False, waiting=False, result="failed",
                                  message="恢复先前标定失败", error=str(error))
                self.owner, self.candidate = None, None
                raise RuntimeError(f"恢复先前标定失败：{error}") from error
            self.candidate = None
        self.state.update(active=False, waiting=False, result=result, phase=result, message=message)
        if result == "failed":
            self.state["error"] = message
        self.owner = None
        self.samples = []
        self.apply_grace_until = None

    def lost(self, reason):
        if self.state["active"]:
            self._finish("failed", reason)

    def tick(self, now=None):
        now = time.monotonic() if now is None else now
        if self.state["active"] and self.last_sample_time is not None:
            # Saving the candidate can hold the reader while the worker keeps
            # sampling. Give it one freshness window to drain the old pipe.
            if self.candidate is not None and self.apply_grace_until is not None and now <= self.apply_grace_until:
                return
            if now - self.last_sample_time > STALE_SECONDS:
                self.lost("头部 IMU 采样中断，标定未完成")

    def observe(self, state, observed_at=None):
        if not self.state["active"]:
            return
        observed_at = time.monotonic() if observed_at is None else observed_at
        if not self._fresh(state, observed_at):
            sampled = state.get("sampled_monotonic")
            if (self.candidate is not None and self.apply_grace_until is not None
                    and observed_at <= self.apply_grace_until and state.get("valid") is True
                    and state.get("status") == "ok" and isinstance(state.get("sample"), dict)
                    and isinstance(sampled, (int, float)) and not isinstance(sampled, bool)
                    and math.isfinite(sampled) and observed_at - sampled > STALE_SECONDS):
                return
            self.lost(state.get("error") or "头部 IMU 数据无效或已过期")
            return
        sample, now = state["sample"], state["sampled_monotonic"]
        self.last_sample_time = now
        self.state["sample"] = sample
        if self.candidate is not None:
            if state.get("profile_revision") == self.candidate["revision"]:
                self.candidate = None
                self._finish("passed", "标定完成并生效")
            return
        if self.state["waiting"]:
            return
        if self.window_start is None:
            self.window_start = now
        if self.state["phase"] == "warmup":
            if now - self.window_start >= self.warmup_seconds:
                self.warmed_up = True
                self.state.update(phase="measurement", message="采集中")
                self.samples, self.window_start = [], None
            return
        try:
            self.samples.append(dict(raw_g=sample["raw_g"], gyro_rad_s=sample["raw_gyro_rad_s"]))
            duration = self.measurement_seconds if self.state["phase"] == "measurement" else self.verification_seconds
            if now - self.window_start < duration:
                return
            stats = accel_quality.statistics_for(self.samples)
            if self.state["sensor"] == "accel":
                face = accel_quality.identify_face(stats)
                if self.state["phase"] == "measurement":
                    if face not in self.state["pending_faces"]:
                        raise ValueError(f"{face} 已采集，请摆放其他面")
                    self.state["current_face"] = face
                    self.measurements[face] = stats
                elif face != self.state["current_face"]:
                    raise ValueError("独立验证时姿态发生变化")
                else:
                    self.verification[face] = stats
                    _, failures, _ = accel_quality.inspect_face(face, self.measurements[face], stats)
                    if failures:
                        raise ValueError("；".join(message for _, message in failures))
            else:
                stats = _gyro_statistics(self.samples)
                face = "gyro"
                if self.state["phase"] == "measurement":
                    self.measurements[face] = stats
                else:
                    self.verification[face] = stats
            if self.state["phase"] == "measurement":
                self.state.update(phase="verification", message="独立验证中")
                self.samples, self.window_start = [], None
                return
            if self.state["sensor"] == "accel":
                self.state["last_face"] = face
                self.state["pending_faces"].remove(face)
                self.state["faces"] = " ".join(self.state["pending_faces"])
                if self.state["pending_faces"]:
                    self.state.update(waiting=True, message=f"{face} 已采集，请摆放下一面",
                                      face_check=f"{face} 静止性和朝向检查通过")
                    self.samples, self.window_start = [], None
                    return
                bias, scale = accel_quality.fit(self.measurements)
                accel_quality.validate_faces(self.measurements, self.verification, bias, scale)
                update = dict(accel=dict(bias_g=bias, scale=scale))
            else:
                bias = self.measurements[face]["mean_rad_s"]
                gyro_quality.validate_bias(bias, self.verification[face])
                update = dict(gyro=dict(bias_rad_s=bias))
            profile = dict(self.previous, **update, revision=uuid.uuid4().hex)
            self.store.save(profile)
            self.candidate = profile
            self.apply_grace_until = time.monotonic() + STALE_SECONDS
            self.state.update(phase="applying", message="等待校准参数生效")
        except (ValueError, TypeError, KeyError, OSError) as error:
            if self.candidate is not None:
                self.lost(str(error))
            elif self.state["sensor"] == "accel" and self.state["pending_faces"]:
                face = self.state.get("current_face")
                if face:
                    self.measurements.pop(face, None)
                    self.verification.pop(face, None)
                self.state.update(waiting=True, message=f"本面未接受：{error}", error=str(error),
                                  current_face=None)
                self.samples, self.window_start = [], None
            else:
                self._finish("failed", str(error))
