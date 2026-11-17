"""Six-face accelerometer calibration; coefficients are applied before MCU fusion."""

import contextlib
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import select
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import time


ACTIVE_PATH = Path("/etc/robot/imu-accel.json")
FACES = ("+X", "-X", "+Y", "-Y", "+Z", "-Z")
CONFIG = struct.Struct("<HHI6f")
RAW = struct.Struct("<BBBBII9f")
LIMITS = {
    "accel_std_g": 0.01,
    "accel_peak_g": 0.06,
    "accel_drift_g": 0.01,
    "gyro_std_rad_s": 0.02,
    "gyro_peak_rad_s": 0.10,
    "gyro_drift_rad_s": 0.01,
    "bias_abs_g": 0.5,
    "scale_min": 0.5,
    "scale_max": 1.5,
    "residual_g": 0.065,
    "face_window_drift_g": 0.015,
}


class FaceValidationError(ValueError):
    """Keep all failed faces so a retry never defaults to an unrelated face."""

    def __init__(self, failures):
        self.faces = tuple(dict.fromkeys(face for face, _ in failures))
        super().__init__("\n".join(message for _, message in failures)
                         + "\n请准确摆正、固定板子后重采以上未通过面。")


def vector_text(vector):
    return "[" + ", ".join(f"{value:+.4f}" for value in vector) + "]"


def norm(vector):
    return math.sqrt(sum(value * value for value in vector))


def packet(command, params):
    body = bytes((200, len(params) + 2, command)) + bytes(params)
    return b"\xff\xff" + body + bytes((~sum(body) & 255,))


