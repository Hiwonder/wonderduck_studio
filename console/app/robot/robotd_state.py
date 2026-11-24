"""Read-only view of robotd's existing state stream; never opens a device bus."""

from copy import deepcopy
import json
import logging
import math
import secrets
import socket
import threading
import time

from app.robot.protocol import (
    JOINTS, REGISTERS, UNOQ_OPTIONAL_SERVO_IDS, discovered_joint, joint_id, raw_to_degrees, servo_faults,
)


READ_ONLY_MESSAGE = "robotd 只读模式：控制、配置和硬件读取操作已禁用"
MAX_LINE_BYTES = 1024 * 1024


def query_robotd(path, calls, timeout=1):
    """Query robotd without starting a state subscription."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(path))
        with connection.makefile("rwb") as stream:
            results = {}
            for index, (method, params) in enumerate(calls, 1):
                stream.write((json.dumps(dict(jsonrpc="2.0", id=index, method=method, params=params)) + "\n").encode())
                stream.flush()
                line = stream.readline(MAX_LINE_BYTES + 1)
                if not line or len(line) > MAX_LINE_BYTES:
                    raise ConnectionError("robotd 状态查询连接异常")
                reply = json.loads(line)
                if reply.get("id") != index or reply.get("error") is not None or not isinstance(reply.get("result"), dict):
                    raise ValueError(f"robotd {method} 查询失败：{reply.get('error')}")
                results[method] = reply["result"]
            return results


def vector(value, length, name):
    if (not isinstance(value, list) or len(value) != length or
            any(type(item) not in (int, float) or not math.isfinite(item) for item in value)):
        raise ValueError(f"robotd {name} 数据无效")
    return value


def encoder(angle):
    # Same HX coordinate convention as the runtime; reconstructed, not a register read.
    return round((math.pi - angle) * 4096 / math.tau)


def observed_time(value, now, name):
    if value is None:
        return None
    if type(value) is not int or not 0 < value <= now:
        raise ValueError(f"robotd {name} 时间无效")
    return value / 1e9


def device_observation(row, now):
    if not isinstance(row, dict) or type(row.get("valid")) is not bool:
        raise ValueError("robotd 设备状态无效")
    sampled = observed_time(row.get("t_ns"), now, "采样")
    observed = observed_time(row.get("observed_t_ns"), now, "读取")
    error = row.get("error")
    if error is not None and not isinstance(error, str):
        raise ValueError("robotd 设备错误信息无效")
    if row["valid"] and (sampled is None or observed is None or error is not None):
        raise ValueError("robotd 有效设备缺少采样时间")
    if not row["valid"] and sampled is not None:
        raise ValueError("robotd 无效设备包含采样时间")
    return sampled, observed, error


def optional_servo_observations(rows, now):
    result = {}
    if not isinstance(rows, list):
        return []
    for row in rows:
        if not isinstance(row, dict) or row.get("id") not in UNOQ_OPTIONAL_SERVO_IDS:
            continue
        raw = row.get("raw")
        if row.get("valid") is not True or type(raw) is not int or not 0 <= raw <= 4095:
            continue
        try:
            sampled, _, _ = device_observation(row, now)
        except ValueError:
            continue
        item = dict(id=row["id"], online=True, valid=True, raw=raw,
                    degrees=raw_to_degrees(raw), sampled_monotonic=sampled)
        for key in ("speed_rad_s", "load_percent", "voltage", "temperature"):
            value = row.get(key)
            if type(value) in (int, float) and math.isfinite(value):
                item[key] = value
        result[row["id"]] = item
    return list(result.values())


def device_configuration(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("舵机固定参数无效")
    for key, length in (("firmware_version", 2), ("servo_version", 2), ("position_pid", 3)):
        values = value.get(key)
        if (not isinstance(values, list) or len(values) != length
                or any(type(item) is not int or not 0 <= item <= 255 for item in values)):
            raise ValueError(f"舵机 {key} 无效")
    if (type(value.get("overtemperature_c")) is not int or not 0 <= value["overtemperature_c"] <= 255
            or type(value.get("minimum_starting_torque")) is not int
            or not 0 <= value["minimum_starting_torque"] <= 65535):
        raise ValueError("舵机固定参数无效")
    return {key: value[key] for key in ("firmware_version", "servo_version", "position_pid",
                                        "overtemperature_c", "minimum_starting_torque")}


def raw_imu_observation(value, now):
    if not isinstance(value, dict):
        raise ValueError("IMU 原始采样格式无效")
    sampled = observed_time(value.get("t_ns"), now, "IMU 原始采样")
    sequence = value.get("sequence")
    if sampled is None or type(sequence) is not int or not 0 <= sequence <= 0xffffffff:
        raise ValueError("IMU 原始采样时间或序号无效")
    flags = ("ready", "accel_calibrated", "gyro_calibrated")
    if any(type(value.get(key)) is not bool for key in flags):
        raise ValueError("IMU 原始采样状态无效")
    result = dict(frame="sensor", sampled_monotonic=sampled, timestamp_ms=sampled * 1000,
                  sequence=sequence, **{key: value[key] for key in flags})
    for key in ("raw_g", "corrected_g", "gyro_rad_s", "raw_gyro_rad_s"):
        result[key] = vector(value.get(key), 3, "imu." + key)
    result["corrected_gyro_rad_s"] = result["gyro_rad_s"]
    return result


class RobotdController:
    readonly = True
    demo = False
    full_servo_range = False
    imu_source = "robotd"

    def __init__(self, path, hz, include_details=False, *, tof_enabled=True):
        self.path, self.hz = str(path), hz
        self.tof_enabled = tof_enabled
        self.joints = deepcopy(JOINTS)
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.stream_suspended = threading.Event()
        self.devices_enabled = threading.Event()
        self.devices_refresh = threading.Event()
        self.devices_generation = 0
        self.connection = None
        self.devices_connection = None
        self.details = {}
        self.devices = None
        self.devices_received_at = None
        self.state = dict(online=False, imu=dict(valid=False), servos=[], pose_targets={},
                          sequence=0, failures=0, sampled_monotonic=0,
                          error=f"等待 robotd：{self.path}", read_ms=None)
        self.worker = threading.Thread(target=self.run, name="robotd-state", daemon=True)
        self.worker.start()
        self.devices_worker = threading.Thread(target=self.run_devices, name="robotd-devices", daemon=True)
        self.devices_worker.start()
        self.details_worker = None
        if include_details:
            self.details_worker = threading.Thread(target=self.read_details, name="robotd-details", daemon=True)
            self.details_worker.start()

    def snapshot(self, client, *, include_devices=False):
        with self.lock:
            state = deepcopy(self.state)
            details = deepcopy(self.details)
            devices = deepcopy(self.devices)
            devices_received_at = self.devices_received_at
            devices_connected = self.devices_connection is not None
        if include_devices and self.devices_enabled.is_set():
            # Keep the common sidebar tied to the unchanged control stream, so
            # entering the status page does not replace its connection/voltage source.
            state.update(control_online=state["online"], control_error=state["error"],
                         control_servos=state["servos"])
            if devices is None:
                state.update(imu=dict(valid=False, error="等待逐项采集"),
                             servos=[dict(joint, online=False, valid=False, error="等待逐项采集")
                                     for joint in self.joints], device_report_age_ms=None)
            else:
                state.update(devices)
                state["device_report_age_ms"] = round((time.monotonic() - devices_received_at) * 1000)
                if devices_connected:
                    state.update(online=True, error=None)
        joints = deepcopy(self.joints)
        if state.get("online") and devices_connected and not state.get("bus_waiting"):
            now = time.monotonic()
            for servo in sorted(state.get("optional_servos", ()), key=lambda item: item["id"]):
                if not 0 <= now - servo["sampled_monotonic"] < 3:
                    continue
                joint = discovered_joint(servo["id"])
                joints.append(joint)
                state["servos"].append({**joint, **servo})
        sampled = details.pop("sampled_monotonic", None)
        if sampled is not None and time.monotonic() - sampled < 2:
            state.update(details)
            if state.get("tof"):
                state["tof"]["age_ms"] += round((time.monotonic() - sampled) * 1000)
        else:
            state["robot"] = {}
            if self.tof_enabled:
                state["tof"] = dict(status="stale", valid=False, distance_mm=None,
                                    error="robotd 状态未更新", age_ms=None)
        state.update(joints=joints, hz=self.hz, armed=False, demo=False,
                     readonly=True, imu_source=self.imu_source, parameter_batch_active=False,
                     calibration=dict(active=False, waiting=False, message="robotd 只读模式"))
        return state

    def arm(self, client, on):
        raise PermissionError(READ_ONLY_MESSAGE)

    def parameter_task(self, command, client):
        raise PermissionError(READ_ONLY_MESSAGE)

    def submit(self, command, client):
        if command.get("action") != "registers":
            raise PermissionError(READ_ONLY_MESSAGE)
        joint_id(command.get("id"))
        # The stream does not publish register blocks. Do not invent register values
        # from angles or trigger fresh reads just because a browser selects a row.
        return dict(registers=[dict(item, writable=False, value=None, raw_value=None)
                               for item in REGISTERS], raw=None,
                    notice="robotd 未发布寄存器配置；只读模式不额外读取硬件")

    def accept(self, frame):
        if not isinstance(frame, dict):
            raise ValueError("robotd 状态必须为对象")
        captured_ns = frame.get("t_ns")
        if type(captured_ns) is not int or not 0 < captured_ns <= time.monotonic_ns():
            raise ValueError("robotd 缺少有效采样时间")
        count = len(self.joints)
        positions = vector(frame.get("joints"), count, "joints")
        targets = vector(frame.get("targets"), count, "targets")
        velocities = frame.get("velocities", [])
        if velocities != []:
            vector(velocities, count, "velocities")
        servo_status = frame.get("servo_status", [])
        if not isinstance(servo_status, list) or len(servo_status) not in (0, count):
            raise ValueError("robotd 舵机状态数量无效")
        servos = []
        for index, joint in enumerate(self.joints):
            angle = positions[index]
            item = dict(joint, online=True, valid=True, raw=encoder(angle),
                               radians=angle, degrees=math.degrees(angle),
                               speed_rad_s=velocities[index] if velocities else None,
                               load_percent=None, voltage=None, temperature=None,
                               torque=None, moving=None, status=None, faults=None,
                               diagnostics_available=False, encoder_reconstructed=True,
                               sampled_monotonic=captured_ns / 1e9,
                               observed_monotonic=captured_ns / 1e9)
            if servo_status:
                measured = servo_status[index]
                if not isinstance(measured, dict) or type(measured.get("raw")) is not int or not 0 <= measured["raw"] <= 4095:
                    raise ValueError("robotd 舵机编码器无效")
                for key in ("load_percent", "voltage", "temperature"):
                    if type(measured.get(key)) not in (int, float) or not math.isfinite(measured[key]):
                        raise ValueError(f"robotd 舵机 {key} 无效")
                if any(type(measured.get(key)) is not int or not 0 <= measured[key] <= 255
                       for key in ("packet_status", "register_status")) or type(measured.get("moving")) is not bool:
                    raise ValueError("robotd 舵机故障状态无效")
                status = measured["packet_status"] | measured["register_status"]
                item.update(raw=measured["raw"], load_percent=measured["load_percent"],
                            voltage=measured["voltage"], temperature=measured["temperature"],
                            moving=measured["moving"], packet_status=measured["packet_status"],
                            register_status=measured["register_status"], status=status,
                            faults=servo_faults(status), diagnostics_available=True,
                            encoder_reconstructed=False)
            servos.append(item)
        source_imu = frame.get("imu")
        imu = dict(valid=False, error="robotd 未发布 IMU")
        if source_imu is not None:
            if not isinstance(source_imu, dict):
                raise ValueError("robotd IMU 数据无效")
            quat = vector(source_imu.get("quat"), 4, "imu.quat")
            if not .5 < sum(item * item for item in quat) < 1.5:
                raise ValueError("robotd IMU 四元数无效")
            gyro = vector(source_imu.get("gyro"), 3, "imu.gyro")
            safety = frame.get("safety")
            if not isinstance(safety, dict):
                raise ValueError("robotd safety 数据无效")
            gravity = vector(safety.get("gravity"), 3, "safety.gravity")
            imu = dict(valid=True, quaternion_wxyz=quat, gyro_rad_s=gyro, gravity=gravity,
                       t_ns=captured_ns, sampled_monotonic=captured_ns / 1e9,
                       observed_monotonic=captured_ns / 1e9)
        with self.lock:
            previous_ns = self.state.get("t_ns")
            self.state.update(online=True, imu=imu, servos=servos, error=None,
                              pose_targets={joint["id"]: encoder(targets[i])
                                            for i, joint in enumerate(self.joints)},
                              sequence=self.state["sequence"] + (captured_ns != previous_ns),
                              sampled_monotonic=captured_ns / 1e9, t_ns=captured_ns,
                              policy=frame.get("policy"), control_loop=frame.get("loop"),
                              safety=frame.get("safety"), movement=frame.get("move"))

    def accept_devices(self, frame, generation=None):
        """Update device observations independently from complete control frames."""
        if not isinstance(frame, dict) or not isinstance(frame.get("servos"), list):
            raise ValueError("robotd 设备状态必须包含舵机列表")
        now = time.monotonic_ns()
        rows = frame["servos"]
        expected = {joint["id"] for joint in self.joints}
        if (any(not isinstance(row, dict) or type(row.get("id")) is not int for row in rows)
                or len(rows) != len(expected) or {row["id"] for row in rows} != expected):
            raise ValueError("robotd 舵机状态 ID 不匹配")
        by_id = {row["id"]: row for row in rows}
        servos = []
        for joint in self.joints:
            row = by_id[joint["id"]]
            try:
                sampled, observed, error = device_observation(row, now)
                item = dict(joint, online=row["valid"], valid=row["valid"],
                            error=error, sampled_monotonic=sampled, observed_monotonic=observed,
                            diagnostics_available=True, torque=None, faults=[], status=None)
                if row["valid"]:
                    raw = row.get("raw")
                    if type(raw) is not int or not 0 <= raw <= 4095:
                        raise ValueError("robotd 舵机编码器无效")
                    for key in ("speed_rad_s", "load_percent", "voltage", "temperature"):
                        if type(row.get(key)) not in (int, float) or not math.isfinite(row[key]):
                            raise ValueError(f"robotd 舵机 {key} 无效")
                    if (any(type(row.get(key)) is not int or not 0 <= row[key] <= 255
                            for key in ("packet_status", "register_status"))
                            or type(row.get("moving")) is not bool):
                        raise ValueError("robotd 舵机故障状态无效")
                    degrees = raw_to_degrees(raw)
                    status = row["packet_status"] | row["register_status"]
                    item.update(raw=raw, degrees=degrees, radians=math.radians(degrees),
                                speed_rad_s=row["speed_rad_s"], load_percent=row["load_percent"],
                                voltage=row["voltage"], temperature=row["temperature"],
                                packet_status=row["packet_status"], register_status=row["register_status"],
                                moving=row["moving"], status=status, faults=servo_faults(status),
                                encoder_reconstructed=False)
                    torque = row.get("torque")
                    if torque is not None and (type(torque) is not int or not 0 <= torque <= 255):
                        raise ValueError("robotd 舵机扭矩状态无效")
                    item["torque"] = torque
            except ValueError as error:
                item = dict(joint, online=True, valid=False, error=str(error), faults=[], status=None,
                            sampled_monotonic=None, observed_monotonic=now / 1e9)
            try:
                item["configuration"] = device_configuration(row.get("configuration"))
                config_error = row.get("configuration_error")
                if config_error is not None and not isinstance(config_error, str):
                    raise ValueError("舵机固定参数错误信息无效")
                item["configuration_error"] = config_error
            except ValueError as error:
                item["configuration"] = None
                item["configuration_error"] = str(error)
            servos.append(item)

        try:
            row = frame.get("imu")
            sampled, observed, error = device_observation(row, now)
            imu = dict(valid=row["valid"], error=error, sampled_monotonic=sampled,
                       observed_monotonic=observed, t_ns=row.get("t_ns"))
            if row["valid"]:
                quat = vector(row.get("quaternion_wxyz"), 4, "imu.quaternion_wxyz")
                if not .5 < sum(value * value for value in quat) < 1.5:
                    raise ValueError("robotd IMU 四元数无效")
                imu.update(quaternion_wxyz=quat, gyro_rad_s=vector(row.get("gyro_rad_s"), 3, "imu.gyro_rad_s"),
                           gravity=vector(row.get("gravity"), 3, "imu.gravity"))
                if row.get("raw_sample") is not None:
                    try:
                        imu["raw_sample"] = raw_imu_observation(row["raw_sample"], now)
                    except ValueError as error:
                        imu["raw_sample_error"] = str(error)
        except ValueError as error:
            imu = dict(valid=False, error=str(error), sampled_monotonic=None, observed_monotonic=now / 1e9)
        with self.lock:
            if generation is not None and (generation != self.devices_generation
                    or not self.devices_enabled.is_set() or self.stream_suspended.is_set()):
                return
            bus_error = frame.get("bus_error")
            if bus_error is not None and not isinstance(bus_error, str):
                raise ValueError("robotd 总线故障信息无效")
            self.devices = dict(imu=imu, servos=servos, bus_waiting=bus_error,
                                optional_servos=optional_servo_observations(frame.get("optional_servos"), now))
            self.devices_received_at = now / 1e9

    def query(self, calls, timeout=1):
        return query_robotd(self.path, calls, timeout=timeout)

    def read_details(self):
        calls = (("robot.health", {}), ("robot.mode", {}),
                 ("robot.lowVoltageStatus", {}),
                 ("robot.humanControl", {"action": "status", "source": "web"}))
        if self.tof_enabled:
            calls += (("robot.obstacleStatus", {}),)
        previous_error = None
        while not self.stop.is_set():
            try:
                result = self.query(calls)
                details = dict(robot=dict(health=result["robot.health"], mode=result["robot.mode"],
                                          control=result["robot.humanControl"],
                                          low_voltage=result["robot.lowVoltageStatus"]))
                if self.tof_enabled:
                    obstacle = result["robot.obstacleStatus"]
                    status = obstacle.get("sensor_status")
                    mapped = {"valid": "ok", "out_of_range": "out_of_range", "unavailable": "not_detected",
                              "error": "communication_error", "filtering": "starting", "invalid": "invalid_data",
                              "unknown": "stale"}.get(status)
                    if mapped is None:
                        raise ValueError(f"robotd TOF 状态无效：{status}")
                    distance = obstacle.get("distance_mm")
                    if mapped == "ok" and (type(distance) is not int or not 20 <= distance <= 2500):
                        raise ValueError("robotd TOF 距离无效")
                    details["tof"] = dict(status=mapped, valid=mapped == "ok", distance_mm=distance,
                                          error=None, age_ms=800)
                with self.lock:
                    self.details = dict(details, sampled_monotonic=time.monotonic())
                previous_error = None
            except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
                if str(error) != previous_error:
                    logging.warning("robotd 状态详情不可用：%s", error)
                    previous_error = str(error)
            self.stop.wait(.5)

    def set_stream_suspended(self, suspended):
        if suspended:
            self.stream_suspended.set()
            with self.lock:
                self.devices_generation += 1
                self.devices = None
                self.devices_received_at = None
                if self.devices_connection is not None:
                    try:
                        self.devices_connection.shutdown(socket.SHUT_RDWR)
                    except OSError as error:
                        logging.debug("维护期间设备状态订阅已关闭：%s", error)
        else:
            self.stream_suspended.clear()

    def set_devices_enabled(self, enabled):
        """Enable the extra device subscription only while a status page is open."""
        with self.lock:
            if enabled == self.devices_enabled.is_set():
                return
            self.devices_generation += 1
            self.devices = None
            self.devices_received_at = None
            if enabled:
                self.devices_enabled.set()
            else:
                self.devices_enabled.clear()
                self.devices_refresh.clear()
                if self.devices_connection is not None:
                    try:
                        self.devices_connection.shutdown(socket.SHUT_RDWR)
                    except OSError as error:
                        logging.debug("设备状态订阅已关闭：%s", error)

    def refresh_devices(self):
        if self.devices_enabled.is_set():
            self.devices_refresh.set()

    def receive(self, connection, devices=False, generation=None):
        params = dict(hz=self.hz)
        if devices:
            params["devices"] = True
            self.devices_refresh.clear()
        request = (json.dumps(dict(jsonrpc="2.0", id=1, method="robot.subscribe",
                                   params=params)) + "\n").encode()
        connection.sendall(request)
        pending = bytearray()
        last_received = time.monotonic()
        while not self.stop.is_set() and (not devices or self.devices_enabled.is_set()):
            if devices and self.devices_refresh.is_set():
                self.devices_refresh.clear()
                connection.sendall(request)
            try:
                data = connection.recv(65536)
            except socket.timeout:
                if self.stream_suspended.is_set():
                    last_received = time.monotonic()
                    continue
                if time.monotonic() - last_received > 3:
                    raise TimeoutError("robotd 状态订阅超时")
                continue
            if not data:
                raise ConnectionError("robotd 状态订阅已断开")
            last_received = time.monotonic()
            pending.extend(data)
            while b"\n" in pending:
                line, _, remaining = pending.partition(b"\n")
                pending = bytearray(remaining)
                if len(line) > MAX_LINE_BYTES:
                    raise ValueError("robotd 状态帧过大")
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError("robotd 消息必须为对象")
                if message.get("error") is not None:
                    raise ValueError(f"robotd 订阅失败：{message['error']}")
                if message.get("method") == "robot.state" and not devices:
                    self.accept(message.get("params"))
                elif message.get("method") == "robot.devices" and devices and self.devices_enabled.is_set():
                    self.accept_devices(message.get("params"), generation)
            if len(pending) > MAX_LINE_BYTES:
                raise ValueError("robotd 状态帧过大")

    def run(self):
        previous_error = None
        while not self.stop.is_set():
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(1)
                    with self.lock:
                        self.connection = connection
                    connection.connect(self.path)
                    logging.debug("robotd 只读订阅 socket=%s hz=%s；不打开舵机或 IMU 总线", self.path, self.hz)
                    self.receive(connection)
            except (OSError, ValueError, TypeError, KeyError) as error:
                if self.stop.is_set():
                    break
                message = str(error)
                with self.lock:
                    self.state.update(online=False, error=message,
                                      failures=self.state["failures"] + 1)
                if message != previous_error:
                    logging.warning("robotd 只读订阅未就绪：%s", message)
                    previous_error = message
            finally:
                with self.lock:
                    self.connection = None
            self.stop.wait(1)

    def run_devices(self):
        previous_error = None
        while not self.stop.is_set():
            if not self.devices_enabled.wait(.5) or self.stop.is_set():
                continue
            if self.stream_suspended.is_set():
                self.stop.wait(.1)
                continue
            owned_connection = None
            generation = None
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(1)
                    connection.connect(self.path)
                    with self.lock:
                        if not self.devices_enabled.is_set() or self.stream_suspended.is_set():
                            continue
                        self.devices_connection = connection
                        owned_connection = connection
                        generation = self.devices_generation
                    self.receive(connection, devices=True, generation=generation)
                    previous_error = None
            except (OSError, ValueError, TypeError, KeyError) as error:
                if (self.devices_enabled.is_set() and not self.stream_suspended.is_set()
                        and not self.stop.is_set() and str(error) != previous_error):
                    logging.warning("robotd 设备状态订阅未就绪：%s", error)
                    previous_error = str(error)
            finally:
                with self.lock:
                    if owned_connection is not None and self.devices_connection is owned_connection:
                        self.devices_connection = None
                        if generation == self.devices_generation:
                            self.devices = None
                            self.devices_received_at = None
            if self.devices_enabled.is_set() and not self.stream_suspended.is_set():
                self.stop.wait(1)

    def close(self):
        self.stop.set()
        self.devices_enabled.set()
        with self.lock:
            if self.connection is not None:
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError as error:
                    logging.debug("robotd 订阅连接已关闭：%s", error)
            if self.devices_connection is not None:
                try:
                    self.devices_connection.shutdown(socket.SHUT_RDWR)
                except OSError as error:
                    logging.debug("robotd 设备状态连接已关闭：%s", error)
        self.worker.join(timeout=3)
        self.devices_worker.join(timeout=3)
        if self.details_worker is not None:
            self.details_worker.join(timeout=3)
