#!/usr/bin/env python3
"""HX serial and MCU calibration transport."""

import json
import math
import os
from pathlib import Path
import select
import struct
import subprocess
import termios
import time
import importlib.util


PORT_DEFAULT = "/dev/ttyS3"
IMU_ID = 200
JOINT_IDS = (20, 21, 22, 23, 24, 30, 31, 32, 33, 34, 10, 11, 12, 13, 14)
ALL_DEVICE_IDS = (IMU_ID, *JOINT_IDS)
READ_ADDRESS = 56
READ_LENGTH = 12
READ_TIMEOUT_SECONDS = 0.040
FAULT_ADDRESS = 208
FAULT_LENGTH = 52
FAULT_TIMEOUT_SECONDS = 0.005
GYRO_RAD_PER_LSB = 0.035 * math.pi / 180.0
# Facing the robot, the HX sensor is physically +X left, +Y up, +Z forward.
# This is the same sensor-to-trunk rotation as duck-control/src/hx.rs:
# trunk = [sensor_z, sensor_x, sensor_y].
HX_MOUNT = (0.5, 0.5, 0.5, 0.5)
GYRO_CALIBRATION_PATH = Path("/etc/robot/imu-gyro-fixed.json")
# Compensation bound, not a stationary test or sensor accuracy specification.
# Keep in sync with robotd/src/imu_calibration.rs.
GYRO_BIAS_MAX_NORM_RAD_S = struct.unpack("<f", struct.pack("<f", 0.30))[0]
_GAINS_SPEC = importlib.util.spec_from_file_location("imu_gyro_gains", Path(__file__).with_name("imu_gyro_gains.py"))
GAINS = importlib.util.module_from_spec(_GAINS_SPEC)
_GAINS_SPEC.loader.exec_module(GAINS)


def validate_gyro_calibration(report, port, imu_id=IMU_ID):
    """Validate the same saved calibration contract as robotd before using it."""
    if not isinstance(report, dict) or not isinstance(report.get("source"), dict):
        raise ValueError("陀螺仪校准文件缺少 source。")
    if (report.get("schema_version") != 1
            or report.get("frame") != "sensor"
            or report.get("mode") != "fixed"
            or report.get("units") != "rad/s"
            or report["source"].get("imu_id") != imu_id
            or report["source"].get("port") != port
            or not isinstance(report.get("created_utc"), str)
            or not report["created_utc"]):
        raise ValueError("陀螺仪校准的格式、坐标系、安装方向或数据来源与当前 HX 不一致。")
    for key in ("gyro_bias_rad_s", "verification_corrected_mean_rad_s"):
        vector = report.get(key)
        if (not isinstance(vector, list) or len(vector) != 3
                or any(type(value) not in (int, float) or not math.isfinite(value)
                       for value in vector)):
            raise ValueError(f"陀螺仪校准字段 {key} 必须包含三个有限数值。")
    bias = report["gyro_bias_rad_s"]
    if math.sqrt(sum(value * value for value in bias)) > GYRO_BIAS_MAX_NORM_RAD_S:
        raise ValueError(f"陀螺仪零偏模长超过可补偿上限 {GYRO_BIAS_MAX_NORM_RAD_S:.2f} rad/s。")
    if max(map(abs, report["verification_corrected_mean_rad_s"])) > 0.002:
        raise ValueError("陀螺仪独立验证残差超过允许范围。")
    GAINS.validate_configuration(report.get("gyro_gains"))
    return tuple(bias)


def load_gyro_calibration(port, path=GYRO_CALIBRATION_PATH, imu_id=IMU_ID):
    try:
        payload = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    return validate_gyro_calibration(json.loads(payload), port, imu_id)


class FrameParser:
    """Incrementally extracts valid HX status frames from a byte stream."""

    def __init__(self):
        self.buffer = bytearray()
        self.checksum_errors = 0
        self.invalid_lengths = 0

    def feed(self, data):
        self.buffer.extend(data)

    def pop(self):
        while True:
            if len(self.buffer) < 4:
                return None
            start = self.buffer.find(b"\xff\xff")
            if start < 0:
                if self.buffer[-1:] == b"\xff":
                    self.buffer[:] = b"\xff"
                else:
                    self.buffer.clear()
                return None
            if start:
                del self.buffer[:start]
            length = self.buffer[3]
            if length < 2:
                self.invalid_lengths += 1
                del self.buffer[0]
                continue
            total = length + 4
            if len(self.buffer) < total:
                return None
            frame = bytes(self.buffer[:total])
            del self.buffer[:total]
            if sum(frame[2:]) & 0xFF != 0xFF:
                self.checksum_errors += 1
                continue
            return frame[2], frame[4], frame[5:-1]