class SensorReader:
    def __init__(self, fd, live):
        self.fd = fd
        self.live = live
        self.previous_sequence = None

    def exchange(self, command, params, length, timeout=0.15):
        # Reuse the existing parser and serial writer; maintenance replies are variable length.
        termios.tcflush(self.fd, termios.TCIFLUSH)
        self.live.write_all(self.fd, packet(command, params))
        parser = self.live.FrameParser()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            readable, _, _ = select.select(
                [self.fd], [], [], max(0.0, deadline - time.monotonic())
            )
            if not readable:
                break
            try:
                data = os.read(self.fd, 4096)
            except BlockingIOError:
                continue
            if not data:
                raise OSError("串口已断开。")
            parser.feed(data)
            while True:
                frame = parser.pop()
                if frame is None:
                    break
                device_id, error, payload = frame
                if device_id != 200:
                    continue
                if error:
                    raise RuntimeError(
                        f"ID200 返回错误 0x{error:02X}；0x08 为不支持/参数无效，"
                        "0x40 为 MCU 写入失败。请确认使用支持永久标定的 QMI 固件。"
                    )
                if len(payload) != length:
                    raise ValueError(f"ID200 响应长度错误：{len(payload)}，预期 {length}。")
                return payload
        raise TimeoutError("ID200 加速度接口超时；检查固件、串口及其他占用程序。")

    def configuration(self):
        return decode_configuration(self.exchange(2, (16, CONFIG.size), CONFIG.size))

    def read(self):
        sample = self.read_raw()
        if not sample["ready"]:
            raise RuntimeError("IMU 融合未就绪；请先加载手动固定陀螺零偏。")
        return sample

    def read_raw(self):
        """Read fresh acceleration even before the manual gyro bias is installed."""
        values = RAW.unpack(self.exchange(2, (68, RAW.size), RAW.size))
        schema, model, flags, reserved, sequence, age = values[:6]
        if schema != 1 or model != 1 or reserved != 0 or flags & ~15:
            raise RuntimeError("加速度接口格式或传感器型号不匹配；当前支持 QMI8658。")
        if flags & 8:
            raise RuntimeError("MCU 加速度标定状态异常，不可作为有效标定采样。")
        if flags & 2 or age > 100000:
            raise RuntimeError(f"IMU 数据过期：flags={flags} age={age} us。")
        if self.previous_sequence is not None:
            delta = (sequence - self.previous_sequence) & 0xFFFFFFFF
            if delta == 0 or delta >= 0x80000000:
                raise RuntimeError("MCU 样本未更新或运行中复位，拒绝使用重复/失序数据。")
        self.previous_sequence = sequence
        if not all(math.isfinite(v) for v in values[6:]):
            raise RuntimeError("加速度或角速度出现非有限值。")
        raw, corrected, gyro = values[6:9], values[9:12], values[12:15]
        gyro_state = self.live.read_gyro_bias(self.fd, allow_unloaded_bias=True)
        if any(abs(value) >= 1.98 for value in raw):
            raise RuntimeError("原始加速度接近 ±2 g 饱和，不能标定。")
        return {"raw_g": raw, "corrected_g": corrected, "gyro_rad_s": gyro,
                "raw_gyro_rad_s": gyro_state["raw_sensor_rad_s"],
                "corrected_gyro_rad_s": gyro,
                "accel_calibrated": bool(flags & 4),
                "gyro_calibrated": bool(gyro_state["loaded"] and gyro_state["ready"]),
                "sequence": sequence, "age_us": age, "calibrated": bool(flags & 4),
                "ready": bool(flags & 1)}

    def install(self, bias, scale, expected):
        validate_coefficients(bias, scale)
        if self.configuration() != expected:
            raise ValueError("MCU 加速度配置已改变，拒绝加载。")
        self.live.read_persistent_calibration(self.fd)
        values = (*bias, *scale)
        # Match the float32 values that the MCU actually uses, not JSON's doubles.
        rounded = struct.unpack("<6f", struct.pack("<6f", *values))
        desired = CONFIG.pack(2, 1, expected["generation"], *rounded)
        written = decode_configuration(self.exchange(3, bytes((16,)) + desired,
                                                     CONFIG.size, timeout=2.0))
        current = self.configuration()
        unchanged = (expected["flags"] == 1 and expected["bias_g"] == list(rounded[:3])
                     and expected["scale"] == list(rounded[3:]))
        generation = expected["generation"] + (0 if unchanged else 1)
        if (written != current or current["flags"] != 1 or
                current["generation"] != generation or
                current["bias_g"] != list(rounded[:3]) or current["scale"] != list(rounded[3:])):
            raise ValueError("MCU 参数回读与写入不一致；请检查当前校准状态。")
        stored = self.live.read_persistent_calibration(self.fd)
        if stored["flags"] & 8 or not stored["flags"] & 1:
            raise ValueError("MCU 未确认永久保存加速度校准。")
        # Let the next samples pass through the new correction.
        time.sleep(0.3)
        for _ in range(10):
            sample = self.read_raw()
            calculated = correct(sample["raw_g"], current["bias_g"], current["scale"])
            if not sample["calibrated"] or max(abs(a - b) for a, b in zip(
                    calculated, sample["corrected_g"])) > 2e-6:
                raise ValueError("MCU 输出没有应用已写入参数，请检查固件。")
            time.sleep(0.02)
        return current


def validate_coefficients(bias, scale):
    if len(bias) != 3 or len(scale) != 3:
        raise ValueError("零偏和比例必须各有三个分量。")
    if not all(math.isfinite(v) for v in (*bias, *scale)):
        raise ValueError("标定参数包含非有限值。")
    if (max(map(abs, bias)) > LIMITS["bias_abs_g"] or
            min(scale) < LIMITS["scale_min"] or max(scale) > LIMITS["scale_max"]):
        raise ValueError("标定参数超出范围：零偏 ≤0.5 g，比例 0.5～1.5。")


def decode_configuration(payload):
    schema, flags, generation, *values = CONFIG.unpack(payload)
    if schema != 2:
        raise ValueError("MCU 加速度标定需要 schema 2 协议；拒绝旧协议。")
    if flags not in (0, 1):
        raise ValueError("MCU 加速度标定状态格式错误。")
    validate_coefficients(values[:3], values[3:])
    if flags != 1 and values != [0., 0., 0., 1., 1., 1.]:
        raise ValueError("未安装标定时 MCU 参数必须为恒等变换。")
    return {"flags": flags, "generation": generation,
            "bias_g": values[:3], "scale": values[3:]}


