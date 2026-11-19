"""Coordinate maintenance actions, demo hardware and control sessions."""

from concurrent.futures import Future, TimeoutError as FutureTimeout
import logging
import math
import queue
import secrets
import threading
import time

from app.paths import CONSOLE_ROOT
from app.actions.action_documents import document_from_json
from app.actions.action_playback import ActionPlayback, action_frames
from app.robot.parameter_batch import ParameterBatch, save_parameters
from app.robot.protocol import (IDS, POSE_SPEED, ServoLayout, encode_register, integer,
                                motion_targets, parse_registers, pose_targets,
                                register_definition, scan_id, servo_faults, target_values)
from app.sensors.calibration import Calibration
from app.sensors.i2c_imu import compare_samples

READ_ACTIONS = {"registers", "read_raw", "scan_servo", "set_imu_source", "home_targets", "imu_sample"}
WRITE_ACTIONS = {"torque", "move", "move_direct", "write_register", "offset_direct", "release_all", "center_all",
                 "home_all", "run_targets", "save_parameters", "servo_debug"}
REALTIME_WRITE_ACTIONS = {"move_direct", "offset_direct"}
CALIBRATION_ACTIONS = {"calibration_start", "calibration_restore", "calibration_next", "calibration_cancel"}
SERVO_DEBUG_TIMEOUT = 25


class CommandQueue(queue.Queue):
    """Normal commands are bounded; torque release goes first even when full."""

    def put_emergency(self, item):
        with self.not_empty:
            self.queue.appendleft(item)
            self.unfinished_tasks += 1
            self.not_empty.notify()

    def get_emergency_nowait(self):
        with self.not_empty:
            if not self.queue or self.queue[0][0].get("action") != "release_all":
                raise queue.Empty
            item = self._get()
            self.not_full.notify()
            return item