def make_sync_read(ids):
    params = (READ_ADDRESS, READ_LENGTH, *ids)
    body = (0xFE, len(params) + 2, 0x82, *params)
    return bytes((0xFF, 0xFF, *body, (~sum(body)) & 0xFF))


def make_read(device_id, address, length):
    params = (address, length)
    body = (device_id, len(params) + 2, 0x02, *params)
    return bytes((0xFF, 0xFF, *body, (~sum(body)) & 0xFF))


def configure_serial(fd):
    attrs = termios.tcgetattr(fd)
    attrs[0] = 0
    attrs[1] = 0
    attrs[2] = termios.CS8 | termios.CLOCAL | termios.CREAD
    attrs[3] = 0
    attrs[4] = termios.B1000000
    attrs[5] = termios.B1000000
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, attrs)


def write_all(fd, data):
    offset = 0
    deadline = time.monotonic() + READ_TIMEOUT_SECONDS
    while offset < len(data):
        remaining = max(0.0, deadline - time.monotonic())
        _, writable, _ = select.select([], [fd], [], remaining)
        if not writable:
            raise TimeoutError("serial write timed out")
        offset += os.write(fd, data[offset:])


class SyncReadTimeout(TimeoutError):
    """A timeout retaining the IDs that did not provide a valid frame."""

    def __init__(self, missing_ids):
        self.missing_ids = tuple(missing_ids)
        super().__init__(f"HX SYNC_READ timeout; missing IDs {list(self.missing_ids)}")


def read_blocks(fd, request, expected_ids, block_length=READ_LENGTH,
                timeout_seconds=None, trace=None):
    # Match the production transport: discard stale bytes, write without tcdrain,
    # then let the half-duplex UART switch to receive mode.
    termios.tcflush(fd, termios.TCIFLUSH)
    write_all(fd, request)
    started = time.monotonic()
    expected = set(expected_ids)
    blocks = {}
    parser = FrameParser()
    if trace is not None:
        trace.update(tx=request.hex(), received_ids=[], frames=[], rx_hex="",
                     host_checksum_errors=0, host_invalid_lengths=0)
    deadline = time.monotonic() + (timeout_seconds or READ_TIMEOUT_SECONDS)
    while time.monotonic() < deadline:
        readable, _, _ = select.select(
            [fd], [], [], max(0.0, deadline - time.monotonic())
        )
        if not readable:
            break
        try:
            data = os.read(fd, 4096)
        except BlockingIOError:
            continue
        if not data:
            continue
        if trace is not None:
            trace["rx_hex"] += data.hex()
        parser.feed(data)
        while True:
            frame = parser.pop()
            if trace is not None:
                trace.update(host_checksum_errors=parser.checksum_errors,
                             host_invalid_lengths=parser.invalid_lengths,
                             pending_hex=parser.buffer.hex())
            if frame is None:
                break
            device_id, error, payload = frame
            if trace is not None:
                trace["frames"].append({"id": device_id, "status": error,
                                        "length": len(payload),
                                        "at_ms": (time.monotonic() - started) * 1000})
            if device_id not in expected or device_id in blocks:
                continue
            if error:
                raise RuntimeError(f"ID {device_id} status error 0x{error:02X}")
            if len(payload) != block_length:
                raise RuntimeError(
                    f"ID {device_id} payload length {len(payload)}, "
                    f"expected {block_length}"
                )
            blocks[device_id] = payload
            if trace is not None:
                trace["received_ids"].append(device_id)
            if len(blocks) == len(expected_ids):
                return blocks
    raise SyncReadTimeout(device_id for device_id in expected_ids if device_id not in blocks)


def decode_gyro_bias(data, *, allow_unloaded_bias=False):
    """Decode MCU fusion readiness and its external fixed-bias capability."""
    if len(data) != 48 or data[:8] != b"IMUB\x02\x00\x30\x00":
        raise ValueError("需要配套的MCU陀螺仪状态接口")
    flags, reserved = struct.unpack_from("<II", data, 8)
    supported = bool(flags & 1)
    loaded = bool(flags & 2)
    ready = bool(flags & 4)
    raw = struct.unpack_from("<3f", data, 16)
    bias = struct.unpack_from("<3f", data, 28)
    age = struct.unpack_from("<I", data, 40)[0]
    if (flags & ~7 or (loaded and not supported)
            or (supported and ready and not loaded)
            or reserved != 0
            or (not loaded and any(bias) and not (allow_unloaded_bias and supported and not ready))
            or data[44:48] != b"QST3" or age > 100000 or not all(math.isfinite(v) for v in raw + bias)
            or math.sqrt(sum(v*v for v in bias)) > GYRO_BIAS_MAX_NORM_RAD_S):
        raise ValueError("MCU陀螺仪状态无效或过期")
    return {"supported": supported, "ready": ready, "loaded": loaded,
            "raw_sensor_rad_s": raw, "bias_sensor_rad_s": bias}