def correct(raw, bias, scale):
    return [(raw[i] - bias[i]) * scale[i] for i in range(3)]


def statistics_for(samples):
    if len(samples) < 20:
        raise ValueError("有效样本不足 20 帧。")
    result = {"samples": len(samples)}
    for field, prefix in (("raw_g", "accel"), ("gyro_rad_s", "gyro")):
        vectors = [sample[field] for sample in samples]
        if any(len(v) != 3 or not all(math.isfinite(x) for x in v) for v in vectors):
            raise ValueError("采集数据包含无效/非有限值。")
        means = [statistics.mean(axis) for axis in zip(*vectors)]
        middle = len(vectors) // 2
        result[prefix + "_mean"] = means
        result[prefix + "_std"] = [statistics.stdev(axis) for axis in zip(*vectors)]
        result[prefix + "_peak"] = [max(abs(v[i] - means[i]) for v in vectors)
                                    for i in range(3)]
        result[prefix + "_drift"] = [
            statistics.mean(v[i] for v in vectors[middle:]) -
            statistics.mean(v[i] for v in vectors[:middle]) for i in range(3)
        ]
    require_stationary(result)
    return result


def require_stationary(stats):
    if not isinstance(stats["samples"], int) or stats["samples"] < 20:
        raise ValueError("统计样本数无效。")
    for prefix, unit in (("accel", "g"), ("gyro", "rad_s")):
        for field in ("mean", "std", "peak", "drift"):
            vector = stats[prefix + "_" + field]
            if len(vector) != 3 or not all(math.isfinite(v) for v in vector):
                raise ValueError("统计数据格式无效。")
            if field == "mean":
                continue
            if field != "drift" and min(vector) < 0:
                raise ValueError("标准差和峰值不得为负数。")
            if max(map(abs, vector)) > LIMITS[prefix + "_" + field + "_" + unit]:
                raise ValueError(f"静止检查失败：{prefix}_{field}={vector_text(vector)}。")
    # Gyro bias is allowed while measuring acceleration. Check within-window
    # motion here; physical support is essential (constant yaw is ambiguous).
    if norm(stats["gyro_mean"]) > 0.5:
        raise ValueError("角速度均值超过 0.5 rad/s，请排除旋转或传感器异常。")
    if any(abs(x) >= 1.98 for x in stats["accel_mean"]):
        raise ValueError("加速度饱和，拒绝标定。")


def identify_face(stats):
    values = stats["accel_mean"]
    axis = max(range(3), key=lambda i: abs(values[i]))
    others = [abs(values[i]) for i in range(3) if i != axis]
    if abs(values[axis]) < 0.45 or abs(values[axis]) - max(others) < 0.3:
        raise ValueError("未接近轴向姿态，请将板子水平或垂直放稳。")
    return ("+" if values[axis] > 0 else "-") + "XYZ"[axis]


def fit(measurements):
    if set(measurements) != set(FACES):
        raise ValueError("必须具备 X/Y/Z 三轴正反六面，不能重复或缺面。")
    bias, scale = [], []
    for axis, name in enumerate("XYZ"):
        positive = measurements["+" + name]["accel_mean"][axis]
        negative = measurements["-" + name]["accel_mean"][axis]
        if positive - negative < 1.0:
            raise ValueError("正反面差值不足，请检查摆放或传感器。")
        bias.append((positive + negative) / 2)
        scale.append(2 / (positive - negative))
    validate_coefficients(bias, scale)
    return bias, scale


