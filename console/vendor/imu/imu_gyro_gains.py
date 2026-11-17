"""Manual gyro sensitivity calibration and restoration over HX."""

import datetime
import struct
import time

ADDRESS = 117
STATUS_LENGTH = 40


def validate_configuration(value):
    if value is None:
        return None  # Explicit factory sensitivity, not a failed-COD fallback.
    if not isinstance(value, dict) or set(value) != {
            "schema_version", "device_uid", "gains", "cod_status", "created_utc"}:
        raise ValueError("COD配置字段不完整或包含未知字段")
    if value["schema_version"] != 1 or value["cod_status"] != 0:
        raise ValueError("COD配置必须来自成功校准")
    if not isinstance(value["created_utc"], str) or not value["created_utc"]:
        raise ValueError("COD配置缺少时间")
    for key, length, maximum in (("device_uid", 6, 255), ("gains", 3, 65535)):
        values = value[key]
        if (not isinstance(values, list) or len(values) != length or
                any(type(x) is not int or not 0 <= x <= maximum for x in values)):
            raise ValueError(f"COD配置 {key} 无效")
    if value["device_uid"] in ([0] * 6, [255] * 6):
        raise ValueError("COD设备标识无效")
    return value


def decode_status(payload):
    if len(payload) != STATUS_LENGTH:
        raise ValueError("COD状态长度错误")
    magic, schema, length, flags, phase, cod_status, error, uid, gx, gy, gz, generation, elapsed, reserved = (
        struct.unpack("<4sHHHBBI6s3HII4s", payload))
    if (magic != b"GYGC" or schema != 1 or length != STATUS_LENGTH or flags & ~15
            or phase > 4 or error > 5 or reserved != bytes(4)
            or bool(flags & 4) != (phase in (1, 2))
            or bool(flags & 8) != (error != 0) or (phase == 4) != (error != 0)):
        raise ValueError("COD状态格式或状态机证据无效")
    if flags & 1 and list(uid) in ([0] * 6, [255] * 6):
        raise ValueError("COD状态的设备标识无效")
    return dict(supported=bool(flags & 1), installed=bool(flags & 2), busy=bool(flags & 4),
                phase=phase, cod_status=cod_status, error=error, device_uid=list(uid),
                gains=[gx, gy, gz], generation=generation, elapsed_ms=elapsed)


def read_status(live, fd, imu_id=200):
    return decode_status(live.read_blocks(fd, live.make_read(imu_id, ADDRESS, STATUS_LENGTH),
        (imu_id,), block_length=STATUS_LENGTH, timeout_seconds=.15)[imu_id])


def require_supported(state):
    if not state["supported"]:
        raise ValueError("所选固件不支持COD；请使用配套QMI固定标定固件")
    if state["busy"]:
        raise ValueError("COD或增益恢复正在运行，拒绝另一次操作")


def matches(state, configuration):
    if configuration is None:
        return not state["installed"] and not state["busy"] and not state["error"]
    return (state["installed"] and not state["busy"] and not state["error"]
            and state["gains"] == configuration["gains"])


def operate(live, fd, operation, uid, gains, imu_id=200):
    payload = struct.pack("<HH6s3H4x", 1, operation, bytes(uid), *gains)
    body = bytes((imu_id, len(payload) + 3, 3, ADDRESS)) + payload
    packet = b"\xff\xff" + body + bytes((~sum(body) & 255,))
    state = decode_status(live.read_blocks(fd, packet, (imu_id,), block_length=STATUS_LENGTH,
                                          timeout_seconds=.15)[imu_id])
    generation = state["generation"]
    deadline = time.monotonic() + 4.
    while True:
        if state["device_uid"] != uid or state["generation"] != generation:
            raise ValueError("COD期间设备或操作代际变化")
        if state["error"]:
            raise ValueError(f"COD/恢复失败：error={state['error']}，COD_STATUS=0x{state['cod_status']:02x}")
        if not state["busy"]:
            if state["phase"] != 3 or not state["installed"]:
                raise ValueError("COD/恢复未完成，拒绝使用回显")
            if operation == 1 and state["cod_status"] != 0:
                raise ValueError("COD未成功")
            if operation == 2 and state["gains"] != gains:
                raise ValueError("已完成恢复与请求增益不一致")
            return state
        if time.monotonic() >= deadline:
            raise TimeoutError("COD/增益恢复超时；未安装新校准文件")
        time.sleep(.02)
        state = read_status(live, fd, imu_id)


def calibrate(live, fd, imu_id=200):
    state = read_status(live, fd, imu_id)
    require_supported(state)
    state = operate(live, fd, 1, state["device_uid"], [0, 0, 0], imu_id)
    return dict(schema_version=1, device_uid=state["device_uid"], gains=state["gains"],
                cod_status=0, created_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())


def current_configuration(live, fd, imu_id=200):
    state = read_status(live, fd, imu_id)
    require_supported(state)
    if state["error"]:
        raise ValueError("MCU 陀螺仪增益状态异常")
    if not state["installed"]:
        return None
    return dict(schema_version=1, device_uid=state["device_uid"], gains=state["gains"],
                cod_status=0, created_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())


def verify_or_restore(live, fd, configuration, restore=False, imu_id=200):
    configuration = validate_configuration(configuration)
    state = read_status(live, fd, imu_id)
    require_supported(state)
    if matches(state, configuration):
        return state
    if configuration is None:
        raise ValueError("厂家增益标定文件与MCU活动增益不一致；请完成联合标定或复位后核对")
    if not restore:
        raise ValueError("MCU增益与保存的COD不一致；只读检查不执行恢复")
    return operate(live, fd, 2, state["device_uid"], configuration["gains"], imu_id)