def read_gyro_bias(fd, imu_id=IMU_ID, *, allow_unloaded_bias=False):
    # UNO Q forwards the HX transaction through the Arduino Router and STM32.
    timeout = READ_TIMEOUT_SECONDS if os.environ.get("WONDERDUCK_UNOQ_ROUTER") else FAULT_TIMEOUT_SECONDS
    return decode_gyro_bias(read_blocks(
        fd, make_read(imu_id, 122, 48), (imu_id,), block_length=48,
        timeout_seconds=timeout)[imu_id], allow_unloaded_bias=allow_unloaded_bias)


def read_persistent_calibration(fd, imu_id=IMU_ID):
    data = read_blocks(fd, make_read(imu_id, 115, 16), (imu_id,),
                       block_length=16, timeout_seconds=0.2)[imu_id]
    if len(data) != 16 or data[:8] != b"CALP\x01\x00\x10\x00":
        raise ValueError("MCU 不支持持久校准；请先安装配套固件")
    flags, generation = struct.unpack_from("<II", data, 8)
    if flags & ~15 or (flags & 4 and not flags & 2) or (flags & 7 and not generation):
        raise ValueError("MCU 持久校准状态无效")
    return {"flags": flags, "generation": generation}


def apply_fixed_gyro_bias(fd, bias, imu_id=IMU_ID):
    bias = struct.unpack("<3f", struct.pack("<3f", *bias))
    if not all(math.isfinite(v) for v in bias) or math.sqrt(sum(v*v for v in bias)) > GYRO_BIAS_MAX_NORM_RAD_S:
        raise ValueError("固定零偏必须有限且模长不超过0.30rad/s")
    read_persistent_calibration(fd, imu_id)
    state = read_gyro_bias(fd, imu_id, allow_unloaded_bias=True)
    if not state["supported"]:
        raise ValueError("MCU使用硬件融合，不支持加载外部固定零偏")
    payload = struct.pack("<HH3f", 1, 1, *bias)
    body = bytes((imu_id, len(payload) + 3, 3, 122)) + payload
    request = b"\xff\xff" + body + bytes((~sum(body) & 255,))
    replies = read_blocks(fd, request, (imu_id,), block_length=16,
                          timeout_seconds=2.0)
    if replies[imu_id] != payload:
        raise ValueError("固定零偏写入回复与请求不一致")
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        state = read_gyro_bias(fd, imu_id, allow_unloaded_bias=True)
        if state["ready"] and state["loaded"] and tuple(state["bias_sensor_rad_s"]) == bias:
            stored = read_persistent_calibration(fd, imu_id)
            if stored["flags"] & 8 or not stored["flags"] & 2:
                raise ValueError("MCU 未确认永久保存陀螺仪校准")
            return state
        time.sleep(0.005)
    raise ValueError("固定零偏回读或融合就绪超时")



def read_fault_snapshot(fd, imu_id=IMU_ID):
    payload = read_blocks(
        fd, make_read(imu_id, FAULT_ADDRESS, FAULT_LENGTH), (imu_id,),
        block_length=FAULT_LENGTH, timeout_seconds=FAULT_TIMEOUT_SECONDS,
    )[imu_id]
    fields = (
        "request", "reply", "flags", "sample_sequence", "sample_age_us",
        "init_failures", "imu_bus_failures", "imu_fifo_failures",
        "uart_errors", "checksum_errors", "rx_overruns", "main_sequence",
        "reply_us",
    )
    return dict(zip(fields, struct.unpack("<13I", payload)))


def fault_location(snapshot, token):
    if token is None:
        return "unknown_counter_unsynchronized"
    if snapshot["request"] != token:
        return "request_not_received_by_mcu"
    if snapshot["reply"] != token:
        return "mcu_reply_not_completed"
    if snapshot["reply_us"] >= READ_TIMEOUT_SECONDS * 1_000_000:
        return "mcu_reply_after_host_deadline"
    return "mcu_reply_sent_in_time"


