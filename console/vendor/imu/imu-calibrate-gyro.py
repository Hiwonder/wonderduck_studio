#!/usr/bin/env python3
"""Guided gyro bias or six-face accelerometer calibration through ID200."""

import argparse
import datetime
import fcntl
import importlib.util
import json
import math
import os
from pathlib import Path
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import time


_SPEC = importlib.util.spec_from_file_location(
    "imu_live", Path(__file__).with_name("imu-live.py")
)
LIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(LIVE)

# Quality gates, not sensor accuracy specifications. The robot must be stationary.
LIMITS = {
    "std_axis_rad_s": 0.02,
    "peak_deviation_axis_rad_s": 0.10,
    "bias_norm_rad_s": LIVE.GYRO_BIAS_MAX_NORM_RAD_S,
    "half_mean_drift_axis_rad_s": 0.002,
    "gravity_deviation_deg": 2.0,
    "validation_residual_axis_rad_s": 0.002,
}

def vector_text(vector):
    return "[" + ", ".join(f"{value:+.6f}" for value in vector) + "]"


def norm(vector):
    return math.sqrt(sum(value * value for value in vector))


def mean_vector(vectors):
    return [statistics.mean(axis) for axis in zip(*vectors)]


def statistics_for(samples):
    """Check raw sensor gyro, so calibration cannot learn a previously corrected residual."""
    if len(samples) < 2:
        raise ValueError("有效样本不足，无法计算零偏。")
    gyros = [sample[0] for sample in samples]
    gravities = [sample[1] for sample in samples]
    if any(not math.isfinite(value) for sample in samples for v in sample for value in v):
        raise ValueError("IMU 数据包含非有限值。")
    if any(not 0.99 <= norm(gravity) <= 1.01 for gravity in gravities):
        raise ValueError("重力向量无效。")
    mean = mean_vector(gyros)
    std = [statistics.stdev(axis) for axis in zip(*gyros)]
    peak = [max(abs(g[i] - mean[i]) for g in gyros) for i in range(3)]
    middle = len(gyros) // 2
    first, last = mean_vector(gyros[:middle]), mean_vector(gyros[middle:])
    gravity_mean = mean_vector(gravities)
    if norm(gravity_mean) < 0.9:
        raise ValueError("采集期间姿态变化过大，请固定传感器后重试。")
    direction = [value / norm(gravity_mean) for value in gravity_mean]
    angles = [
        math.degrees(math.acos(max(-1.0, min(1.0, sum(
            a * b for a, b in zip(direction, g)
        ) / norm(g)))))
        for g in gravities
    ]
    return {
        "samples": len(samples),
        "mean_rad_s": mean,
        "std_rad_s": std,
        "peak_deviation_rad_s": peak,
        "half_mean_drift_rad_s": [last[i] - first[i] for i in range(3)],
        "gravity_mean": gravity_mean,
        "gravity_max_deviation_deg": max(angles),
    }


def require_stationary(stats):
    failures = []
    checks = (
        (max(stats["std_rad_s"]), "std_axis_rad_s", "抖动标准差"),
        (max(stats["peak_deviation_rad_s"]), "peak_deviation_axis_rad_s", "瞬时运动"),
        (max(map(abs, stats["half_mean_drift_rad_s"])),
         "half_mean_drift_axis_rad_s", "前后半段零偏漂移"),
        (stats["gravity_max_deviation_deg"], "gravity_deviation_deg", "传感器姿态变化"),
    )
    for measured, key, label in checks:
        if measured > LIMITS[key]:
            failures.append(f"{label}: {measured:.6f} > {LIMITS[key]:.6f}")
    if failures:
        raise ValueError("静止检查失败：" + "；".join(failures))


