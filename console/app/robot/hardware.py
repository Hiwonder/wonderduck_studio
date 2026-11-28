"""Single-owner Linux UART access, reusing the device's existing HX decoder."""

import fcntl
import importlib.util
import logging
import math
import os
from pathlib import Path
import select
import struct
import subprocess
import termios
import time

from app.paths import CONSOLE_ROOT
from app.robot.parameter_batch import save_parameters
from app.sensors.i2c_imu import I2cImuReader, compare_samples, resolve_transport_script
from vendor.imu.imu_accel_calibration import SensorReader

from app.robot.protocol import (BAUD_RATES, BY_ADDRESS, POSE_SPEED, ServoLayout, ServoOperationError, encode_register,
                      encode_target, integer, joint_id, motion_targets, packet, pose_targets, raw_to_degrees,
                      register_definition, scan_id, servo_faults, validate_hold_position)


class RegisterReadTimeout(TimeoutError):
    """A register request received no valid status frame before its deadline."""

    def __init__(self, message, *, corrupted=False):
        super().__init__(message)
        self.corrupted = corrupted


class NoServoReply(RegisterReadTimeout, ServoOperationError):
    """The individual request expired without any reply bytes."""


def parse_live_imu_diagnostics(payload):
    """Decode the MCU's live sensor diagnostics, rather than its last sync-read snapshot."""
    if len(payload) != 80:
        raise ValueError("IMU 实时诊断长度无效")
    fields = struct.unpack("<20I", payload)
    if fields[0] != ((80 << 16) | 1):
        raise ValueError("IMU 实时诊断版本无效")
    names = ("flags", "main_sequence", "sample_sequence", "sample_age_us", "init_failures",
             "imu_bus_failures", "imu_fifo_failures", "last_error", "last_error_sequence",
             "uart_rx_bytes", "sync_requests", "tx_completed", "uart_errors", "last_uart_error_flags",
             "checksum_errors", "rx_overruns", "diagnostic_requests", "reset_flags", "invalid_lengths")
    return dict(zip(names, fields[1:]))