def diagnose_imu_failure(fd, token, error, imu_id=IMU_ID):
    try:
        fault = read_fault_snapshot(fd, imu_id)
    except (OSError, RuntimeError, TimeoutError) as probe_error:
        print(f"IMU_LOCATION token={token} location=unknown "
              f"cause={error} probe_error={probe_error}", flush=True)
        return None
    print(
        f"IMU_LOCATION token={token} location={fault_location(fault, token)} "
        f"mcu_request={fault['request']} mcu_reply={fault['reply']} "
        f"imu_ready={bool(fault['flags'] & 1)} "
        f"imu_stale={bool(fault['flags'] & 2)} "
        f"sample_sequence={fault['sample_sequence']} "
        f"sample_age_us={fault['sample_age_us']} "
        f"mcu_reply_us={fault['reply_us']} "
        f"imu_bus_failures={fault['imu_bus_failures']} "
        f"imu_fifo_failures={fault['imu_fifo_failures']} "
        f"uart_errors={fault['uart_errors']} "
        f"checksum_errors={fault['checksum_errors']} "
        f"rx_overruns={fault['rx_overruns']} cause={error}",
        flush=True,
    )
    return fault["request"]


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def rotate(q, vector, inverse=False):
    """Rotate a vector using q*v*q^-1, or q^-1*v*q when inverse is true."""
    q_vector = q[1:]
    twice_cross = tuple(2.0 * value for value in cross(q_vector, vector))
    correction = cross(q_vector, twice_cross)
    sign = -1.0 if inverse else 1.0
    return tuple(
        vector[i] + sign * q[0] * twice_cross[i] + correction[i]
        for i in range(3)
    )


def quaternion_multiply(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    )


def normalise(vector):
    magnitude = math.sqrt(sum(value * value for value in vector))
    if magnitude > 0.1:
        return tuple(value / magnitude for value in vector)
    return (0.0, 0.0, -1.0)


def median3(a, b, c):
    return max(a, b) if c >= max(a, b) else min(a, b) if c <= min(a, b) else c


class SharedBusDecoder:
    """Current shared-bus smallest-three decoder and host median filter."""

    def __init__(self):
        self.last_quat = (1.0, 0.0, 0.0, 0.0)
        self.quat_samples = 0
        self.gyro_history = [(0.0, 0.0, 0.0), (0.0, 0.0, 0.0)]
        self.gravity_history = [(0.0, 0.0, -1.0), (0.0, 0.0, -1.0)]

    @property
    def ready(self):
        return self.quat_samples >= 25

    def decode(self, payload):
        sensor_gyro = tuple(
            value * GYRO_RAD_PER_LSB for value in struct.unpack("<hhh", payload[:6])
        )
        gyro = rotate(HX_MOUNT, sensor_gyro)

        bits = int.from_bytes(payload[6:], "little")
        if bits & (1 << 47):
            raise ValueError("MCU IMU未就绪或四元数无效")
        omitted = (bits >> 45) & 3
        quaternion = [0.0] * 4
        slot = 0
        for axis in range(4):
            if axis == omitted:
                continue
            value = (bits >> (15 * slot)) & 0x7fff
            value = value - 0x8000 if value & 0x4000 else value
            if value == -16384:
                raise ValueError("四元数压缩分量无效")
            quaternion[axis] = value / (16383 * math.sqrt(2))
            slot += 1
        remainder = 1 - sum(value * value for value in quaternion)
        if remainder < .25 - .0001:
            raise ValueError("四元数省略分量无效")
        quaternion[omitted] = math.sqrt(remainder)
        if max(map(abs, quaternion)) > quaternion[omitted] + .0001:
            raise ValueError("四元数没有省略最大分量")
        inverse = (HX_MOUNT[0], -HX_MOUNT[1], -HX_MOUNT[2], -HX_MOUNT[3])
        quaternion = quaternion_multiply(quaternion, inverse)
        magnitude = math.sqrt(sum(value * value for value in quaternion))
        self.last_quat = tuple(value / magnitude for value in quaternion)
        self.quat_samples = min(self.quat_samples + 1, 0xffffffff)

        gravity = normalise(rotate(self.last_quat, (0.0, 0.0, -1.0), inverse=True))
        filtered_gyro = tuple(
            median3(self.gyro_history[0][i], self.gyro_history[1][i], gyro[i])
            for i in range(3)
        )
        filtered_gravity = tuple(
            median3(
                self.gravity_history[0][i],
                self.gravity_history[1][i],
                gravity[i],
            )
            for i in range(3)
        )
        self.gyro_history = [self.gyro_history[1], gyro]
        self.gravity_history = [self.gravity_history[1], gravity]
        return filtered_gyro, filtered_gravity, self.last_quat, sensor_gyro






def signed_magnitude(raw, sign_bit):
    magnitude = raw & ((1 << sign_bit) - 1)
    return -magnitude if raw & (1 << sign_bit) else magnitude




















def port_is_in_use(port):
    """Refuse competing serial access before sending a bus packet."""
    try:
        result = subprocess.run(["fuser", "-s", port], check=False)
    except FileNotFoundError:
        print("ERROR: fuser is required to verify exclusive serial-port access.")
        return True
    if result.returncode == 0:
        print(f"ERROR: {port} is in use; stop robotd and every other serial client first.")
        return True
    if result.returncode != 1:
        print(f"ERROR: fuser could not inspect {port} (exit {result.returncode}).")
        return True
    return False