def require_bias_range(bias):
    magnitude = norm(bias)
    limit = LIMITS["bias_norm_rad_s"]
    if not math.isfinite(magnitude) or magnitude > limit:
        raise ValueError(
            f"零偏模长 {magnitude:.6f} rad/s 超过可补偿上限 {limit:.2f} rad/s；"
            "请检查是否仍在旋转，以及传感器量程、温漂或硬件状态。"
        )


def validate_bias(bias, stats):
    require_bias_range(bias)
    require_stationary(stats)
    residual = [stats["mean_rad_s"][i] - bias[i] for i in range(3)]
    limit = LIMITS["validation_residual_axis_rad_s"]
    if max(map(abs, residual)) > limit:
        raise ValueError(
            "陀螺仪零偏独立验证未通过：静止检查已通过，"
            f"但扣除固定零偏后均值为 {vector_text(residual)} rad/s，"
            f"单轴限值为 {limit:.6f} rad/s。"
            "若已静止，请保留本次记录，进一步检查零偏随时间或姿态的变化。"
        )
    return residual


class SensorReader:
    """Raw gyro and acceleration remain readable before a bias has been loaded."""

    def __init__(self, fd):
        self.fd = fd
        self.previous_sequence = None
        self.raw_samples = []

    def read(self):
        state = LIVE.read_gyro_bias(self.fd, allow_unloaded_bias=True)
        payload = LIVE.read_blocks(
            self.fd, LIVE.make_read(LIVE.IMU_ID, 68, 48), (LIVE.IMU_ID,),
            block_length=48, timeout_seconds=0.15)[LIVE.IMU_ID]
        schema, model, flags, reserved, sequence, age, *values = struct.unpack("<BBBBII9f", payload)
        if schema != 1 or model != 1 or reserved or flags & ~15 or flags & 10 or age > 100000:
            raise ValueError("原始加速度接口无效、陈旧或标定存储异常")
        if self.previous_sequence is not None:
            delta = (sequence - self.previous_sequence) & 0xffffffff
            if delta == 0 or delta >= 0x80000000:
                raise ValueError("IMU 原始样本未更新或序号回退")
        self.previous_sequence = sequence
        accel = values[3:6]
        length = norm(accel)
        if not all(math.isfinite(v) for v in values) or not 0.85 <= length <= 1.15:
            raise ValueError("校准需要有效静态加速度，模长应为0.85～1.15g")
        gyro = state["raw_sensor_rad_s"]
        self.raw_samples.append({"t_monotonic_s": time.monotonic(), "sequence": sequence,
                                 "age_us": age, "raw_sensor_rad_s": gyro,
                                 "accel_sensor_g": accel, "reported_sensor_rad_s": values[6:9],
                                 "configured_bias": state["bias_sensor_rad_s"]})
        if os.environ.get("CONSOLE_IMU_SAMPLES") == "1":
            streamed = dict(frame="sensor", phase="陀螺仪静置", timestamp_ms=int(time.time() * 1000),
                            sequence=sequence, age_us=age, raw_g=values[:3], corrected_g=accel,
                            gyro_rad_s=values[6:9],
                            raw_gyro_rad_s=state["raw_sensor_rad_s"],
                            corrected_gyro_rad_s=values[6:9],
                            accel_calibrated=bool(flags & 4),
                            gyro_calibrated=bool(state["loaded"] and state["ready"]))
            print("@imu-sample " + json.dumps(streamed, allow_nan=False, separators=(",", ":")), flush=True)
        return gyro, tuple(-v / length for v in accel)