def inspect_face(face, measurement, verification, bias=None, scale=None, *, residual_limit_g=None):
    """Use the same face checks for immediate feedback and the final gate."""
    if residual_limit_g is None:
        residual_limit_g = LIMITS["residual_g"]
    target = [0., 0., 0.]
    target["XYZ".index(face[1])] = 1. if face[0] == "+" else -1.
    residuals, failures = {}, []
    for label, stats in (("采集", measurement), ("独立验证", verification)):
        require_stationary(stats)
        if identify_face(stats) != face:
            raise ValueError(f"{face} {label} 的朝向与标签不一致。")
        if bias is not None:
            corrected = correct(stats["accel_mean"], bias, scale)
            residual = norm([corrected[i] - target[i] for i in range(3)])
            residuals[label] = residual
            if residual > residual_limit_g:
                failures.append((face, f"{face} {label}残差 {residual:.4f} g > "
                                 f"{residual_limit_g:.3f} g；校正={vector_text(corrected)} g"))
    drift = max(abs(a - b) for a, b in zip(measurement["accel_mean"],
                                           verification["accel_mean"]))
    if drift > LIMITS["face_window_drift_g"]:
        failures.append((face, f"{face} 两个窗口间漂移 {drift:.4f} g 过大。"))
    return residuals, failures, drift


def print_face_feedback(report, attempt, face):
    bias = scale = None
    complete = set(report["measurement"]) == set(FACES)
    if complete:
        try:
            bias, scale = fit(report["measurement"])
        except ValueError as error:
            attempt["face_check"] = {"status": "fit_failed", "error": str(error)}
            print(f"{face} 即时检查：六面拟合未通过：{error}；数据已保留。", flush=True)
            return
    residuals, failures, drift = inspect_face(
        face, report["measurement"][face], report["verification"][face], bias, scale)
    attempt["face_check"] = {"status": "failed" if failures else
                             ("provisional_pass" if complete else "partial_pass"),
                             "residual_g": residuals, "window_drift_g": drift,
                             "failures": [message for _, message in failures]}
    if failures:
        print(f"{face} 即时检查未通过：" + "；".join(message for _, message in failures)
              + "；数据已保留，可在校准页面选择该面重采。", flush=True)
    elif complete:
        print(f"{face} 即时检查暂通过：采集残差={residuals['采集']:.4f} g，"
              f"验证残差={residuals['独立验证']:.4f} g，限值={LIMITS['residual_g']:.3f} g。",
              flush=True)
    else:
        print(f"{face} 静止性、朝向及窗口漂移通过；尚缺六面数据，"
              "校正残差待六面齐全后判断。", flush=True)
    if complete:
        print("残差基于当前六面拟合，其他面重采后可能改变；最终仍检查全部六面。", flush=True)


def validate_faces(measurements, verification, bias, scale, *, residual_limit_g=None):
    if set(measurements) != set(FACES) or set(verification) != set(FACES):
        raise ValueError("六面数据不完整。")
    residuals, failures = {}, []
    for face in FACES:
        checked, face_failures, _ = inspect_face(
            face, measurements[face], verification[face], bias, scale,
            residual_limit_g=residual_limit_g)
        residuals[face] = checked["独立验证"]
        failures.extend(face_failures)
    if failures:
        raise FaceValidationError(failures)
    return residuals


def collect(reader, seconds, hz, label, retain=True, samples=None):
    if samples is None:
        samples = []
    start = next_sample = next_report = next_stream = time.monotonic()
    end = start + seconds
    count = 0
    while time.monotonic() < end:
        time.sleep(max(0., next_sample - time.monotonic()))
        if time.monotonic() >= end:
            break
        sample = reader.read()
        count += 1
        if retain:
            samples.append(sample)
        now = time.monotonic()
        if os.environ.get("CONSOLE_IMU_SAMPLES") == "1" and now >= next_stream:
            streamed = dict(sample, phase=label, frame="sensor", timestamp_ms=int(time.time() * 1000))
            print("@imu-sample " + json.dumps(streamed, allow_nan=False, separators=(",", ":")), flush=True)
            next_stream = now + .2
        if now >= next_report:
            print(f"{label} 剩余 {max(0., end-now):5.1f}s | "
                  f"原始={vector_text(sample['raw_g'])} g | "
                  f"模长={norm(sample['raw_g']):.4f} g", flush=True)
            next_report = now + 1.
        next_sample = max(next_sample + 1. / hz, now)
    if count < seconds * hz * 0.9:
        raise ValueError("有效采样率低于目标的 90%，本次采集无效。")
    return samples


