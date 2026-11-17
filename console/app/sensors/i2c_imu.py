"""Read and convert the robot's fused I2C IMU without changing its configuration."""

import importlib.util
import math
from pathlib import Path
import struct
import time


BUS_PATH = "/dev/i2c-5"
ADDRESS = 0x50
# The modules differ by 180 degrees about sensor Y, before trunk mounting.
# mount_id200 * rot_sensor_y(pi): trunk = [-sensor_z, -sensor_x, sensor_y].
MOUNT = (0.5, 0.5, -0.5, -0.5)
GYRO_RAD_PER_LSB = 2000.0 / 32768.0 * math.pi / 180.0


def resolve_transport_script(source):
    return Path(source) / "imu-i2c-probe.py"


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def rotate(q, vector, inverse=False):
    qv = q[1:]
    twice = tuple(2.0 * value for value in cross(qv, vector))
    correction = cross(qv, twice)
    sign = -1.0 if inverse else 1.0
    return tuple(vector[i] + sign * q[0] * twice[i] + correction[i] for i in range(3))


def multiply(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return (aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw)


def median3(a, b, c):
    return max(a, b) if c >= max(a, b) else min(a, b) if c <= min(a, b) else c


def convert_sample(clock, acc_gyro, quaternion, gyro_history=None, gravity_history=None):
    """Convert one runtime-format sample to the final body-frame IMU fields."""
    if len(clock) != 4 or len(acc_gyro) != 12 or len(quaternion) != 8:
        raise ValueError("I2C IMU 返回长度不符合时钟/六轴/四元数协议")
    sensor_quat = tuple(value / 32768.0 for value in struct.unpack("<hhhh", quaternion))
    norm = math.sqrt(sum(value * value for value in sensor_quat))
    if not 0.95 <= norm <= 1.05:
        raise ValueError(f"I2C IMU 四元数模长无效：{norm:.6f}")
    sensor_quat = tuple(value / norm for value in sensor_quat)
    mount_inverse = (MOUNT[0], -MOUNT[1], -MOUNT[2], -MOUNT[3])
    body_quat = multiply(sensor_quat, mount_inverse)
    body_norm = math.sqrt(sum(value * value for value in body_quat))
    body_quat = tuple(value / body_norm for value in body_quat)
    gravity = rotate(body_quat, (0.0, 0.0, -1.0), inverse=True)
    sensor_gyro = tuple(value * GYRO_RAD_PER_LSB for value in struct.unpack("<hhh", acc_gyro[6:12]))
    gyro = rotate(MOUNT, sensor_gyro)
    gyro_history = gyro_history or (gyro, gyro)
    gravity_history = gravity_history or (gravity, gravity)
    filtered_gyro = tuple(median3(gyro_history[0][i], gyro_history[1][i], gyro[i]) for i in range(3))
    filtered_gravity = tuple(median3(gravity_history[0][i], gravity_history[1][i], gravity[i])
                             for i in range(3))
    return dict(quaternion_wxyz=body_quat, gyro_rad_s=filtered_gyro, gravity=filtered_gravity,
                sensor_clock=int.from_bytes(clock, "little"), _gyro=gyro, _gravity=gravity)


class I2cImuReader:
    def __init__(self, transport_script, device_factory=None):
        self.transport_script = Path(transport_script)
        self.device_factory = device_factory
        self.device = None
        self.previous_clock = None
        self.gyro_history = None
        self.gravity_history = None

    def _open(self):
        if self.device_factory is not None:
            self.device = self.device_factory(BUS_PATH, ADDRESS)
            return
        if not self.transport_script.is_file():
            raise FileNotFoundError(f"找不到 I2C 只读传输模块：{self.transport_script}")
        spec = importlib.util.spec_from_file_location("console_i2c_transport", self.transport_script)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"无法加载 I2C 只读传输模块：{self.transport_script}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        device_type = getattr(module, "I2cDevice", None)
        if device_type is None:
            raise RuntimeError(f"I2C 只读传输模块没有 I2cDevice：{self.transport_script}")
        self.device = device_type(BUS_PATH, ADDRESS)

    def sample(self):
        if self.device is None:
            self._open()
        started = time.monotonic()
        clock = self.device.read(0x32, 4)
        acc_gyro = self.device.read(0x34, 12)
        quaternion = self.device.read(0x51, 8)
        acquired = time.monotonic()
        converted = convert_sample(clock, acc_gyro, quaternion, self.gyro_history, self.gravity_history)
        previous = self.previous_clock
        self.previous_clock = converted["sensor_clock"]
        self.gyro_history = (self.gyro_history[1], converted["_gyro"]) if self.gyro_history else (
            converted["_gyro"], converted["_gyro"])
        self.gravity_history = (self.gravity_history[1], converted["_gravity"]) if self.gravity_history else (
            converted["_gravity"], converted["_gravity"])
        converted.pop("_gyro")
        converted.pop("_gravity")
        advanced = previous is None or converted["sensor_clock"] != previous
        if not advanced:
            raise RuntimeError("I2C IMU 设备时钟未推进")
        converted.update(valid=True, error=None, acquired_monotonic=acquired,
                         read_ms=round((acquired - started) * 1000.0, 2))
        return converted

    def close(self):
        if self.device is not None:
            self.device.close()
            self.device = None


def compare_samples(id200, i2c, read_offset_ms):
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in
               (*id200.get("quaternion_wxyz", ()), *i2c.get("quaternion_wxyz", ()),
                *id200.get("gyro_rad_s", ()), *i2c.get("gyro_rad_s", ()),
                *id200.get("gravity", ()), *i2c.get("gravity", ()))):
        return dict(valid=False, read_offset_ms=read_offset_ms)
    qa, qb = id200["quaternion_wxyz"], i2c["quaternion_wxyz"]
    dot = min(1.0, abs(sum(a * b for a, b in zip(qa, qb))))
    gyro_delta = math.sqrt(sum((a - b) ** 2 for a, b in zip(id200["gyro_rad_s"], i2c["gyro_rad_s"])))
    gravity_delta = math.sqrt(sum((a - b) ** 2 for a, b in zip(id200["gravity"], i2c["gravity"])))
    gravity_norms = [math.sqrt(sum(v * v for v in sample["gravity"])) for sample in (id200, i2c)]
    gravity_angle = None
    if min(gravity_norms) > 0.1:
        gravity_dot = sum(a * b for a, b in zip(id200["gravity"], i2c["gravity"]))
        gravity_angle = math.degrees(math.acos(max(-1.0, min(1.0,
            gravity_dot / (gravity_norms[0] * gravity_norms[1])))))
    return dict(valid=bool(id200.get("valid") and i2c.get("valid")),
                orientation_delta_deg=math.degrees(2.0 * math.acos(dot)),
                gyro_delta_rad_s=gyro_delta, gravity_delta=gravity_delta,
                gravity_angle_deg=gravity_angle,
                read_offset_ms=read_offset_ms)