def collect(reader, label, seconds, hz, bias=None, retain=True):
    samples = []
    started = time.monotonic()
    deadline = started + seconds
    next_sample = started
    next_report = started
    count = 0
    while time.monotonic() < deadline:
        time.sleep(max(0.0, next_sample - time.monotonic()))
        if time.monotonic() >= deadline:
            break
        sample = reader.read()
        count += 1
        if retain:
            samples.append(sample)
        now = time.monotonic()
        if now >= next_report:
            corrected = ""
            if bias is not None:
                corrected = " 校正后=" + vector_text([
                    sample[0][i] - bias[i] for i in range(3)
                ])
            print(
                f"{label} 剩余 {max(0.0, deadline - now):5.1f}s | "
                f"gyro={vector_text(sample[0])}{corrected} rad/s",
                flush=True,
            )
            next_report = now + 1.0
        # Never burst requests to catch up after a slow bus transaction.
        next_sample = max(next_sample + 1.0 / hz, now)
    elapsed = time.monotonic() - started
    if count < seconds * hz * 0.9:
        raise ValueError(f"采样率不足：{count / elapsed:.1f} Hz，目标 {hz:.1f} Hz。")
    print(f"{label} 完成：{count} 帧，实际 {count / elapsed:.2f} Hz。", flush=True)
    return samples


def save_report(path, report):
    # Refuse an existing destination instead of replacing a previous calibration.
    payload = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        stream.write(payload)


def validate_report(report, port):
    """Validate the entire archived measurement before writes to file or device."""
    bias = LIVE.validate_gyro_calibration(report, port)
    for key in ("measurement", "verification"):
        if key not in report:
            raise ValueError(f"缺少 {key} 采集统计，拒绝安装。")
        stats = report[key]
        numeric = [stats["samples"], stats["gravity_max_deviation_deg"]]
        for field in ("mean_rad_s", "std_rad_s", "peak_deviation_rad_s",
                      "half_mean_drift_rad_s", "gravity_mean"):
            if len(stats[field]) != 3:
                raise ValueError(f"{key}.{field} 应有三个数值。")
            numeric.extend(stats[field])
        if any(not math.isfinite(value) for value in numeric) or stats["samples"] < 2:
            raise ValueError(f"{key} 包含无效统计。")
        require_stationary(stats)
    if tuple(bias) != struct.unpack("<3f", struct.pack("<3f", *report["measurement"]["mean_rad_s"])):
        raise ValueError("零偏与采集均值不一致，拒绝安装。")
    residual = validate_bias(bias, report["verification"])
    if any(abs(a - b) > 1e-12 for a, b in zip(
            residual, report["verification_corrected_mean_rad_s"])):
        raise ValueError("独立验证残差与采集均值不一致，拒绝安装。")
    return bias