def wait_for_placement(reader, hz):
    prompt = "摆放其中一面、松手，按回车开始（随后保持静止）："
    if os.environ.get("CONSOLE_IMU_SAMPLES") != "1":
        input(prompt)
        return
    print(prompt, flush=True)
    last_read = None
    while True:
        if select.select([sys.stdin], [], [], .2)[0]:
            if not sys.stdin.readline():
                raise EOFError("校准输入已关闭")
            if last_read is not None:
                time.sleep(max(0., last_read + 1. / hz - time.monotonic()))
            return
        try:
            sample = reader.read_raw()
            streamed = dict(sample, phase="摆放", frame="sensor", timestamp_ms=int(time.time() * 1000))
            print("@imu-sample " + json.dumps(streamed, allow_nan=False, separators=(",", ":")), flush=True)
        except (OSError, RuntimeError, ValueError) as error:
            print("@imu-preview-error " + json.dumps(str(error), ensure_ascii=False), flush=True)
        finally:
            last_read = time.monotonic()


@contextlib.contextmanager
def open_reader(port, live):
    if os.environ.get("CONSOLE_MAINTENANCE") != "1":
        service = subprocess.run(["systemctl", "is-active", "--quiet", "robotd.service"],
                                 check=False)
        if service.returncode == 0:
            raise ValueError("请停止 robotd 和其他串口程序后再标定。")
    if live.port_is_in_use(port):
        raise ValueError("请停止 robotd 和其他串口程序后再标定。")
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.ioctl(fd, termios.TIOCEXCL)
        live.configure_serial(fd)
        yield SensorReader(fd, live)
    finally:
        os.close(fd)


def validate_identity(report, port):
    if (report["schema_version"] != 1 or report["sensor"] != "accel" or
            report["model"] != "QMI8658" or report["frame"] != "sensor" or
            report["units"] != "g" or report["source"]["port"] != port or
            report["source"]["imu_id"] != 200):
        raise ValueError("记录的型号、单位、坐标系或串口不匹配。")


def recorded_residual_limit(report):
    if "limits" not in report:
        return LIMITS["residual_g"]
    limits = report["limits"]
    if not isinstance(limits, dict) or "residual_g" not in limits:
        raise ValueError("记录的加速度残差限值无效。")
    limit = limits["residual_g"]
    if isinstance(limit, bool) or not isinstance(limit, (int, float)) or not math.isfinite(limit) or limit < 0:
        raise ValueError("记录的加速度残差限值无效。")
    accepted = report.get("accepted_residual_limit_g")
    if "accepted_residual_limit_g" in report and (
            isinstance(accepted, bool) or not isinstance(accepted, (int, float))
            or not math.isfinite(accepted) or accepted != limit):
        raise ValueError("记录的已接受残差与限值不一致。")
    if limit > LIMITS["residual_g"] and accepted is None:
        raise ValueError("记录的残差限值高于当前标准，但没有明确接受记录。")
    return limit


def validate_report(report, port, *, require_installed=False):
    validate_identity(report, port)
    if report.get("pending_faces"):
        raise ValueError("记录还有待采集/重采的面，不能安装。")
    bias, scale = fit(report["measurement"])
    if bias != report["bias_g"] or scale != report["scale"]:
        raise ValueError("记录参数与六面采样不一致。")
    installed = report.get("installed_configuration")
    if installed is None:
        if require_installed or "installed_configuration" in report:
            raise ValueError("活动记录缺少已安装的加速度参数。")
    else:
        rounded = struct.unpack("<6f", struct.pack("<6f", *bias, *scale))
        if (not isinstance(installed, dict) or type(installed.get("flags")) is not int
                or installed["flags"] != 1
                or installed.get("bias_g") != list(rounded[:3])
                or installed.get("scale") != list(rounded[3:])):
            raise ValueError("记录的已安装参数与六面拟合不一致。")
    residuals = validate_faces(report["measurement"], report["verification"], bias, scale,
                               residual_limit_g=recorded_residual_limit(report))
    if "verification_residual_g" in report:
        recorded = report["verification_residual_g"]
        if (not isinstance(recorded, dict) or set(recorded) != set(FACES)
                or any(isinstance(recorded[face], bool)
                       or not isinstance(recorded[face], (int, float))
                       or not math.isfinite(recorded[face])
                       or abs(recorded[face] - residuals[face]) > 1e-12 for face in FACES)):
            raise ValueError("记录的独立验证残差与六面采样不一致。")
    return bias, scale