class Hardware(ServoLayout):
    # Only the bus-owner thread accesses this short-lived offset editing session.
    offset_lock = None
    check_interrupted = staticmethod(lambda: None)

    def __init__(self, port, source, layout_path=None, full_servo_range=False, imu_source="id200",
                 i2c_transport_script=None, i2c_device_factory=None, home_policy=None):
        self.init_layout(layout_path, full_servo_range)
        self.home_policy = Path(home_policy) if home_policy is not None else None
        self.current_baud = 0
        self.offset_lock_cache = {}
        self.pending_offset_locks = {}
        if imu_source not in ("id200", "i2c", "compare"):
            raise ValueError("IMU 来源必须是 id200、i2c 或 compare")
        self.imu_source = imu_source
        self.i2c_transport_script = Path(i2c_transport_script) if i2c_transport_script else resolve_transport_script(source)
        self.i2c_device_factory = i2c_device_factory
        self.i2c_reader = None
        spec = importlib.util.spec_from_file_location("imu_live", Path(source) / "imu-live.py")
        self.live = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.live)
        sensor_spec = importlib.util.spec_from_file_location(
            "imu_live_sensor", CONSOLE_ROOT / "vendor/imu/imu-live.py")
        sensor_live = importlib.util.module_from_spec(sensor_spec)
        sensor_spec.loader.exec_module(sensor_live)
        ownership = subprocess.run((["sudo", "-n"] if os.geteuid() else []) +
                                   ["fuser", "-s", port], check=False)
        if ownership.returncode == 0:
            raise RuntimeError("串口被占用，请先停止 robotd 和其他串口工具")
        if ownership.returncode != 1:
            raise RuntimeError("无法确认串口占用状态，需要以 sudo 运行或允许 sudo -n fuser")
        self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.ioctl(self.fd, termios.TIOCEXCL)
            self.live.configure_serial(self.fd)
        except BaseException:
            os.close(self.fd)
            raise
        self.decoder = self.live.SharedBusDecoder()
        self.raw_imu = SensorReader(self.fd, sensor_live)
        self.diagnostic = None
        self.diagnostic_time = 0
        self.previous_sequence = None
        self.sequence_time = 0
        self.torque = {}
        self.torque_time = 0
        self.servo_timeouts = set()
        self.action_motion_reset = set()
        self.closed = False

    def set_imu_source(self, source):
        if source not in ("id200", "i2c", "compare"):
            raise ValueError("IMU 来源必须是 id200、i2c 或 compare")
        if source == "id200" and self.i2c_reader is not None:
            self.i2c_reader.close()
            self.i2c_reader = None
        self.imu_source = source

    def sample_i2c_imu(self):
        if self.i2c_reader is None:
            self.i2c_reader = I2cImuReader(self.i2c_transport_script, self.i2c_device_factory)
        return self.i2c_reader.sample()

    def exchange(self, request, ids, length, timeout=.04):
        termios.tcflush(self.fd, termios.TCIFLUSH)
        self.live.write_all(self.fd, request)
        parser = self.live.FrameParser()
        blocks, errors, statuses = {}, {}, {}
        received_bytes = False
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.fd], [], [], max(0, deadline - time.monotonic()))
            if not ready:
                break
            try:
                data = os.read(self.fd, 4096)
            except BlockingIOError:
                continue
            if not data:
                raise OSError("串口 EOF")
            received_bytes = True
            parser.feed(data)
            while True:
                frame = parser.pop()
                if frame is None:
                    break
                device_id, error, payload = frame
                if device_id not in ids or device_id in statuses:
                    continue
                statuses[device_id] = error
                # Servo fault flags do not invalidate a checksummed read payload.
                # ID 200 uses the MCU protocol, whose error handling stays separate.
                if device_id == 200 and error:
                    errors[device_id] = f"设备状态 0x{error:02X}"
                elif len(payload) != length:
                    errors[device_id] = f"回复长度 {len(payload)}，期望 {length}"
                else:
                    blocks[device_id] = payload
            if len(statuses) == len(ids):
                break
        for device_id in ids:
            if device_id not in blocks and device_id not in errors:
                errors[device_id] = "读取超时"
                if parser.checksum_errors:
                    errors[device_id] += f"；总线校验错误 {parser.checksum_errors} 次"
                if parser.invalid_lengths:
                    errors[device_id] += f"；总线无效帧长度 {parser.invalid_lengths} 次"
                if received_bytes and not (parser.checksum_errors or parser.invalid_lengths):
                    errors[device_id] = "总线收到其他或不完整的回复"
        return blocks, errors, statuses

    def read(self, device_id, address, length, *, baud=None):
        self.select_baud(self.baud_codes.get(device_id, 0) if baud is None else baud)
        blocks, errors, statuses = self.exchange(self.live.make_read(device_id, address, length), (device_id,), length)
        if device_id in statuses or errors.get(device_id) not in (None, "读取超时"):
            self.servo_timeouts.discard(device_id)
        if device_id in errors:
            error = f"ID {device_id} · 地址 0x{address:02X} · {length} 字节：{errors[device_id]}"
            if device_id not in statuses:
                if errors[device_id] == "读取超时":
                    raise NoServoReply(error)
                raise RegisterReadTimeout(error, corrupted=True)
            if statuses[device_id] and errors[device_id] == f"回复长度 0，期望 {length}":
                raise ServoOperationError(error)
            raise RegisterReadTimeout(error, corrupted=True)
        return blocks[device_id]

    def read_configuration(self, device_id, address, length, phase, **options):
        for attempt in range(1, 4):
            try:
                data = self.read(device_id, address, length, **options)
            except NoServoReply as error:
                logging.warning("configuration read id=%s address=0x%02X phase=%s attempt=%s/3: %s",
                                device_id, address, phase, attempt, error)
                if attempt == 3:
                    raise NoServoReply(f"{phase}失败，3 次读取均超时：{error}") from error
                time.sleep(.01)
            else:
                if attempt > 1:
                    logging.info("configuration read recovered id=%s address=0x%02X phase=%s attempt=%s/3",
                                 device_id, address, phase, attempt)
                if address <= 55 < address + len(data) and hasattr(self, 'offset_lock_cache'):
                    self.offset_lock_cache[device_id] = data[55 - address:56 - address]
                return data

    def individual_read(self, ids, address, length):
        blocks, errors, statuses, observed = {}, {}, {}, {}
        for device_id in ids:
            self.check_interrupted()
            self.select_baud(self.baud_codes.get(device_id, 0))
            values, failures, replies = self.exchange(
                self.live.make_read(device_id, address, length), (device_id,), length)
            observed[device_id] = time.monotonic()
            blocks.update(values)
            errors.update(failures)
            statuses.update(replies)
        return blocks, errors, statuses, observed

    def baud_groups(self, ids, maximum=251):
        groups = {}
        for device_id in ids:
            groups.setdefault(self.baud_codes.get(device_id, 0), []).append(device_id)
        for code, group in groups.items():
            for start in range(0, len(group), maximum):
                yield code, group[start:start + maximum]

    def select_baud(self, code):
        if code == getattr(self, "current_baud", 0):
            return
        # Linux termios2 supports the manufacturer's nonstandard 128000/76800 rates.
        attributes = bytearray(44)
        fcntl.ioctl(self.fd, 0x802C542A, attributes, True)
        flags = struct.unpack_from("=I", attributes, 8)[0]
        struct.pack_into("=I", attributes, 8, (flags & ~0x100F) | 0x1000)
        struct.pack_into("=II", attributes, 36, BAUD_RATES[code], BAUD_RATES[code])
        fcntl.ioctl(self.fd, 0x402C542B, attributes)
        self.current_baud = code

    def send_write(self, device_id, address, data, *, baud=None):
        self.select_baud(self.baud_codes.get(device_id, 0) if baud is None else baud)
        self.live.write_all(self.fd, packet(254, 0x83, (address, len(data), device_id, *data)))

    def write_verified(self, device_id, address, data, *, configuration_phase=None, **options):
        # Broadcast to one selected ID, as in robotd; reads establish the outcome.
        self.send_write(device_id, address, data, **options)
        got = (self.read(device_id, address, len(data), **options) if configuration_phase is None else
               self.read_configuration(device_id, address, len(data), configuration_phase, **options))
        if got != data:
            phase = f"{configuration_phase}：" if configuration_phase else ""
            raise ServoOperationError(phase + "已发出写入，但寄存器读回不一致；请重新读取，不要自动重发")
        if address == 55 and len(data) == 1 and hasattr(self, 'offset_lock_cache'):
            self.offset_lock_cache[device_id] = data

    def set_temporary_position_p_gain(self, value, ids=None):
        if type(value) is not int or value not in (15, 66):
            raise ValueError("临时位置 P 必须为 15 或 66")
        self.restore_offset_lock(force=True)
        failures = {}
        for device_id in self.ids if ids is None else ids:
            self.check_interrupted()
            try:
                self.require_restored_offset_lock(device_id)
                self.write_verified(device_id, 55, b'\x01', configuration_phase="确认写保护")
                self.write_verified(device_id, 21, bytes((value,)), configuration_phase="位置 P 读回")
            except ServoOperationError as error:
                failures[device_id] = str(error)
        return failures

    def sample_imu(self):
        return self.sample(include_servos=False)

    def sample(self, *, include_servos=True):
        started = time.monotonic()
        previous_timeouts, self.servo_timeouts = self.servo_timeouts, set()
        self.restore_offset_lock()
        imu_source = getattr(self, "imu_source", "id200")
        read_id200 = imu_source in ("id200", "compare")
        read_i2c = imu_source in ("i2c", "compare")
        ids = ((200,) if read_id200 else ()) + (tuple(self.ids) if include_servos else ())
        blocks, errors, statuses, observed = self.individual_read(ids, 56, 12)
        for device_id in self.pending_offset_locks.keys() & blocks.keys():
            self.check_interrupted()
            try:
                self.require_restored_offset_lock(device_id)
            except ServoOperationError as error:
                errors[device_id] = str(error)
        id200_read_at = observed.get(200)
        replies = dict(statuses)
        now = time.monotonic()
        if read_id200 and now - self.diagnostic_time >= 1:
            try:
                # The 208/52 fault block describes the last broadcast sync read.
                # Maintenance reads ID 200 individually, so that snapshot stops
                # advancing. The 128/80 block is the MCU's live sensor state.
                diagnostic = parse_live_imu_diagnostics(self.read(200, 128, 80))
                if diagnostic["sample_sequence"] != self.previous_sequence:
                    self.sequence_time = time.monotonic()
                self.previous_sequence = diagnostic["sample_sequence"]
                self.diagnostic = diagnostic
                self.diagnostic_time = time.monotonic()
            except (OSError, RuntimeError, TimeoutError, ValueError):
                self.diagnostic = None
                self.diagnostic_time = time.monotonic()
        if include_servos and now - self.torque_time >= 1:
            torque, _, torque_statuses, _ = self.individual_read(self.ids, 40, 1)
            self.torque = {i: b[0] for i, b in torque.items()}
            for device_id, status in torque_statuses.items():
                replies[device_id] = replies.get(device_id, 0) | status
            self.torque_time = time.monotonic()
        id200_imu = dict(valid=False, error=errors.get(200, "IMU 正在稳定"),
                         sampled_monotonic=id200_read_at if 200 in blocks else None,
                         observed_monotonic=id200_read_at if read_id200 else None)
        if read_id200 and 200 in blocks:
            payload = blocks[200]
            before = self.decoder.quat_samples
            try:
                gyro, gravity, quaternion, sensor_gyro = self.decoder.decode(payload)
            except ValueError as error:
                id200_imu.update(error=str(error), gyro_calibrated=self.decoder.ready)
            else:
                d = self.diagnostic
                valid = (self.decoder.ready and self.decoder.quat_samples > before and d is not None
                         and bool(d["flags"] & 1) and not bool(d["flags"] & 2)
                         and d["sample_age_us"] < 200000
                         and now - self.sequence_time < 1.5)
                id200_imu.update(valid=valid, quaternion_wxyz=quaternion, gyro_rad_s=gyro,
                                 sensor_gyro_rad_s=sensor_gyro, gravity=gravity,
                                 gyro_calibrated=self.decoder.ready,
                                 error=None if valid else "姿态未就绪或 MCU 数据过期")
        i2c_imu = dict(valid=False, error="I2C IMU 未选择")
        comparison = None
        if read_i2c:
            try:
                i2c_imu = self.sample_i2c_imu()
            except (ImportError, OSError, RuntimeError, ValueError) as error:
                i2c_imu = dict(valid=False, error=str(error))
                errors["i2c"] = str(error)
            i2c_imu["sampled_monotonic"] = i2c_imu.get("acquired_monotonic")
            i2c_imu["observed_monotonic"] = time.monotonic()
            if imu_source == "compare":
                comparison = compare_samples(
                    id200_imu, i2c_imu,
                    round((i2c_imu["acquired_monotonic"] - id200_read_at) * 1000.0, 2)
                    if "acquired_monotonic" in i2c_imu else None)
            i2c_imu.pop("acquired_monotonic", None)
        imu = i2c_imu if imu_source == "i2c" else id200_imu
        if include_servos:
            self.servo_timeouts = {device_id for device_id in self.ids
                                   if device_id not in replies and errors.get(device_id) == "读取超时"}
            for device_id in previous_timeouts & self.servo_timeouts:
                errors[device_id] = "未连接"
        servos = []
        for joint in self.joints if include_servos else ():
            device_id = joint["id"]
            status = replies.get(device_id)
            register_status = blocks[device_id][9] if device_id in blocks else None
            if register_status is not None:
                status = (status or 0) | register_status
            item = dict(joint, online=device_id in replies, valid=False, status=status,
                        packet_status=statuses.get(device_id), register_status=register_status,
                        faults=servo_faults(status or 0), error=errors.get(device_id),
                        torque=self.torque.get(device_id),
                        sampled_monotonic=observed.get(device_id) if device_id in blocks else None,
                        observed_monotonic=observed.get(device_id))
            if device_id in blocks:
                raw, speed, load, voltage, temperature = struct.unpack_from("<HHHBB", blocks[device_id])
                item.update(raw=raw, speed_rad_s=-self.live.signed_magnitude(speed, 15) * 2 * math.pi / 4096,
                            load_percent=self.live.signed_magnitude(load, 10) / 10,
                            voltage=voltage / 10, temperature=temperature,
                            moving=bool(blocks[device_id][10]))
                if raw <= 4095:
                    item.update(valid=True, raw=raw, degrees=raw_to_degrees(raw),
                                radians=math.radians(raw_to_degrees(raw)))
                else:
                    item["error"] = "编码器位置超出 0..4095"
            servos.append(item)
        state = dict(imu=imu, imu_source=imu_source, servos=servos, diagnostics=self.diagnostic,
                     read_ms=round((time.monotonic() - started) * 1000, 2), errors=errors)
        if imu_source == "compare":
            state.update(imu_sources=dict(id200=id200_imu, i2c=i2c_imu), imu_comparison=comparison)
        return state

    def execute(self, command):
        action = command["action"]
        if action == "imu_sample":
            if self.imu_source == "i2c":
                raise ValueError("当前 IMU 来源不是 ID200")
            self.select_baud(0)
            try:
                sample = self.raw_imu.read_raw()
            except TimeoutError as error:
                raise RuntimeError("躯体 IMU 读取超时") from error
            return dict(sample, timestamp_ms=int(time.time() * 1000), frame="sensor")
        if action == "set_imu_source":
            self.set_imu_source(command.get("source"))
            return dict(imu_source=self.imu_source)
        if action == 'scan_servo':
            device_id = scan_id(command.get('id'))
            try:
                identity = self.read(device_id, 5, 1)
            except RegisterReadTimeout as error:
                if error.corrupted:
                    raise RuntimeError(f'扫描回复损坏：{error}') from error
                return dict(id=device_id, found=False)
            except ServoOperationError as error:
                return dict(id=device_id, found=False, error=str(error))
            if identity != bytes((device_id,)):
                return dict(id=device_id, found=False, error=f'ID 寄存器读回不一致：{identity.hex()}')
            return dict(id=device_id, found=True, joint=self.register_discovery(device_id))
        if action in ("center_all", "home_all", "run_targets"):
            return self.move_pose(action, command.get("targets"))
        if action == "release_all":
            outcomes = {}
            unanswered = []
            locked = set(command.get("locked_ids", ()))
            for device_id in self.ids:
                if device_id in locked:
                    continue
                try:
                    self.write_verified(device_id, 40, b"\x00")
                    outcomes[device_id] = "已读回关闭"
                except NoServoReply as error:
                    unanswered.append(device_id)
                    outcomes[device_id] = str(error)
                except Exception as error:
                    outcomes[device_id] = str(error)
            return dict(verified=all(v == "已读回关闭" for v in outcomes.values()),
                        results=outcomes, unanswered_ids=unanswered)
        device_id = joint_id(command.get("id"), self.ids)
        if action == "registers":
            self.restore_offset_lock(force=True)
            raw = self.read_configuration(device_id, 0, 71, "读取参数")
            self.offset_lock_cache[device_id] = raw[55:56]
            return dict(raw=list(raw))
        if action == "read_raw":
            address = integer(command.get("address"), 0, 253, "地址")
            length = integer(command.get("length"), 1, min(71, 254 - address), "长度")
            return dict(address=address, raw=list(self.read(device_id, address, length)))
        if action == "torque":
            on = command.get("on")
            if type(on) is not bool:
                raise ValueError("扭矩开关必须为布尔值")
            if on:
                self.ensure_position_mode(device_id)
                position = int.from_bytes(self.read(device_id, 56, 2), "little")
                validate_hold_position(device_id, position, self.ids, self.full_servo_range)
                self.write_verified(device_id, 42, position.to_bytes(2, "little"))
            self.write_verified(device_id, 40, bytes((int(on),)))
        elif action == "move_direct":
            target = encode_target(device_id, command.get("degrees"), self.ids, self.full_servo_range,
                                   position_limits=getattr(self, "action_position_limits", None))
            speed = integer(command.get("speed", 0), 0, 3400, "速度")
            data = target.to_bytes(2, "little") + b"\x00\x00" + speed.to_bytes(2, "little")
            self.send_write(device_id, 42, data)
            return dict(sent=True, id=device_id, action=action, target=target)
        elif action == "offset_direct":
            return self.write_offset_direct(device_id, command.get("value"))
        elif action == "move":
            target = encode_target(device_id, command.get("degrees"), self.ids, self.full_servo_range)
            speed = integer(command.get("speed", 0), 0, 3400, "速度")
            self.ensure_position_mode(device_id)
            if self.read(device_id, 40, 1) != b"\x01":
                raise ValueError("请先开启所选舵机扭矩")
            actual = raw_to_degrees(int.from_bytes(self.read(device_id, 56, 2), "little"))
            if abs(command["degrees"] - actual) > 10:
                raise ValueError("单次移动最多 10 度，请分段调整")
            data = target.to_bytes(2, "little") + b"\x00\x00" + speed.to_bytes(2, "little")
            self.write_verified(device_id, 42, data)
        elif action == "write_register":
            return self.write_register(device_id, command)
        else:
            raise ValueError("未知操作")
        return dict(verified=True, id=device_id, action=action)

    def parameter_batch(self, command, check, progress):
        self.restore_offset_lock(force=True)

        def read(device_id, address, length, phase):
            if phase == "批量参数预检":
                self.require_restored_offset_lock(device_id)
            return self.read_configuration(device_id, address, length, phase)

        return save_parameters(command, self.ids, read, self.send_write, check, progress)

    def check_id_available(self, device_id, target_id):
        if target_id == 200:
            raise ValueError("总线设备 ID 必须唯一，ID 200 已保留给躯体 IMU")
        target_baud = self.baud_codes.get(target_id, 0)
        source_baud = self.baud_codes.get(device_id, 0)
        for baud in dict.fromkeys((target_baud, source_baud)):
            for _ in range(2):
                try:
                    self.read(target_id, 5, 1, baud=baud)
                except RegisterReadTimeout as error:
                    if not error.corrupted:
                        continue
                    raise RuntimeError(f"无法确认 ID {target_id} 是否空闲：{error}") from error
                raise ValueError(f"总线设备 ID 必须唯一，ID {target_id} 已有回复")

    def write_register(self, device_id, command):
        address = integer(command.get("address"), 0, 70, "地址")
        if address not in BY_ADDRESS:
            raise ValueError("未定义的寄存器地址")
        if address == 31:
            register = self.position_offset_register(device_id)
        else:
            mode = self.read(device_id, 33, 1)[0] if address in (44, 46) else 0
            register = register_definition(address, mode)
        value = command.get("value")
        data = encode_register(register, value)
        if self.offset_lock is not None and (address != 31 or self.offset_lock[0] != device_id or not self.offset_lock[3]):
            self.restore_offset_lock(force=True)
        self.require_restored_offset_lock(device_id)
        id_change = address == 5 and value != device_id
        baud_options = {"baud": self.baud_codes.get(device_id, 0)} if id_change else {}
        if id_change:
            if self.read_configuration(device_id, 5, 1, "确认原 ID") != bytes((device_id,)):
                raise RuntimeError(f"ID {device_id} 的寄存器读回不一致")
            self.check_id_available(device_id, value)
        saved_lock = None
        target_id = device_id
        id_verified = False
        try:
            if register["region"] == "NVS":
                if address == 31 and self.offset_lock is not None:
                    saved_lock = self.offset_lock[1]
                else:
                    saved_lock = self.read_configuration(device_id, 55, 1, "读取写保护锁")
                    if address == 31:
                        self.offset_lock = (device_id, saved_lock, time.monotonic() + 1, True)
                    if saved_lock != b"\x00":
                        self.write_verified(device_id, 55, b"\x00", configuration_phase="解除写保护")
            if id_change:
                target_id = value
            self.send_write(device_id, address, data)
            if address == 6:
                termios.tcdrain(self.fd)
                self.baud_codes[device_id] = value
            if address == 40 and value == 128:
                if int.from_bytes(self.read(target_id, 56, 2), "little") != 2048:
                    raise RuntimeError("中位校准已发出，但当前位置未读回 2048")
            else:
                actual = (self.read_configuration(target_id, address, len(data), "参数读回", **baud_options)
                          if register["region"] == "NVS" and address != 31 else
                          self.read(target_id, address, len(data)))
                if actual != data:
                    raise RuntimeError("已发出写入，但寄存器读回不一致；请重新读取，不要自动重发")
            if id_change:
                id_verified = True
                self.record_id_change(device_id, value)
                self.servo_timeouts.difference_update((device_id, value))
                self.torque.pop(device_id, None)
                self.torque.pop(value, None)
                self.offset_lock_cache.pop(device_id, None)
                self.offset_lock_cache.pop(value, None)
                self.torque_time = 0
            elif address == 6:
                self.save_layout()
            if address == 55 and hasattr(self, 'offset_lock_cache'):
                self.offset_lock_cache[target_id] = data
            if address == 31:
                self.offset_lock = (device_id, saved_lock, time.monotonic() + 1, True)
                saved_lock = None
        finally:
            if address == 31 and saved_lock is not None:
                self.restore_offset_lock(force=True)
            elif saved_lock is not None and saved_lock != b"\x00":
                if id_change and target_id != device_id and not id_verified:
                    # Recover the original servo's lock if the rename never took effect.
                    try:
                        if self.read(device_id, 5, 1) == bytes((device_id,)):
                            target_id = device_id
                    except (OSError, RuntimeError, ValueError):
                        pass
                self.write_verified(target_id, 55, saved_lock, configuration_phase="恢复写保护", **baud_options)
        return dict(verified=True, id=target_id, previous_id=device_id, action="write_register",
                    address=address, value=value)

    def position_offset_register(self, device_id):
        if self.read(device_id, 40, 1) != b"\x01":
            raise ServoOperationError("请先开启所选舵机扭矩")
        return register_definition(31, servo_version=tuple(self.read(device_id, 3, 2)))

    def write_offset_direct(self, device_id, value):
        data = encode_register(self.position_offset_register(device_id), value)
        if self.offset_lock is not None and self.offset_lock[0] != device_id:
            self.restore_offset_lock(force=True)
        self.require_restored_offset_lock(device_id)
        unlock = False
        if self.offset_lock is None:
            saved_lock = self.offset_lock_cache.get(device_id)
            if saved_lock not in (b"\x00", b"\x01"):
                raise ValueError("请先读取舵机参数以确定写保护状态")
            self.offset_lock = (device_id, saved_lock, time.monotonic() + 1, False)
            unlock = saved_lock != b"\x00"
        saved_lock = self.offset_lock[1]
        try:
            if unlock:
                self.send_write(device_id, 55, b"\x00")
            self.send_write(device_id, 31, data)
        except Exception as error:
            try:
                self.restore_offset_lock(force=True)
            except Exception as restore_error:
                raise RuntimeError(f"偏差发送失败：{error}；恢复写保护失败：{restore_error}") from error
            raise
        self.offset_lock = (device_id, saved_lock, time.monotonic() + 1, False)
        return dict(sent=True, id=device_id, action="offset_direct", value=value)

    def move_pose(self, action, rows=None):
        targets = (motion_targets(rows, self.ids, self.full_servo_range) if action == "run_targets" else
                   pose_targets(action, self.ids, self.home_policy))
        return self.move_targets(action, targets)

    def prepare_motion(self, ids, *, pose=False):
        starts, failures = {}, {}
        # Complete preflight before sending any new targets or enabling torque.
        for device_id in ids:
            self.check_interrupted()
            try:
                self.ensure_position_mode(device_id)
                torque = self.read(device_id, 40, 1)
                if torque not in (b"\x00", b"\x01"):
                    raise ServoOperationError("扭矩状态无效")
                if pose or torque == b"\x00":
                    position = self.read(device_id, 56, 2)
                    if int.from_bytes(position, "little") > 4095:
                        raise ServoOperationError("编码器位置超出 0..4095")
                    if torque == b"\x00":
                        starts[device_id] = position
            except ServoOperationError as error:
                failures[device_id] = str(error)
        for device_id, position in starts.items():
            self.check_interrupted()
            try:
                if pose:
                    # Refresh the hold position just before enabling torque.
                    position = self.read(device_id, 56, 2)
                    if int.from_bytes(position, "little") > 4095:
                        raise ServoOperationError("编码器位置超出 0..4095")
                self.write_verified(device_id, 42, position)
                self.write_verified(device_id, 40, b"\x01")
            except ServoOperationError as error:
                failures[device_id] = str(error)
        return failures

    def prepare_action_playback(self, ids):
        failures = self.prepare_motion(ids)
        self.action_motion_reset.update(device_id for device_id in ids if device_id not in failures)
        return failures

    def move_action_frame(self, targets, duration_ms):
        duration = integer(duration_ms, 1, 30000, "动作时长").to_bytes(2, "little")
        initial = [device_id for device_id in targets if device_id in self.action_motion_reset]
        remaining = [device_id for device_id in targets if device_id not in self.action_motion_reset]
        for reset, selected in ((True, initial), (False, remaining)):
            for code, group in self.baud_groups(selected, maximum=31 if reset else 35):
                self.check_interrupted()
                self.select_baud(code)
                # In position mode register 44 is the movement time, in milliseconds.
                # Send it with the new goal; changing it on the old goal can retrigger motion.
                params = bytearray((41, 7) if reset else (42, 6))
                for device_id in group:
                    position = targets[device_id].to_bytes(2, "little")
                    params.extend((device_id, 0, *position, *duration, 0, 0) if reset else
                                  (device_id, *position, *duration, 0, 0))
                self.live.write_all(self.fd, packet(254, 0x83, params))
                self.action_motion_reset.difference_update(group)
        return dict(sent=True, action="action_frame", targets=targets, duration_ms=duration_ms)

    def move_targets(self, action, targets):
        try:
            return self.send_pose_targets(action, targets)
        except (OSError, RuntimeError, TimeoutError, ValueError) as error:
            raise RuntimeError(f"姿态操作结果未全部确认，请读取状态后再操作：{error}") from error

    def send_pose_targets(self, action, targets):
        failures = self.prepare_motion(targets, pose=True)
        selected = {device_id: raw for device_id, raw in targets.items() if device_id not in failures}
        payloads = {device_id: raw.to_bytes(2, "little") + b"\x00\x00" + POSE_SPEED.to_bytes(2, "little")
                    for device_id, raw in selected.items()}
        for code, group in self.baud_groups(selected, maximum=35):
            self.check_interrupted()
            self.select_baud(code)
            params = bytearray((42, 6))
            for device_id in group:
                params.extend((device_id, *payloads[device_id]))
            self.live.write_all(self.fd, packet(254, 0x83, params))
        confirmed = {}
        for device_id, data in payloads.items():
            self.check_interrupted()
            try:
                if self.read(device_id, 42, 6) != data:
                    raise ServoOperationError("目标寄存器读回不一致")
                confirmed[device_id] = selected[device_id]
            except ServoOperationError as error:
                failures[device_id] = str(error)
        return dict(verified=not failures, action=action, targets=confirmed, speed=POSE_SPEED, errors=failures)

    def ensure_position_mode(self, device_id):
        if self.read(device_id, 33, 1) != b"\x00":
            raise ServoOperationError("当前舵机不是位置模式")

    def require_restored_offset_lock(self, device_id):
        saved_lock = self.pending_offset_locks.get(device_id)
        if saved_lock is None:
            return
        try:
            if self.read(device_id, 55, 1) != saved_lock:
                self.write_verified(device_id, 55, saved_lock)
            self.offset_lock_cache[device_id] = saved_lock
        except ServoOperationError as error:
            raise ServoOperationError(f"偏差写保护恢复未确认：{error}") from error
        del self.pending_offset_locks[device_id]

    def restore_offset_lock(self, force=False):
        if self.offset_lock is None:
            return
        device_id, saved_lock, deadline, _ = self.offset_lock
        if not force and time.monotonic() < deadline:
            return
        if saved_lock != b"\x00":
            try:
                self.write_verified(device_id, 55, saved_lock)
            except ServoOperationError as error:
                # Keep restoration local to this servo until it answers again.
                self.pending_offset_locks[device_id] = saved_lock
                self.offset_lock_cache.pop(device_id, None)
                self.offset_lock = None
                logging.warning("offset lock restore id=%s: %s", device_id, error)
                return
        self.offset_lock_cache[device_id] = saved_lock
        self.offset_lock = None

    def close(self):
        if not self.closed:
            try:
                self.restore_offset_lock(force=True)
                for device_id in list(self.pending_offset_locks):
                    try:
                        self.require_restored_offset_lock(device_id)
                    except ServoOperationError as error:
                        logging.warning("closing with offset lock unconfirmed id=%s: %s", device_id, error)
            finally:
                try:
                    if self.i2c_reader is not None:
                        self.i2c_reader.close()
                        self.i2c_reader = None
                finally:
                    self.closed = True
                    fcntl.ioctl(self.fd, termios.TIOCNXCL)
                    os.close(self.fd)