def install_report(report, port, path=LIVE.GYRO_CALIBRATION_PATH, *, backup=True):
    """Keep the measurement archive; atomically select the validated active result."""
    bias = validate_report(report, port)
    active = dict(report)
    active.pop("applied_to_robotd", None)
    active["correction"] = "MCU: gyro_sensor_corrected = gyro_raw_sensor - fixed_bias_sensor"
    payload = json.dumps(active, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if os.geteuid() != 0 and path == LIVE.GYRO_CALIBRATION_PATH:
        command = ["sudo", "-n", sys.executable, str(Path(__file__).resolve()), "--save-active"]
        if not backup:
            command.append("--no-backup")
        result = subprocess.run(command,
                                input=payload, capture_output=True, text=True, check=False)
        if result.returncode:
            raise PermissionError("保存系统陀螺仪标定失败：" + (result.stderr.strip() or "sudo 命令失败"))
        return
    if backup and path.exists():
        previous = path.read_bytes()
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        backup_path = path.with_name(path.name + ".before-" + stamp)
        with backup_path.open("xb") as stream:
            stream.write(previous)
            stream.flush()
            os.fsync(stream.fileno())
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=".imu-gyro-", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(payload)
            stream.flush()
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temporary.exists():
                temporary.unlink()
    print(f"已安装校准：{path}；bias_sensor={vector_text(bias)} rad/s。\n"
          "校准已保存在 MCU，主机文件是备份；启动时不会重新估计。", flush=True)


def apply_and_install(fd, report, port, output):
    """Commit to the MCU first, then save the host measurement backup."""
    validate_report(report, port)
    report["applied_state"] = LIVE.apply_fixed_gyro_bias(fd, report["gyro_bias_rad_s"])
    try:
        save_report(output, report)
        install_report(report, port)
    except (OSError, ValueError, RuntimeError, KeyboardInterrupt) as error:
        raise RuntimeError(f"MCU 已保存陀螺仪校准，但主机备份失败：{error}") from error


def check_bus_available(port):
    if os.environ.get("CONSOLE_MAINTENANCE") != "1":
        service = subprocess.run(["systemctl", "is-active", "--quiet", "robotd.service"], check=False)
        if service.returncode == 0:
            raise ValueError("robotd.service 仍在运行，请停止后再校准。")
    if LIVE.port_is_in_use(port):
        raise ValueError("串口不可独占，请停止 robotd 和其他读取程序后重试。")


def parse_args():
    parser = argparse.ArgumentParser(
        description="IMU 校准：陀螺仪零偏或加速度六面标定，中文交互引导。"
    )
    parser.add_argument("--sensor", choices=("gyro", "accel"), default="gyro",
                        help="gyro 陀螺仪（默认）；accel 加速度六面标定")
    parser.add_argument("--cod", action="store_true",
                        help="gyro：同次静止操作先执行芯片COD，再采集及验证配套零偏")
    parser.add_argument("--check", action="store_true",
                        help="只读检查所选传感器与已安装参数，不重新标定")
    parser.add_argument("--load", action="store_true", help="将主机备份标定恢复到 MCU，不重新采集")
    parser.add_argument("--port", default="/dev/ttyS3", help="串口（默认 /dev/ttyS3）")
    parser.add_argument("--hz", type=float, default=50.0, help="采样频率（默认 50 Hz）")
    parser.add_argument(
        "--warmup",
        type=float,
        default=None,
        help="预热秒数（默认2）",
    )
    parser.add_argument("--samples-seconds", type=float, default=None,
                        help="每次采集秒数，至少5；默认5")
    parser.add_argument("--verify-seconds", type=float, default=None,
                        help="独立验证秒数，至少3；默认3")
    parser.add_argument("--output", type=Path, help="JSON 文件路径，已有文件拒绝覆盖")
    parser.add_argument("--install-existing", type=Path,
                        help="验证并加载已有记录后选择活动文件；需要串口独占")
    parser.add_argument("--no-backup", action="store_true", help="安装已有记录时不保留旧活动文件")
    parser.add_argument("--resume", type=Path,
                        help="加载加速度采集记录，续采缺面；结果另存到新文件")
    parser.add_argument("--face", action="append", choices=("+X", "-X", "+Y", "-Y", "+Z", "-Z"),
                        help="配合 --resume 只重采指定面，可重复；例如 --face=+Z 或 --face=-X")
    args = parser.parse_args()
    if args.no_backup and args.install_existing is None:
        parser.error("--no-backup 仅用于安装已有记录。")
    if args.cod and (args.sensor != "gyro" or args.check or args.load or args.install_existing is not None):
        parser.error("--cod仅用于新的gyro联合标定，不能与检查、加载或安装已有记录同用。")
    if args.warmup is None: args.warmup = 2.0
    if args.samples_seconds is None: args.samples_seconds = 5.0
    if args.verify_seconds is None: args.verify_seconds = 3.0
    if args.load and (args.check or args.install_existing is not None):
        parser.error("--load 不能与 --check 或 --install-existing 同用。")
    numeric = (args.hz, args.warmup, args.samples_seconds, args.verify_seconds)
    if not all(math.isfinite(value) for value in numeric):
        parser.error("时间和频率必须是有限数值。")
    if not 1.0 <= args.hz <= 100.0 or args.warmup < 0:
        parser.error("--hz 必须在 1～100 之间；--warmup 不能为负数。")
    if args.samples_seconds < 5 or args.verify_seconds < 3:
        parser.error("每次采集至少 5 秒，独立验证至少 3 秒。")
    if args.check and args.install_existing is not None:
        parser.error("--check 不能与 --install-existing 同用。")
    if args.sensor == "accel" and args.hz < 5:
        parser.error("加速度标定 --hz 至少 5 Hz。")
    if (args.sensor == "accel" and args.hz * args.verify_seconds < 20
            and not (args.check or args.load or args.install_existing is not None)):
        parser.error("加速度独立验证需要至少 20 帧，请提高采样频率或验证时长。")
    if args.resume is not None:
        if args.sensor != "accel" or args.check or args.load or args.install_existing is not None:
            parser.error("--resume 仅支持加速度采集，不能与 --check、--load 或 --install-existing 同用。")
        args.resume = args.resume.expanduser().resolve()
    if args.face and (args.resume is None or len(set(args.face)) != len(args.face)):
        parser.error("--face 必须配合 --resume 使用，且不能重复指定同一面。")
    if args.output is None:
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        args.output = Path(__file__).resolve().parents[2] / "calibrations" / f"imu-{args.sensor}-{stamp}.json"
    args.output = args.output.expanduser().resolve()
    return args


def run(args):
    if args.cod:
        print("本次联合标定：静止检查 → COD增益校准 → 新增益下零偏采集和独立验证 → 一并保存。", flush=True)
    maintenance = os.environ.get("CONSOLE_MAINTENANCE") == "1"
    bus_instruction = (
        "2. 支撑稳妥后卸力，控制程序已让出串口；避免舵机抖动。\n"
        if maintenance else
        "2. 支撑稳妥后卸力，确保没有其他程序占用舵机串口，避免舵机抖动。\n"
    )
    print(
        "\n=== IMU 陀螺仪零偏校准 ===\n"
        "1. IMU 保持原安装位置。用支架托住躯干，或稳定侧躺；任何固定姿态都可以。\n"
        + bus_instruction +
        "3. 松开双手，不要扶着、触碰、转动机器人，也不要碰桌面或线缆。\n"
        "4. 按回车后自动预热、采集、独立验证；全过程保持静止。\n"
        "   本次操作只访问 ID200 的标定，不设置舵机位置或扭矩；可在页面点击取消。\n"
        "5. 检查通过后加载固定值到 MCU，并保存 /etc/robot/imu-gyro-fixed.json。\n"
        "   MCU融合与回传共用该零偏；后续上电/运行不自动重新估计。\n",
        flush=True,
    )
    print(
        f"串口 {args.port}，{args.hz:g} Hz；预热 {args.warmup:g}s + "
        f"采集 {args.samples_seconds:g}s + 验证 {args.verify_seconds:g}s。\n"
        f"拟保存路径：{args.output}\n"
        f"可补偿零偏模长 ≤{LIMITS['bias_norm_rad_s']:.2f} rad/s；"
        "静止检查：各轴标准差 ≤0.02 rad/s，前后漂移及验证残差 ≤0.002 rad/s，"
        "姿态偏离均值 ≤2°。\n"
        "静止检查不能替代物理固定（例如绕竖直轴匀速旋转也可能误判为零偏）。",
        flush=True,
    )
    if not sys.stdin.isatty():
        raise ValueError("请在交互终端运行，摆放好机器人后按回车开始。")
    input("确认已支撑、卸力并松手，按回车开始：" if maintenance else
          "确认已支撑、卸力、停止 robotd 并松手，按回车开始：")
    if args.output.exists():
        raise FileExistsError(f"结果文件已存在，拒绝覆盖：{args.output}")
    check_bus_available(args.port)
    fd = os.open(args.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    exclusive = False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.ioctl(fd, termios.TIOCEXCL)
        exclusive = True
        LIVE.configure_serial(fd)
        LIVE.read_persistent_calibration(fd)
        LIVE.read_gyro_bias(fd, allow_unloaded_bias=True)  # Check the contract before installation.
        gain_configuration = None
        if args.cod:
            LIVE.GAINS.require_supported(LIVE.GAINS.read_status(LIVE, fd))
            pending = args.output.with_name(args.output.stem + ".cod-pending.json")
            if pending.exists():
                raise FileExistsError(pending)
        else:
            gain_configuration = LIVE.GAINS.current_configuration(LIVE, fd)
        reader = SensorReader(fd)
        if args.warmup:
            collect(reader, "[1/3 预热]", args.warmup, args.hz, retain=False)
        if args.cod:
            require_stationary(statistics_for(collect(reader, "[COD前静止检查]", 5., args.hz)))
            print("正在执行芯片COD，请继续保持静止。", flush=True)
            gain_configuration = LIVE.GAINS.calibrate(LIVE, fd)
            save_report(pending, {"operation": "cod_completed_bias_pending",
                "gyro_gains": gain_configuration, "source": {"port": args.port, "imu_id": LIVE.IMU_ID}})
            print(f"COD成功；结果暂存 {pending}，继续验证零偏后才安装活动文件。", flush=True)
            time.sleep(.25)  # Sensor turn-on after re-enabling CTRL7.
            reader = SensorReader(fd)
            collect(reader, "[COD后稳定]", 5., args.hz, retain=False)
        samples = collect(reader, "[2/3 采集]", args.samples_seconds, args.hz)
        measured = statistics_for(samples)
        print(f"三轴均值：{vector_text(measured['mean_rad_s'])} rad/s", flush=True)
        print(f"三轴标准差：{vector_text(measured['std_rad_s'])} rad/s", flush=True)
        require_stationary(measured)
        bias = list(struct.unpack("<3f", struct.pack("<3f", *measured["mean_rad_s"])))
        require_bias_range(bias)
        print(f"零偏模长：{norm(bias):.6f} rad/s；可补偿上限 "
              f"{LIMITS['bias_norm_rad_s']:.2f} rad/s。", flush=True)
        print("继续保持原姿态静止，使用新的数据验证校正效果。", flush=True)
        verification = statistics_for(collect(
            reader, "[3/3 验证]", args.verify_seconds, args.hz, bias=bias
        ))
        residual = validate_bias(bias, verification)
        LIVE.GAINS.verify_or_restore(LIVE, fd, gain_configuration)
        report = {
            "schema_version": 1,
            "created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "mode": "fixed",
            "frame": "sensor",
            "axes": ["x", "y", "z"],
            "units": "rad/s",
            "gyro_bias_rad_s": bias,
            "gyro_gains": gain_configuration,
            "correction": "MCU: gyro_sensor_corrected = gyro_raw_sensor - fixed_bias_sensor",
            "raw_samples": reader.raw_samples,
            "source": {"port": args.port, "imu_id": LIVE.IMU_ID, "hz": args.hz},
            "warmup_seconds": args.warmup,
            "sampling_seconds": args.samples_seconds,
            "verification_seconds": args.verify_seconds,
            "limits": LIMITS,
            "measurement": measured,
            "verification": verification,
            "verification_corrected_mean_rad_s": residual,
        }
        apply_and_install(fd, report, args.port, args.output)
    finally:
        try:
            if exclusive:
                fcntl.ioctl(fd, termios.TIOCNXCL)
        finally:
            os.close(fd)
    print(
        f"\n校准检查通过。bias_sensor={vector_text(bias)} rad/s\n"
        f"独立验证校正后均值={vector_text(residual)} rad/s\n"
        f"结果已保存：{args.output}",
        flush=True,
    )
    return 0


def load_report_hardware(report, port):
    bias = validate_report(report, port)
    if LIVE.port_is_in_use(port):
        raise ValueError("串口正在使用，请先停止控制程序。")
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        fcntl.ioctl(fd, termios.TIOCEXCL)
        LIVE.configure_serial(fd)
        LIVE.read_persistent_calibration(fd)
        LIVE.GAINS.verify_or_restore(LIVE, fd, report.get("gyro_gains"), restore=True)
        LIVE.apply_fixed_gyro_bias(fd, bias)
    finally:
        fcntl.ioctl(fd, termios.TIOCNXCL)
        os.close(fd)


def check_fixed_calibration(args):
    if args.load:
        bias = LIVE.load_gyro_calibration(args.port)
        if bias is None:
            raise ValueError("缺少主机备份，请先完成一次手动标定。")
        configuration = json.loads(LIVE.GYRO_CALIBRATION_PATH.read_text()).get("gyro_gains")
    if LIVE.port_is_in_use(args.port):
        raise ValueError("串口正在使用，请先停止控制程序。")
    fd = os.open(args.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        fcntl.ioctl(fd, termios.TIOCEXCL)
        LIVE.configure_serial(fd)
        stored = LIVE.read_persistent_calibration(fd)
        if args.load:
            LIVE.GAINS.verify_or_restore(LIVE, fd, configuration, restore=True)
            state = LIVE.apply_fixed_gyro_bias(fd, bias)
            expected = struct.unpack("<3f", struct.pack("<3f", *bias))
        else:
            if stored["flags"] & 8 or not stored["flags"] & 2:
                raise ValueError("MCU 没有可用的永久陀螺仪校准。")
            state = LIVE.read_gyro_bias(fd)
            expected = tuple(state["bias_sensor_rad_s"])
        print("MCU固定零偏状态=" + json.dumps(state, ensure_ascii=False))
        if not state["ready"] or tuple(state["bias_sensor_rad_s"]) != expected:
            raise ValueError("MCU 陀螺仪校准未就绪或与恢复值不一致。")
        if args.load:
            print("已加载并回读同一固定值，没有重新标定。")
            return 0
        reader = SensorReader(fd)
        measured = statistics_for(collect(reader, "只读静止检查", args.verify_seconds, args.hz))
        residual = validate_bias(expected, measured)
        report = {"operation": "check", "state": state, "measurement": measured,
                  "residual_sensor_rad_s": residual, "raw_samples": reader.raw_samples,
                  "hardware_writes": 0}
        save_report(args.output, report)
        print(f"固定零偏残差={vector_text(residual)} rad/s；记录={args.output}")
        return 0
    finally:
        fcntl.ioctl(fd, termios.TIOCNXCL)
        os.close(fd)


def main():
    args = parse_args()
    try:
        if args.sensor == "accel":
            spec = importlib.util.spec_from_file_location(
                "imu_accel_calibration", Path(__file__).with_name("imu_accel_calibration.py")
            )
            accel = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(accel)
            return accel.run(args, LIVE, save_report)
        if args.check or args.load:
            return check_fixed_calibration(args)
        if args.install_existing is not None:
            report = json.loads(args.install_existing.read_text(encoding="utf-8"))
            load_report_hardware(report, args.port)
            install_report(report, args.port, backup=not args.no_backup)
            return 0
        return run(args)
    except (KeyboardInterrupt, EOFError):
        print("\n已取消；若已进入 MCU 写入阶段，参数可能已生效，请检查当前校准状态。"
              if args.sensor == "accel" else
              "\n已取消；若已进入写入阶段，MCU 校准可能已改变，请检查实际状态。", flush=True)
        return 130
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        print(f"\n校准或安装失败：{error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    if sys.argv[1:] in (["--save-active"], ["--save-active", "--no-backup"]):
        if os.geteuid() != 0:
            raise SystemExit("该入口仅供保存系统陀螺仪标定使用。")
        try:
            active = json.load(sys.stdin)
            install_report(active, active["source"]["port"], backup="--no-backup" not in sys.argv[1:])
        except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
            raise SystemExit(f"保存系统陀螺仪标定失败：{error}") from error
    else:
        raise SystemExit(main())