def check_active_access(path=ACTIVE_PATH):
    if os.access(path.parent, os.W_OK):
        return
    try:
        result = subprocess.run(["sudo", "-n", "true"], capture_output=True, text=True, check=False)
    except OSError as error:
        raise PermissionError("无法写入系统标定目录，也无法调用 sudo。") from error
    if result.returncode:
        raise PermissionError("无法写入系统标定目录；需要免交互 sudo 或以 root 启动控制台。")


def save_active(report, installed, path=ACTIVE_PATH, *, backup=True):
    active = dict(report, installed_configuration=installed)
    if not os.access(path.parent, os.W_OK):
        if path != ACTIVE_PATH:
            raise PermissionError(f"无法写入标定目录：{path.parent}")
        command = ["sudo", "-n", sys.executable, str(Path(__file__).resolve()), "--save-active"]
        if not backup:
            command.append("--no-backup")
        result = subprocess.run(command,
                                input=json.dumps(active, allow_nan=False), capture_output=True, text=True, check=False)
        if result.returncode:
            raise PermissionError("保存系统标定失败：" + (result.stderr.strip() or "sudo 命令失败"))
        return
    if backup and path.exists():
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        backup_path = path.with_name(path.name + ".before-" + stamp)
        with backup_path.open("xb") as stream:
            stream.write(path.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
    save_progress(path, active)


def save_progress(path, report):
    """Persist a complete window, partial interrupted window, or validation result atomically."""
    payload = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=".imu-accel-", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(payload)
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()


def prepare_session(args):
    if args.resume is None:
        report = {
            "schema_version": 1, "sensor": "accel", "model": "QMI8658",
            "frame": "sensor", "units": "g",
            "source": {"port": args.port, "imu_id": 200},
            "measurement": {}, "verification": {}, "attempts": [],
            "pending_faces": list(FACES),
            "correction": "corrected_g = (raw_g - bias_g) * scale",
        }
    else:
        report = json.loads(args.resume.read_text(encoding="utf-8"))
        validate_identity(report, args.port)
        measured, verified = report["measurement"], report["verification"]
        pending = report["pending_faces"]
        if (not isinstance(measured, dict) or not isinstance(verified, dict)
                or not isinstance(pending, list) or not isinstance(report["attempts"], list)
                or set(measured) != set(verified) or not set(measured) <= set(FACES)
                or len(set(pending)) != len(pending) or not set(pending) <= set(FACES)
                or not set(FACES) - set(measured) <= set(pending)):
            raise ValueError("采集记录的六面或进度字段无效。")
        for face in measured:
            for stats in (measured[face], verified[face]):
                require_stationary(stats)
                if identify_face(stats) != face:
                    raise ValueError(f"记录中 {face} 的朝向与标签不一致。")
        report["resumed_from"] = str(args.resume)
        # Recompute every coefficient after replacing a face; never carry an old fit forward.
        for key in ("bias_g", "scale", "verification_residual_g", "installed_configuration",
                    "accepted_existing_record", "accepted_existing_sha256",
                    "accepted_residual_limit_g", "error", "failure_stage", "failed_faces"):
            report.pop(key, None)
    for face in args.face or []:
        if face not in report["pending_faces"]:
            report["pending_faces"].append(face)
    report.update(
        created_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        status="collecting", warmup_seconds=args.warmup,
        sampling_seconds=args.samples_seconds, verification_seconds=args.verify_seconds,
        limits=dict(LIMITS),
    )
    report["source"]["hz"] = args.hz
    return report


def capture_window(reader, args, report, attempt, key, seconds, label):
    window = {"samples": [], "seconds": seconds, "hz": args.hz, "status": "collecting"}
    attempt[key] = window
    try:
        collect(reader, seconds, args.hz, label, samples=window["samples"])
        window["statistics"] = statistics_for(window["samples"])
        window["status"] = "complete"
        return window["statistics"]
    except (OSError, ValueError, RuntimeError, KeyboardInterrupt, EOFError) as error:
        window.update(status="failed", error=str(error) or type(error).__name__)
        raise
    finally:
        save_progress(args.output, report)


def capture_faces(reader, args, report):
    remaining = list(args.face or report["pending_faces"])
    if remaining and args.warmup:
        collect(reader, args.warmup, args.hz, "预热", retain=False)
    while remaining:
        print("\n本次待采集：" + " ".join(remaining), flush=True)
        wait_for_placement(reader, args.hz)
        collect(reader, 2., args.hz, "等待稳定", retain=False)
        attempt = {"created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   "accepted": False}
        report["attempts"].append(attempt)
        try:
            stats = capture_window(reader, args, report, attempt, "measurement",
                                   args.samples_seconds, "采集")
            face = identify_face(stats)
            attempt["face"] = face
            if face not in remaining:
                raise ValueError(f"识别到 {face}；请摆放本次待采集的面。")
            print(f"识别 {face}，请继续保持静止。", flush=True)
            check = capture_window(reader, args, report, attempt, "verification",
                                   args.verify_seconds, "独立验证")
            if identify_face(check) != face:
                raise ValueError("验证时姿态发生变化。")
        except ValueError as error:
            attempt["error"] = str(error)
            save_progress(args.output, report)
            print(f"本面未接受，数据已保存：{error} 请重新摆放。", flush=True)
            continue
        report["measurement"][face], report["verification"][face] = stats, check
        report["pending_faces"].remove(face)
        remaining.remove(face)
        attempt["accepted"] = True
        print_face_feedback(report, attempt, face)
        save_progress(args.output, report)
        print(f"已保存 {face}；记录：{args.output}", flush=True)


def run(args, live, save_report):
    if args.check:
        with open_reader(args.port, live) as reader:
            print("MCU 参数：" + json.dumps(reader.configuration(), ensure_ascii=False), flush=True)
            for _ in range(5):
                sample = reader.read_raw()
                print(f"seq={sample['sequence']:10d} age={sample['age_us']/1000:5.2f} ms | "
                      f"融合就绪={'是' if sample['ready'] else '否'} | "
                      f"已校正={'是' if sample['calibrated'] else '否'} | "
                      f"原始={vector_text(sample['raw_g'])} | "
                      f"校正={vector_text(sample['corrected_g'])} g | "
                      f"模长={norm(sample['corrected_g']):.4f} g", flush=True)
                time.sleep(.05)
        return 0
    if args.load:
        report = json.loads(ACTIVE_PATH.read_text(encoding="utf-8"))
        bias, scale = validate_report(report, args.port, require_installed=True)
        print(f"活动记录验收残差限值={recorded_residual_limit(report):.3f} g。", flush=True)
        with open_reader(args.port, live) as reader:
            before = reader.configuration()
            installed = reader.install(bias, scale, before)
        print(f"已保存并验证 MCU 加速度参数，代际={installed['generation']}；"
              "未重新标定或修改主机活动文件。", flush=True)
        return 0
    check_active_access()
    if not sys.stdin.isatty():
        raise ValueError("请在校准页面重新启动六面标定。")
    recording = args.install_existing is None
    if recording:
        if args.output.exists():
            raise FileExistsError(f"结果文件已存在：{args.output}")
        report = prepare_session(args)
        print("\n=== 加速度六面标定 ===\n"
              "先卸力并支撑稳妥，停止 robotd 及其他串口程序。\n"
              "依次把板子平放、翻面以及四边朝上，准确水平/垂直固定。\n"
              "每次放稳松手后按回车；程序自动识别 +X/-X/+Y/-Y/+Z/-Z。\n"
              "按 IMU 自身坐标轴：正面为该轴正方向朝上，负面为该轴正方向朝下。\n"
              "每面先采集，再用新数据验证；全过程不得手持、旋转或晃动。\n"
              "静止检查无法排除匀速绕竖直轴旋转，请使用稳固支撑。\n"
              "每个窗口的数据立即保存；六面全通过后写入 MCU 并保存主机备份。\n"
              "本程序不设置舵机位置或扭矩。Ctrl+C 取消并保存已采数据。", flush=True)
        if args.resume is not None:
            print(f"续采记录：{args.resume}；请确认仍是同一块 IMU。", flush=True)
        print(f"本次记录：{args.output}", flush=True)
        print("本次待采集：" + " ".join(args.face or report["pending_faces"]), flush=True)
    else:
        report = json.loads(args.install_existing.read_text(encoding="utf-8"))
        validate_report(report, args.port)
        print(f"记录验收残差限值={recorded_residual_limit(report):.3f} g。", flush=True)
        print("将把该记录写入当前 MCU，请确认板子是生成这份记录的同一块。", flush=True)
    input("确认已停止其他程序并支撑、卸力，按回车继续：")
    with open_reader(args.port, live) as reader:
        before = reader.configuration()
        if recording:
            report["previous_configuration"] = before
            save_report(args.output, report)
        try:
            if recording:
                capture_faces(reader, args, report)
                if report["pending_faces"]:
                    report["status"] = "incomplete"
                    save_progress(args.output, report)
                    print("本次采集已保存，尚需采集/重采：" + " ".join(report["pending_faces"])
                          + f"；尚未写入 MCU。记录：{args.output}", flush=True)
                    return 0
                report["status"] = "validating"
                bias, scale = fit(report["measurement"])
                report.update(bias_g=bias, scale=scale)
                report["verification_residual_g"] = validate_faces(
                    report["measurement"], report["verification"], bias, scale)
                report["status"] = "validated"
                save_progress(args.output, report)
                print(f"六面检查通过，记录已保存：{args.output}", flush=True)
            bias, scale = validate_report(report, args.port)
            print(f"零偏={vector_text(bias)} g；比例={vector_text(scale)}", flush=True)
            if recording:
                report["status"] = "installing"
                save_progress(args.output, report)
            print("开始写入 MCU；若中断，请重新打开校准页面检查当前状态。", flush=True)
            installed = reader.install(bias, scale, before)
            if recording:
                report.update(status="installed", installed_configuration=installed)
                save_progress(args.output, report)
            save_active(report, installed, backup=not args.no_backup)
            print(f"已永久写入 MCU 并验证新采样应用参数，代际={installed['generation']}；"
                  f"主机备份：{ACTIVE_PATH}。", flush=True)
        except (OSError, ValueError, RuntimeError, KeyboardInterrupt, EOFError) as error:
            if recording:
                stage = report["status"]
                status = "validation_failed" if stage == "validating" else "failed"
                if isinstance(error, (KeyboardInterrupt, EOFError)):
                    status = "interrupted"
                report.update(status=status, failure_stage=stage,
                              error=str(error) or type(error).__name__)
                if isinstance(error, FaceValidationError):
                    report["failed_faces"] = list(error.faces)
                save_progress(args.output, report)
                if isinstance(error, FaceValidationError):
                    print("未通过面：" + " ".join(error.faces), flush=True)
                print(f"采集记录已保存：{args.output}\n"
                      "请在校准页面选择记录后继续采集或重采。", flush=True)
            raise
    return 0


if __name__ == "__main__":
    if sys.argv[1:] not in (["--save-active"], ["--save-active", "--no-backup"]) or os.geteuid() != 0:
        raise SystemExit("该入口仅供保存系统加速度标定使用。")
    active = json.load(sys.stdin)
    validate_report(active, active["source"]["port"], require_installed=True)
    save_active(active, active["installed_configuration"], backup="--no-backup" not in sys.argv[1:])