class DemoHardware(ServoLayout):
    def __init__(self, full_servo_range=False, imu_source="id200", home_policy=None):
        self.init_layout(full_servo_range=full_servo_range)
        self.home_policy = home_policy
        self.set_imu_source(imu_source)
        self.started = time.monotonic()
        self.raw = {}
        self.offset_lock_cache = {}
        home = pose_targets("home_all", self.ids, self.home_policy)
        for joint in self.joints:
            b = bytearray(71)
            b[0:5] = bytes((1, 0, 0, 1, 2))
            b[5] = joint["id"]
            b[8] = 1
            b[11:13] = (4095).to_bytes(2, "little")
            b[13:16] = bytes((70, 140, 45))
            b[16:18] = (1000).to_bytes(2, "little")
            b[21:24] = bytes((48, 32, 0))
            b[48:50] = (1000).to_bytes(2, "little")
            b[56:58] = home[joint["id"]].to_bytes(2, "little")
            b[62:64] = bytes((78, 30))
            self.raw[joint["id"]] = b

    def sample_imu(self):
        return self.sample(include_servos=False)

    def sample(self, *, include_servos=True):
        sampled = time.monotonic()
        t = sampled - self.started
        angle = math.sin(t * .7) * .23
        servos = []
        for joint in self.joints if include_servos else ():
            b = self.raw[joint["id"]]
            raw = int.from_bytes(b[56:58], "little")
            degrees = 180 - raw * 360 / 4096
            servos.append(dict(joint, online=True, valid=raw <= 4095, raw=raw, degrees=degrees,
                               radians=math.radians(degrees), speed_rad_s=0, load_percent=2,
                               voltage=7.8, temperature=30, torque=b[40], moving=bool(b[66]),
                               status=b[65], packet_status=b[65], register_status=b[65],
                               faults=servo_faults(b[65]),
                               error=None if raw <= 4095 else "编码器位置超出 0..4095",
                               sampled_monotonic=sampled, observed_monotonic=sampled))
        imu = dict(valid=True, quaternion_wxyz=[math.cos(angle / 2), 0, math.sin(angle / 2), 0],
                   gyro_rad_s=[0, math.cos(t * .7) * .16, 0],
                   gravity=[math.sin(angle), 0, -math.cos(angle)], gyro_calibrated=False,
                   sampled_monotonic=sampled, observed_monotonic=sampled)
        i2c = dict(imu)
        state = dict(imu=i2c if self.imu_source == "i2c" else imu, imu_source=self.imu_source,
                     servos=servos, errors={}, diagnostics=None, read_ms=.5)
        if self.imu_source == "compare":
            state.update(imu_sources=dict(id200=imu, i2c=i2c),
                         imu_comparison=compare_samples(imu, i2c, 0.5))
        return state

    def set_imu_source(self, source):
        if source not in ("id200", "i2c", "compare"):
            raise ValueError("IMU 来源必须是 id200、i2c 或 compare")
        self.imu_source = source

    def set_temporary_position_p_gain(self, value, ids=None):
        if type(value) is not int or value not in (15, 66):
            raise ValueError("临时位置 P 必须为 15 或 66")
        for device_id in self.ids if ids is None else ids:
            self.raw[device_id][55] = 1
            self.offset_lock_cache[device_id] = b'\x01'
            self.raw[device_id][21] = value

    def execute(self, command):
        from app.robot.protocol import encode_target, integer, joint_id, BY_ADDRESS
        action = command["action"]
        if action == "imu_sample":
            if self.imu_source == "i2c":
                raise ValueError("当前 IMU 来源不是 ID200")
            t = time.monotonic() - self.started
            gyro = [math.sin(t) * .01, math.cos(t) * .015, 0.002]
            return dict(raw_g=[math.sin(t) * .03, math.cos(t) * .03, 1.0],
                        corrected_g=[math.sin(t) * .025, math.cos(t) * .025, .99],
                        gyro_rad_s=gyro, raw_gyro_rad_s=gyro, corrected_gyro_rad_s=gyro,
                        accel_calibrated=True, gyro_calibrated=False,
                        sequence=int(t * 100), age_us=1000, calibrated=True, ready=True,
                        timestamp_ms=int(time.time() * 1000), frame="sensor")
        if action == "set_imu_source":
            self.set_imu_source(command.get("source"))
            return dict(imu_source=self.imu_source)
        if action == 'scan_servo':
            device_id = scan_id(command.get('id'))
            if device_id not in self.raw:
                return dict(id=device_id, found=False)
            if self.raw[device_id][5] != device_id:
                raise RuntimeError(f'ID {device_id} 回复ID寄存器不一致')
            return dict(id=device_id, found=True, joint=self.register_discovery(device_id))
        if action in ("center_all", "home_all", "run_targets"):
            targets = (motion_targets(command.get("targets"), self.ids, self.full_servo_range)
                       if action == "run_targets" else pose_targets(action, self.ids, self.home_policy))
            for device_id in targets:
                b = self.raw[device_id]
                if b[33] != 0:
                    raise ValueError(f"ID {device_id} 当前舵机不是位置模式")
                integer(int.from_bytes(b[56:58], "little"), 0, 4095, "编码器位置")
                if b[40] not in (0, 1):
                    raise ValueError(f"ID {device_id} 扭矩状态无效")
            for device_id, raw in targets.items():
                b = self.raw[device_id]
                b[40] = 1
                b[42:48] = raw.to_bytes(2, "little") + b"\x00\x00" + POSE_SPEED.to_bytes(2, "little")
                b[56:58] = (raw % 4096).to_bytes(2, "little")
            return dict(verified=True, demo=True, action=action, targets=targets, speed=POSE_SPEED)
        if action == "release_all":
            locked = set(command.get("locked_ids", ()))
            for device_id, b in self.raw.items():
                if device_id not in locked:
                    b[40] = 0
            return dict(verified=True)
        device_id = joint_id(command.get("id"), self.ids)
        b = self.raw[device_id]
        if action == "registers":
            self.offset_lock_cache[device_id] = b[55]
            return dict(raw=list(b))
        if action == "read_raw":
            address = integer(command.get("address"), 0, 70, "地址")
            length = integer(command.get("length"), 1, 71 - address, "长度")
            return dict(address=address, raw=list(b[address:address + length]))
        if action == "torque":
            if type(command.get("on")) is not bool:
                raise ValueError("扭矩状态无效")
            b[40] = int(command["on"])
        elif action == "move_direct":
            target = encode_target(device_id, command.get("degrees"), self.ids, self.full_servo_range)
            speed = integer(command.get("speed", 0), 0, 3400, "速度")
            b[42:48] = target.to_bytes(2, "little") + b"\x00\x00" + speed.to_bytes(2, "little")
            if b[40] == 1:
                b[56:58] = (target % 4096).to_bytes(2, "little")
            return dict(sent=True, demo=True, action=action, id=device_id, target=target)
        elif action == "offset_direct":
            if device_id not in self.offset_lock_cache:
                raise ValueError("请先读取舵机参数以确定写保护状态")
            value = command.get("value")
            data = encode_register(BY_ADDRESS[31], value)
            b[31:33] = data
            return dict(sent=True, demo=True, action=action, id=device_id, value=value)
        elif action == "move":
            target = encode_target(device_id, command.get("degrees"), self.ids, self.full_servo_range)
            speed = integer(command.get("speed", 0), 0, 3400, "速度")
            if not b[40]:
                raise ValueError("请先开启所选舵机扭矩")
            actual = 180 - int.from_bytes(b[56:58], "little") * 360 / 4096
            if abs(command["degrees"] - actual) > 10:
                raise ValueError("单次移动最多 10 度")
            b[42:48] = target.to_bytes(2, "little") + b"\x00\x00" + speed.to_bytes(2, "little")
            b[56:58] = (target % 4096).to_bytes(2, "little")
        elif action == "write_register":
            address = integer(command.get("address"), 0, 70, "地址")
            if address not in BY_ADDRESS:
                raise ValueError("未定义的寄存器地址")
            r = register_definition(address, b[33])
            value = command.get("value")
            data = encode_register(r, value)
            if address == 5 and value != device_id and value in (*self.ids, 200):
                raise ValueError("总线设备 ID 必须唯一")
            b[address:address + r["size"]] = data
            if address == 5:
                self.raw[value] = self.raw.pop(device_id)
                self.update_layout(device_id, new_id=value)
            elif address == 6:
                self.update_layout(device_id, baud=value)
            elif address == 40 and value == 128:
                b[56:58] = (2048).to_bytes(2, "little")
                b[40] = 0
            elif address == 42:
                b[56:58] = data
            return dict(verified=True, demo=True, action=action, id=value if address == 5 else device_id,
                        previous_id=device_id, address=address, value=value)
        return dict(verified=True, demo=True)

    def parameter_batch(self, command, check, progress):
        def read(device_id, address, length, phase):
            return bytes(self.raw[device_id][address:address + length])

        def write(device_id, address, data):
            self.raw[device_id][address:address + len(data)] = data

        return save_parameters(command, self.ids, read, write, check, progress)

    def prepare_action_playback(self, ids):
        for device_id in ids:
            b = self.raw[device_id]
            if b[33] != 0 or b[40] not in (0, 1):
                raise ValueError(f"ID {device_id} 模式或扭矩状态无效")
        for device_id in ids:
            b = self.raw[device_id]
            if b[40] == 0:
                b[42:44] = b[56:58]
                b[40] = 1
        self.action_motion_reset = set(ids)

    def move_action_frame(self, targets, duration_ms):
        duration = integer(duration_ms, 1, 30000, "动作时长").to_bytes(2, "little")
        for device_id, raw in targets.items():
            b = self.raw[device_id]
            if device_id in self.action_motion_reset:
                b[41] = 0
                self.action_motion_reset.remove(device_id)
            b[42:44] = raw.to_bytes(2, "little")
            b[44:46] = duration
            b[46:48] = b"\x00\x00"
            b[56:58] = raw.to_bytes(2, "little")
        return dict(sent=True, targets=targets, duration_ms=duration_ms)

    def close(self):
        pass


class Controller:
    def __init__(self, hardware, hz, demo=False, hardware_factory=None, calibration_script=None, port="/dev/ttyS3", full_servo_range=False, maintenance=False, imu_only=False):
        self.hardware, self.hz, self.demo = hardware, hz, demo
        self.imu_source = getattr(hardware, "imu_source", "id200")
        self.full_servo_range = full_servo_range
        self.hardware_factory = hardware_factory
        self.joints = hardware.joints
        self.calibration = Calibration(calibration_script or
            CONSOLE_ROOT / "vendor/imu/imu-calibrate-gyro.py", port, maintenance=maintenance)
        self.commands = CommandQueue(maxsize=16)
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.emergency_lock = threading.RLock()
        self.control_generation = 0
        self.emergency_in_progress = False
        self.emergency_pending = 0
        self.calibration_release_verified = False
        self.partial_maintenance = False
        self.partial_unavailable_ids = set()
        self.imu_only = imu_only
        self.state = dict(imu=dict(valid=False), servos=[], online=False)
        self.maintenance_voltage_ready = False
        self.maintenance_voltage_after = 0.0
        self.pose_targets = {}
        self.sequence, self.failures = 0, 0
        self.token = secrets.token_urlsafe(32)
        self.owner = None
        self.armed_until = 0
        self.batch = ParameterBatch(self.armed, self.stop.is_set)
        self.playback = ActionPlayback(self.armed)
        self.action_request_lock = threading.Lock()
        self.action_generation = 0
        self.servo_debug_request_lock = threading.Lock()
        self.servo_debug = "off"
        self.servo_debug_ids = set()
        self.servo_debug_pending = set()
        self.worker = threading.Thread(target=self.run, name="hx-bus", daemon=True)
        self.worker.start()

    def armed(self, client):
        with self.lock:
            return self.owner == client and time.monotonic() < self.armed_until

    def unavailable_servo_ids(self):
        """Select individual failures from the most recent maintenance scan."""
        with self.lock:
            rows = self.state.get("servos", [])
            online = self.state.get("online") is True
            by_id = {row.get("id"): row for row in rows if isinstance(row, dict)}
            ids = [joint["id"] for joint in self.joints]
            now = time.monotonic()
            return {device_id for device_id in ids if not online
                    or by_id.get(device_id, {}).get("valid") is not True
                    or type(by_id[device_id].get("sampled_monotonic")) not in (int, float)
                    or not 0 <= now - by_id[device_id]["sampled_monotonic"] <= 3}

    def arm(self, client, on):
        with self.lock:
            generation = self.control_generation
            if on and self.emergency_in_progress:
                raise PermissionError("卸力尚未完成，请稍后重新解锁")
        with self.emergency_lock:
            with self.lock:
                if on and (generation != self.control_generation or self.emergency_in_progress):
                    raise PermissionError("卸力前的解锁请求已取消，请重新操作")
            return self._arm(client, on)

    def _arm(self, client, on):
        if on and self.calibration.snapshot()["active"]:
            raise PermissionError("标定中，舵机操作已暂停")
        with self.lock:
            released = not on and self.owner == client
            if on and self.owner not in (None, client) and time.monotonic() < self.armed_until:
                raise ValueError("另一浏览器正在控制设备")
            if on:
                self.owner, self.armed_until = client, time.monotonic() + 30
            elif self.owner == client:
                self.owner, self.armed_until = None, 0
        if released:
            self.batch.cancel("控制已锁定", client=client)
            with self.action_request_lock:
                self.action_generation += 1
                self.playback.cancel("控制已锁定", client=client)
        return dict(armed=self.armed(client))

    def submit(self, command, client):
        action = command.get("action")
        if action == "release_unlocked":
            locked = command.get("locked_ids")
            if (not isinstance(locked, list) or not locked or
                    any(type(device_id) is not int for device_id in locked) or
                    not set(locked).issubset({joint["id"] for joint in self.joints})):
                raise ValueError("锁定舵机列表无效")
            return self.emergency_release(locked)
        if action == "save_parameters" or action not in READ_ACTIONS | WRITE_ACTIONS | CALIBRATION_ACTIONS:
            raise ValueError("未知操作")
        if (action in {"torque", "move", "move_direct", "write_register", "offset_direct"}
                and command.get("id") in self.unavailable_servo_ids()):
            raise ValueError(f"ID {command.get('id')} 未连接或数据已过期")
        if action == "release_all":
            return self.emergency_release()
        if action == "servo_debug":
            if type(command.get("enabled")) is not bool:
                raise ValueError("调试模式状态必须为布尔值")
            with self.servo_debug_request_lock:
                if self.stop.is_set():
                    raise RuntimeError("维护控制器已关闭")
                with self.lock:
                    if command["enabled"] and not (self.owner == client and time.monotonic() < self.armed_until):
                        raise PermissionError("写操作未解锁或已过期")
                    generation = self.control_generation
                return self._queue_servo_debug(command["enabled"], client, generation=generation)
        if self.calibration.snapshot()["active"] and action not in CALIBRATION_ACTIONS:
            raise PermissionError("标定中，舵机操作已暂停")
        requires_arm = action in WRITE_ACTIONS | {'scan_servo'}
        with self.lock:
            if requires_arm and not (self.owner == client and time.monotonic() < self.armed_until):
                raise PermissionError("写操作未解锁或已过期")
            generation = self.control_generation
        if self.batch.active():
            raise RuntimeError("批量保存尚未完成，请等待校验和恢复写保护")
        elif action in WRITE_ACTIONS | CALIBRATION_ACTIONS and self.playback.active():
            raise RuntimeError("动作正在播放，请先停止")
        future = Future()
        self.commands.put_nowait((dict(command, _control_generation=generation), client, time.monotonic() + 3, future))
        return future.result(timeout=5)

    def emergency_release(self, locked_ids=()):
        with self.emergency_lock:
            with self.lock:
                self.control_generation += 1
                self.emergency_in_progress = True
                self.emergency_pending += 1
                self.owner, self.armed_until = None, 0
            self.batch.cancel("已请求卸力")
            with self.action_request_lock:
                self.action_generation += 1
                self.playback.cancel("已请求卸力")
            future = Future()
            def completed(_future):
                with self.lock:
                    self.emergency_pending -= 1
                    self.emergency_in_progress = self.emergency_pending > 0
            future.add_done_callback(completed)
            release = dict(action="release_all")
            if locked_ids:
                release["locked_ids"] = list(locked_ids)
            self.commands.put_emergency((release, None, float("inf"), future))
            try:
                return future.result(timeout=SERVO_DEBUG_TIMEOUT)
            except FutureTimeout:
                raise TimeoutError("卸力仍在执行，结果尚未确认") from None

    def _queue_servo_debug(self, enabled, client, internal=False, generation=None):
        future = Future()
        command = dict(action="servo_debug", enabled=enabled, internal=internal, _control_generation=generation)
        with self.lock:
            self.servo_debug_pending.add(future)

        def finished(done):
            with self.lock:
                self.servo_debug_pending.discard(done)

        future.add_done_callback(finished)
        try:
            self.commands.put_nowait((command, client, time.monotonic() + SERVO_DEBUG_TIMEOUT, future))
        except queue.Full:
            future.cancel()
            raise
        try:
            return future.result(timeout=SERVO_DEBUG_TIMEOUT)
        except FutureTimeout:
            if future.done():
                return future.result()
            if future.cancel():
                raise TimeoutError("舵机调试操作排队超时，未执行") from None
            if future.done():
                return future.result()
            raise TimeoutError("舵机调试操作仍在执行，请等待状态更新后重试") from None

    def _set_servo_debug(self, enabled):
        with self.lock:
            previous = self.servo_debug
        if (enabled and previous == "on") or (not enabled and previous == "off"):
            return dict(servo_debug=previous)
        if enabled and previous == "restore_failed":
            raise RuntimeError("位置 P 尚未恢复，请先关闭调试模式")
        if self.hardware is None:
            if previous != "off":
                with self.lock:
                    self.servo_debug = "restore_failed"
            raise RuntimeError("串口未就绪，无法设置临时位置 P")
        ids = None
        if enabled:
            unavailable = self.unavailable_servo_ids()
            if self.partial_maintenance or unavailable:
                ids = [joint["id"] for joint in self.joints if joint["id"] not in unavailable]
                if not ids:
                    raise RuntimeError("没有可用的舵机")
        elif self.servo_debug_ids:
            ids = list(self.servo_debug_ids)
        def set_gain(value):
            if ids is None:
                self.hardware.set_temporary_position_p_gain(value)
            else:
                self.hardware.set_temporary_position_p_gain(value, ids=ids)
        with self.lock:
            self.servo_debug = "restore_failed"
            if enabled and ids is not None:
                self.servo_debug_ids = set(ids)
        try:
            set_gain(66 if enabled else 15)
        except Exception as error:
            if not enabled:
                raise RuntimeError(f"恢复位置 P=15 失败：{error}") from error
            try:
                set_gain(15)
            except Exception as restore_error:
                raise RuntimeError(f"开启调试模式失败：{error}；恢复位置 P=15 失败：{restore_error}") from error
            with self.lock:
                self.servo_debug = "off"
                self.servo_debug_ids.clear()
            raise RuntimeError(f"开启调试模式失败，已恢复位置 P=15：{error}") from error
        with self.lock:
            self.servo_debug = "on" if enabled else "off"
            if not enabled:
                self.servo_debug_ids.clear()
            return dict(servo_debug=self.servo_debug)

    def parameter_task(self, command, client):
        operation = command.get('operation')
        if operation == 'start':
            with self.emergency_lock:
                if self.playback.active():
                    raise RuntimeError('动作正在播放，请先停止')
                if not self.armed(client):
                    raise PermissionError('写操作未解锁或已过期')
                if self.calibration.snapshot()['active'] or self.hardware is None:
                    raise PermissionError('标定中，舵机操作已暂停')
                with self.lock:
                    generation = self.control_generation
                return self.batch.start(dict(command, _control_generation=generation), client,
                                        [joint['id'] for joint in self.joints], self.commands)
        if operation == 'cancel':
            self.batch.cancel('操作已取消', client, command.get('job'))
        elif operation != 'status':
            raise ValueError('未知批量操作')
        return self.batch.status(command.get('job'), client)

    @staticmethod
    def finish_action_frame(future):
        try:
            return future.result(timeout=5)
        except FutureTimeout:
            if future.cancel():
                raise TimeoutError("动作帧排队超时，未发送") from None
            raise TimeoutError("动作帧仍在发送，结果尚未确认") from None

    def action_task(self, command, client, *, defer_frame=False):
        operation = command.get("operation")
        if operation == "status":
            return self.playback.snapshot()
        if operation == "stop":
            with self.action_request_lock:
                self.action_generation += 1
                return self.playback.cancel("已停止")
        if operation not in ("start", "send_frame"):
            raise ValueError("未知动作播放操作")
        with self.action_request_lock:
            generation = self.action_generation
        if not self.armed(client):
            raise PermissionError("写操作未解锁或已过期")
        if self.batch.active() or self.calibration.snapshot()["active"] or self.hardware is None:
            raise RuntimeError("设备正在执行其他操作")
        document = document_from_json(command.get("document"))
        locked = command.get("locked_ids", [])
        if not isinstance(locked, list) or any(type(item) is not int for item in locked):
            raise ValueError("锁定舵机列表无效")
        known_ids = {joint["id"] for joint in self.joints} | (set(IDS) if self.partial_maintenance else set())
        if not set(locked).issubset(known_ids):
            raise ValueError("锁定列表包含未知舵机")
        locked = list(set(locked) | self.unavailable_servo_ids()
                      | (set(IDS) - {joint["id"] for joint in self.joints} if self.partial_maintenance else set()))
        available_frames = action_frames(document, [joint["id"] for joint in self.joints], locked)
        if not any(targets for _, targets in available_frames):
            raise ValueError("动作没有可用的舵机")
        if operation == "send_frame":
            frames = available_frames
            if len(frames) != 1:
                raise ValueError("单次运行只能发送一帧")
            duration, targets = frames[0]
            if not targets:
                raise ValueError("本帧舵机均已锁定或隐藏")
        future = Future()
        with self.action_request_lock:
            if generation != self.action_generation:
                raise RuntimeError("动作播放请求已取消")
            queued = (dict(action="send_action_frame", duration_ms=duration, targets=targets, generation=generation)
                      if operation == "send_frame" else
                      dict(action="start_action_playback", document=document, loop=command.get("loop", False),
                           locked_ids=locked, generation=generation))
            self.commands.put_nowait((queued, client, time.monotonic() + 3, future))
        if operation == "send_frame":
            return future if defer_frame else self.finish_action_frame(future)
        return future.result(timeout=5)

    def snapshot(self, client):
        with self.lock:
            state = dict(self.state)
            state["pose_targets"] = dict(self.pose_targets)
            state['joints'] = [dict(joint) for joint in self.joints]
            state["servo_debug"] = self.servo_debug
            state["maintenance_voltage_ready"] = self.maintenance_voltage_ready
        state.update(armed=self.armed(client), demo=self.demo, calibration=self.calibration.snapshot(),
                     parameter_batch_active=self.batch.active(), imu_source=self.imu_source,
                     action_playback=self.playback.snapshot())
        return state

    def execute_calibration(self, command, client):
        if command["action"] not in ("calibration_start", "calibration_restore"):
            return self.calibration.control(command["action"], client)
        if self.imu_source == "i2c":
            raise PermissionError("当前为 I2C IMU 模式，不能向 MCU 发送校准命令")
        if self.demo:
            raise ValueError("演示模式不能进行硬件标定")
        if self.hardware_factory is None or self.hardware is None:
            raise ValueError("串口未就绪")
        with self.lock:
            if self.owner not in (None, client) and time.monotonic() < self.armed_until:
                raise PermissionError("另一浏览器正在控制设备")
        prepared = self.calibration.prepare(command, client)
        self._set_servo_debug(False)
        self.calibration_release_verified = False
        released = self.hardware.execute({"action": "release_all"})
        if not released.get("verified"):
            unavailable = (self.partial_unavailable_ids if self.imu_only else self.unavailable_servo_ids()) if self.partial_maintenance else set()
            failures = {device_id: str(value) for device_id, value in released.get("results", {}).items()
                        if value != "已读回关闭"}
            if not failures or any(device_id not in unavailable or not ("超时" in error or "timeout" in error.lower())
                                   for device_id, error in failures.items()):
                raise RuntimeError("在线舵机卸力未确认，标定未启动；请检查舵机状态")
        self.calibration_release_verified = released.get("verified") is True
        self.hardware.close()
        self.hardware = None
        with self.lock:
            self.owner, self.armed_until = None, 0
            self.state = dict(self.state, online=False, imu=dict(valid=False), servos=[])
            self.maintenance_voltage_ready = False
        self.calibration.start(prepared)
        return self.calibration.snapshot()

    def run(self):
        next_sample = time.monotonic()
        last_sample_error = None
        while not self.stop.is_set() or self.batch.active():
            try:
                command, client, deadline, future = self.commands.get_emergency_nowait()
            except queue.Empty:
                if self.batch.step():
                    try:
                        command, client, deadline, future = self.commands.get_nowait()
                    except queue.Empty:
                        command = None
                else:
                    try:
                        action_deadline = self.playback.next_deadline()
                        wake_at = min(next_sample, action_deadline) if action_deadline is not None else next_sample
                        command, client, deadline, future = self.commands.get(
                            timeout=max(0, wake_at - time.monotonic()))
                    except queue.Empty:
                        command = None
            if command is not None:
                if command["action"] in ("servo_debug", "send_action_frame") and not future.set_running_or_notify_cancel():
                    continue
                try:
                    if time.monotonic() > deadline:
                        raise TimeoutError("排队操作已过期，未执行")
                    if command["action"] == "servo_debug" and command["internal"]:
                        while self.batch.active():
                            if not self.batch.step():
                                raise RuntimeError("批量保存尚未完成，串口不能交回")
                    if (command["action"] in (WRITE_ACTIONS | {'scan_servo'}) - {"release_all", "servo_debug"}
                            or command["action"] == "servo_debug" and command["enabled"]) and not self.armed(client):
                        raise PermissionError("写操作已锁定，未执行")
                    if (command["action"] in (WRITE_ACTIONS | {'scan_servo', 'calibration_start', 'calibration_restore'}) - {"release_all", "servo_debug"}
                            or command["action"] == "servo_debug" and command["enabled"]):
                        with self.lock:
                            if command.get("_control_generation") != self.control_generation:
                                raise PermissionError("卸力前的排队操作已取消")
                    if self.batch.active() and command["action"] not in ("release_all", "save_parameters"):
                        raise RuntimeError("批量保存尚未完成，未执行排队操作")
                    if self.playback.active() and command["action"] in WRITE_ACTIONS | CALIBRATION_ACTIONS:
                        if command["action"] != "release_all" and not (command["action"] == "servo_debug" and not command["enabled"]):
                            raise RuntimeError("动作正在播放，未执行排队操作")
                    if command["action"] == "servo_debug":
                        if command["enabled"] and self.calibration.snapshot()["active"]:
                            raise PermissionError("标定中，舵机操作已暂停")
                        result = self._set_servo_debug(command["enabled"])
                    elif command["action"] == "release_all":
                        if self.calibration.snapshot()["active"]:
                            if not self.calibration_release_verified:
                                raise RuntimeError("标定期间无法确认舵机已卸力")
                            result = dict(verified=True, already_released=True, source="calibration")
                        else:
                            if self.hardware is None:
                                if self.hardware_factory is None:
                                    raise RuntimeError("串口未就绪，无法确认卸力")
                                self.hardware = self.hardware_factory()
                                self.hardware.set_imu_source(self.imu_source)
                                self.joints = self.hardware.joints
                            result = self.hardware.execute(command)
                    elif command["action"] in CALIBRATION_ACTIONS:
                        result = self.execute_calibration(command, client)
                    elif self.calibration.snapshot()["active"] or self.hardware is None:
                        raise PermissionError("标定中，舵机操作已暂停")
                    elif command["action"] == "home_targets":
                        result = dict(targets=pose_targets("home_all", self.hardware.ids, self.hardware.home_policy))
                    elif command["action"] == "start_action_playback":
                        with self.action_request_lock:
                            if command["generation"] != self.action_generation:
                                raise RuntimeError("动作播放请求已取消")
                            with self.lock:
                                self.maintenance_voltage_ready = False
                            result = self.playback.start(command["document"], client,
                                                         [joint["id"] for joint in self.joints],
                                                         command["loop"], command["locked_ids"])
                    elif command["action"] == "send_action_frame":
                        with self.action_request_lock:
                            if command["generation"] != self.action_generation:
                                raise RuntimeError("动作帧请求已取消")
                            if not self.armed(client):
                                raise PermissionError("写操作未解锁或已过期")
                            if self.playback.active():
                                raise RuntimeError("动作正在播放，请先停止")
                            targets = command["targets"]
                            with self.lock:
                                self.maintenance_voltage_ready = False
                            self.hardware.prepare_action_playback(list(targets))
                            result = self.hardware.move_action_frame(targets, command["duration_ms"])
                            if not result.get("sent"):
                                raise RuntimeError("动作帧未发送完成")
                            with self.lock:
                                self.pose_targets.update(targets)
                                self.maintenance_voltage_ready = False
                                self.maintenance_voltage_after = time.monotonic() + command["duration_ms"] / 1000
                    elif command["action"] == "save_parameters":
                        with self.lock:
                            self.maintenance_voltage_ready = False
                        self.batch.begin(self.hardware.parameter_batch(command, self.batch.check, self.batch.progress))
                        continue
                    else:
                        actual_command = command
                        if command["action"] in ("center_all", "home_all", "run_targets"):
                            unavailable = self.unavailable_servo_ids()
                            if unavailable:
                                ids = self.hardware.ids
                                values = (target_values(command.get("targets"), ids, 4096 if self.full_servo_range else 4095)
                                          if command["action"] == "run_targets" else
                                          pose_targets(command["action"], ids, self.hardware.home_policy))
                                actual_command = dict(action="run_targets", targets=[
                                    [device_id, None if device_id in unavailable else values.get(device_id)] for device_id in ids])
                        result = self.hardware.execute(actual_command)
                    if command["action"] == "set_imu_source":
                        self.imu_source = result["imu_source"]
                    if command["action"] in ("center_all", "home_all") and result.get("verified"):
                        with self.lock:
                            self.pose_targets.update(result["targets"])
                    elif command["action"] == "run_targets" and result.get("verified"):
                        with self.lock:
                            self.pose_targets.update(result["targets"])
                    elif command["action"] == "move_direct" and result.get("sent"):
                        with self.lock:
                            self.pose_targets[result["id"]] = result["target"]
                    if command["action"] == "registers":
                        result["registers"] = parse_registers(bytes(result["raw"]))
                    if command["action"] in WRITE_ACTIONS:
                        log = logging.debug if command["action"] in REALTIME_WRITE_ACTIONS else logging.info
                        log("command=%s result=%s", command, result)
                    future.set_result(result)
                except Exception as error:
                    future.set_exception(error)
            if self.playback.active() and self.hardware is not None:
                with self.lock:
                    self.maintenance_voltage_ready = False
                targets = self.playback.step(self.hardware)
                if targets:
                    with self.lock:
                        self.pose_targets.update(targets)
                if self.playback.active():
                    next_sample = time.monotonic() + 1 / self.hz
                    continue
            if self.calibration.snapshot()["active"]:
                with self.lock:
                    self.maintenance_voltage_ready = False
                self.stop.wait(.05)
                next_sample = time.monotonic()
                continue
            if time.monotonic() < next_sample:
                continue
            try:
                if self.hardware is None:
                    self.hardware = self.hardware_factory()
                    self.hardware.set_imu_source(self.imu_source)
                    self.joints = self.hardware.joints
                state = self.hardware.sample_imu() if self.imu_only else self.hardware.sample()
                self.sequence += 1
                self.failures += int(bool(state.get("errors")))
                state.update(sequence=self.sequence, timestamp_ms=int(time.time() * 1000),
                             sampled_monotonic=time.monotonic(), online=True,
                             hz=self.hz, failures=self.failures, individual_device_scan=True)
                voltage_ready = not self.batch.active() and time.monotonic() >= self.maintenance_voltage_after
                if last_sample_error is not None:
                    logging.info("sample recovered")
                    last_sample_error = None
            except Exception as error:
                self.playback.cancel("设备采集失败：" + str(error))
                self.failures += 1
                state = dict(online=False, imu=dict(valid=False), servos=[], error=str(error),
                             sequence=self.sequence, failures=self.failures, hz=self.hz,
                             timestamp_ms=int(time.time() * 1000), sampled_monotonic=time.monotonic())
                voltage_ready = False
                if str(error) != last_sample_error:
                    logging.warning("sample: %s", error)
                    last_sample_error = str(error)
            with self.lock:
                self.state = state
                self.maintenance_voltage_ready = voltage_ready
            period = 1 / self.hz
            next_sample += (int(max(0, time.monotonic() - next_sample) / period) + 1) * period
        try:
            self.calibration.close()
        finally:
            if self.hardware is not None:
                self.hardware.close()

    def close(self):
        with self.servo_debug_request_lock:
            with self.action_request_lock:
                self.action_generation += 1
                self.playback.cancel("服务关闭")
            if not self.stop.is_set():
                with self.lock:
                    needs_restore = self.servo_debug != "off" or bool(self.servo_debug_pending)
                if needs_restore:
                    self.batch.cancel("服务关闭")
                    self._queue_servo_debug(False, None, internal=True)
                self.stop.set()
            self.worker.join(timeout=8)
            if self.worker.is_alive():
                raise RuntimeError("维护任务尚未结束，串口不能交回")
            if self.calibration.process and self.calibration.process.poll() is None:
                raise RuntimeError("标定进程尚未退出，串口不能交回")
