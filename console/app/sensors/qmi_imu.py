"""Independent, on-demand I2C3 raw IMU acquisition for the status workspace."""

import importlib.util
import json
import logging
import math
import os
from collections import deque
from pathlib import Path
import signal
import struct
import subprocess
import sys
import threading
import time

from app.paths import CONSOLE_ROOT
from app.sensors.qmi_calibration import HeadCalibration, ProfileStore
from app.sensors.qmi_config import (
    ACCEL_FULL_SCALE_G, ACTIVE_CONFIG, GYRO_FULL_SCALE_DPS,
    LEGACY_ACTIVE_CONFIG, LEGACY_ASYNC_CONFIG,
)


BUS_PATH = "/dev/i2c-3"
ADDRESS = int(os.environ.get("WONDERDUCK_HEAD_IMU_ADDRESS", "0x6a"), 0)
RESET_CONFIG = bytes.fromhex("20 00 00 00 00 00 00")
STATUSINT = 0x2d
CTRL7 = 0x08
CTRL9 = 0x0a
CAL1_L = 0x0b
GYRO_Z_HIGH = 0x40
COMMAND_TIMEOUT = .25
LOCK_TIMEOUT = .02
LOCK_DELAY = .000006  # QMI8658 ODR 3, both sensors enabled.
STALE_SECONDS = .5
CLIENT_TIMEOUT = 3.0
SUBSCRIPTION_VERSION_TIMEOUT = 30.0
RECOVERY_NO_SAMPLE_SECONDS = 3.0
RECOVERY_INITIAL_DELAY = .5
RECOVERY_MAX_DELAY = 10.0
RECOVERY_STABLE_SECONDS = 10.0
WORKER_RETRY_INITIAL_DELAY = .1
WORKER_RETRY_MAX_DELAY = 1.0
DIAGNOSTIC_INTERVAL = 10.0


class ConfigurationError(RuntimeError):
    pass


class SaturatedError(RuntimeError):
    def __init__(self, raw):
        labels = ("加速度 X", "加速度 Y", "加速度 Z", "陀螺仪 X", "陀螺仪 Y", "陀螺仪 Z")
        self.axes = [labels[i] for i, value in enumerate(raw) if value in (-32768, 32767)]
        self.raw = list(raw)
        super().__init__("I2C3 IMU 读数达到量程上限（" + "、".join(self.axes) + "）")


def known_configurations():
    # These are the only configurations produced by the previous sampler and
    # the successive writes in its initialization, or our synchronized mode.
    # Accepting interrupted initialization lets the next worker recover after
    # SIGKILL without taking over an unrelated sensor configuration.
    legacy = {RESET_CONFIG, LEGACY_ACTIVE_CONFIG, LEGACY_ASYNC_CONFIG}
    current = bytearray(RESET_CONFIG)
    for index, value in enumerate(LEGACY_ASYNC_CONFIG):
        current[index] = value
        legacy.add(bytes(current))
    for ctrl7 in (0x00, 0x80):
        legacy.add(LEGACY_ACTIVE_CONFIG[:-1] + bytes([ctrl7]))
    result = legacy | {ACTIVE_CONFIG}
    # Accept every complete register write from a previous interrupted upgrade.
    for previous in legacy:
        current = bytearray(previous)
        current[-1] = 0
        result.add(bytes(current))
        for index, value in enumerate(ACTIVE_CONFIG[:-1]):
            current[index] = value
            result.add(bytes(current))
    return result


KNOWN_CONFIGURATIONS = known_configurations()


def load_probe():
    path = CONSOLE_ROOT / "reference/imu-i2c-probe.py"
    spec = importlib.util.spec_from_file_location("qmi_probe", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 IMU 传输模块：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require_unbound_sensor():
    if os.environ.get("WONDERDUCK_UNOQ_ROUTER"):
        return
    if Path("/sys/bus/i2c/devices/3-006a").exists():
        raise ConfigurationError("I2C3 IMU 已绑定内核驱动，不能访问")


class QmiSampler:
    def __init__(self, probe=None, hz=20, binding_check=require_unbound_sensor, profile_store=None):
        self.probe = probe or load_probe()
        self.binding_check = binding_check
        self.profile_store = profile_store or ProfileStore()
        self.profile_revision = None
        # Permit one missed 20 Hz sample plus jitter while keeping a strict
        # bound below the 500 ms stale timeout.
        self.interpolation_gap = max(.1, 2 / hz)
        self.max_gap = min(.25, max(.15, 3 / hz))
        self.device = None
        self.owns_device = False
        self.attitude = self.probe.Attitude(max_gap=self.max_gap)
        self.previous_clock = None
        self.previous_time = None
        self.previous_gyro = None
        self.note = None
        self.reset_count = 0
        self.reset_pending = False
        self.has_published = False
        self.last_diagnostic = {}

    def _timed(self, name, operation, *args):
        started = time.monotonic()
        try:
            return operation(*args)
        finally:
            self.last_diagnostic[name + "_ms"] = round((time.monotonic() - started) * 1000, 2)

    def _configuration(self):
        # Auto-increment is disabled after a sensor reset; the configuration
        # must be read one register at a time until CTRL1 has been initialized.
        identity = self.device.read(0)[0]
        if identity != 0x05:
            raise ConfigurationError(f"I2C3 IMU 身份无效：0x{identity:02x}")
        control = self.device.read(2)[0]
        tail = (self.device.read(3, 6) if control & 0x40
                else bytes(self.device.read(register)[0] for register in range(3, 9)))
        return bytes([control]) + tail

    def _await_command(self, done):
        deadline = time.monotonic() + COMMAND_TIMEOUT
        while bool(self.device.read(STATUSINT)[0] & 0x80) != done:
            if time.monotonic() >= deadline:
                raise RuntimeError("I2C3 IMU 命令握手超时")
            time.sleep(.002)

    def _known_command(self):
        pending = self.device.read(CTRL9)[0]
        if pending not in (0, 0x12):
            raise ConfigurationError(f"I2C3 IMU 有其他命令正在执行：0x{pending:02x}")
        return pending

    def _finish_known_command(self):
        pending = self._known_command()
        if pending == 0x12:
            # A previous worker died during this same command. Wait for its
            # completion before acknowledging; overwriting an in-flight
            # command would leave the clock-gating state uncertain.
            self._await_command(True)
            self.device.write(CTRL9, 0x00)
            self._await_command(False)
        elif pending == 0:
            self._await_command(False)

    def _set_clock_gating(self, enabled):
        # Sensors must already be disabled: STATUSINT reads otherwise initiate
        # a sample lock when SyncSample is active.
        self._finish_known_command()
        self.device.write(CAL1_L, 0x00 if enabled else 0x01)
        self.device.write(CTRL9, 0x12)
        self._await_command(True)
        self.device.write(CTRL9, 0x00)
        self._await_command(False)

    def _release_lock(self):
        # Reading GZ_H releases the six-axis lock, including after a failed
        # partial data transfer or an interrupted previous worker.
        self.device.read(GYRO_Z_HIGH)

    def open(self):
        self.binding_check()
        if os.environ.get("WONDERDUCK_UNOQ_ROUTER"):
            from unoq_io import HeadImu
            self.device = HeadImu(ADDRESS)
        else:
            self.device = self.probe.I2cDevice(BUS_PATH, ADDRESS)
        try:
            config = self._configuration()
            if config not in KNOWN_CONFIGURATIONS:
                raise ConfigurationError(f"I2C3 IMU 配置不匹配：{config.hex(' ')}")
            self.binding_check()
            if self._configuration() != config:
                raise ConfigurationError("I2C3 IMU 初始化前状态已改变")
            self._known_command()
            self.owns_device = True
            # Finish an interrupted handshake before writing any sensor setup
            # registers; partial initialization can itself be a restart state.
            self._finish_known_command()
            # An old worker may have died while the shadow registers were
            # locked or a command was pending. Disabling the sensors and
            # repeating the complete handshake makes startup idempotent.
            self._release_lock()
            self.device.write(CTRL7, 0x00)
            for register, value in enumerate(ACTIVE_CONFIG[:-1], 0x02):
                if config[register - 0x02] != value:
                    self.device.write(register, value)
            self._set_clock_gating(False)
            self.device.write(CTRL7, 0x83)
            if self._configuration() != ACTIVE_CONFIG:
                raise ConfigurationError("I2C3 IMU 同步采样配置回读失败")
            time.sleep(.05)
        except BaseException:
            self.close()
            raise

    def sample(self):
        self.last_diagnostic = {"outcome": "error"}
        if self.device is None:
            self._timed("open", self.open)
        self._timed("binding", self.binding_check)
        header = self._timed("header", self.device.read, 0, 9)
        if header[0] != 0x05 or header[2:9] != ACTIVE_CONFIG:
            raise ConfigurationError("I2C3 IMU 身份或配置已改变")
        # Reading STATUSINT starts the shadow-register lock. Unlike an ordinary
        # burst, this keeps all six axes from changing during a slow I2C read.
        try:
            status = self._timed("status", self.device.read, STATUSINT)[0]
        except BaseException:
            # The transfer may have reached the device even if it failed on
            # the host; conservatively release any lock it started.
            try:
                self._release_lock()
            except (OSError, RuntimeError):
                pass
            raise
        if status & 1 == 0:
            if status & 2:
                # Recover an orphaned lock before waiting for the next sample.
                self._release_lock()
            self.last_diagnostic["outcome"] = "not_ready"
            return None
        released = False
        try:
            if status & 2 == 0:
                time.sleep(LOCK_DELAY)
                deadline = time.monotonic() + LOCK_TIMEOUT
                while not self._timed("lock", self.device.read, STATUSINT)[0] & 2:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("I2C3 IMU 采样锁定超时")
                    time.sleep(LOCK_DELAY)
            # The sample clock can cross a byte carry; read it coherently even
            # if it is not itself part of the shadowed sensor-data registers.
            counter_high_before = self._timed("counter_before", self.device.read, 0x31, 2)
            counter = self._timed("counter", self.device.read, 0x30, 3)
            counter_high_after = self._timed("counter_after", self.device.read, 0x31, 2)
            if counter[1:] != counter_high_before or counter[1:] != counter_high_after:
                self.last_diagnostic["outcome"] = "counter_unstable"
                return None
            data = self._timed("burst", self.device.read, 0x35, 12)
            released = True  # The burst ended at GZ_H and releases the lock.
        finally:
            if not released:
                try:
                    self._release_lock()
                except (OSError, RuntimeError):
                    # open() always clears a lock again on the next attempt.
                    pass
        clock = int.from_bytes(counter, "little")
        if self.previous_clock is not None:
            delta = (clock - self.previous_clock) & 0xffffff
            if delta == 0:
                self.last_diagnostic["outcome"] = "duplicate_clock"
                return None
            if delta > 0x800000:
                raise RuntimeError("I2C3 IMU 采样时钟重置")
        raw = struct.unpack("<6h", data)
        if any(value in (-32768, 32767) for value in raw):
            raise SaturatedError(raw)
        now = time.monotonic()
        reset = self.previous_time is not None and now - self.previous_time > self.max_gap
        if reset:
            self.reset_attitude("采样间断，航向已重新置零")
        raw_g = [value * ACCEL_FULL_SCALE_G / 32768 for value in raw[:3]]
        raw_gyro = [math.radians(value * GYRO_FULL_SCALE_DPS / 32768) for value in raw[3:]]
        try:
            profile = self._timed("profile", self.profile_store.load)
        except (OSError, ValueError) as error:
            self.last_diagnostic["outcome"] = "profile_error"
            self.reset_attitude("标定文件无效，航向已重新置零")
            self.profile_revision = None
            self.previous_clock, self.previous_time = clock, now
            return dict(valid=False, status="calibration_error", error=str(error), sampled_monotonic=now,
                        sample=dict(frame="sensor", timestamp_ms=int(time.time() * 1000), sequence=clock,
                                    age_us=0, raw_g=raw_g, corrected_g=raw_g,
                                    gyro_rad_s=raw_gyro, corrected_gyro_rad_s=raw_gyro,
                                    raw_gyro_rad_s=raw_gyro,
                                    accel_calibrated=False, gyro_calibrated=False),
                        accel_calibrated=False, gyro_calibrated=False, reset_count=self.reset_count)
        if self.profile_revision is not None and self.profile_revision != profile["revision"]:
            self.reset_attitude("校准参数变化，航向已重新置零")
        self.profile_revision = profile["revision"]
        accel_config, gyro_config = profile["accel"], profile["gyro"]
        corrected_g = ([(raw_g[i] - accel_config["bias_g"][i]) * accel_config["scale"][i] for i in range(3)]
                       if accel_config else raw_g)
        gyro_rad = ([raw_gyro[i] - gyro_config["bias_rad_s"][i] for i in range(3)]
                    if gyro_config else raw_gyro)
        sample = dict(frame="sensor", timestamp_ms=int(time.time() * 1000), sequence=clock, age_us=0,
                      raw_g=raw_g, corrected_g=corrected_g, gyro_rad_s=gyro_rad,
                      corrected_gyro_rad_s=gyro_rad, raw_gyro_rad_s=raw_gyro,
                      accel_calibrated=accel_config is not None,
                      gyro_calibrated=gyro_config is not None)
        gap = now - self.previous_time if self.previous_time is not None else None
        estimate_gyro = ([(old + new) / 2 for old, new in zip(self.previous_gyro, gyro_rad)]
                         if gap is not None and gap > self.interpolation_gap and self.previous_gyro is not None
                         else gyro_rad)
        self.attitude.update([value * 9.80665 for value in corrected_g],
                             [math.degrees(value) for value in estimate_gyro], now)
        self.previous_clock, self.previous_time = clock, now
        self.previous_gyro = gyro_rad
        self.last_diagnostic["outcome"] = "sample"
        if self.attitude.q is None:
            return dict(valid=False, status="starting", error="等待有效重力方向", sampled_monotonic=now,
                        sample=sample, profile_revision=self.profile_revision,
                        accel_calibrated=accel_config is not None, gyro_calibrated=gyro_config is not None,
                        reset_count=self.reset_count)
        w, x, y, z = self.attitude.q
        gravity = [-2 * (x*z - w*y), -2 * (y*z + w*x), -(1 - 2 * (x*x + y*y))]
        self.has_published = True
        self.reset_pending = False
        return dict(valid=True, status="ok", error=None, sampled_monotonic=now,
                    rpy_deg=self.attitude.rpy(), gyro_rad_s=gyro_rad, sample=sample,
                    profile_revision=self.profile_revision, accel_calibrated=accel_config is not None,
                    gyro_calibrated=gyro_config is not None,
                    gravity=gravity, quaternion_wxyz=self.attitude.q, sensor_clock=clock,
                    note=self.note, reset_count=self.reset_count)

    def reset_attitude(self, note):
        if self.has_published:
            if not self.reset_pending:
                self.reset_count += 1
            self.reset_pending = True
            self.note = note
        self.attitude = self.probe.Attitude(max_gap=self.max_gap)
        self.previous_clock = self.previous_time = self.previous_gyro = None

    def close(self):
        if self.device is not None:
            try:
                if self.owns_device:
                    self.binding_check()
                    if self._configuration() not in KNOWN_CONFIGURATIONS:
                        raise ConfigurationError("I2C3 IMU 配置已改变，停止清理")
                    self._known_command()
                    self._finish_known_command()
                    self._release_lock()
                    self.device.write(CTRL7, 0x00)
                    self._set_clock_gating(True)
            except (OSError, RuntimeError) as error:
                logging.warning("I2C3 IMU 关闭时未能恢复采样配置：%s", error)
            finally:
                self.device.close()
                self.device = None
                self.owns_device = False
        self.attitude = self.probe.Attitude(max_gap=self.max_gap)
        self.previous_clock = self.previous_time = self.previous_gyro = None


def worker(hz):
    sampler = QmiSampler(hz=hz)
    period = 1 / hz
    retry_delay = WORKER_RETRY_INITIAL_DELAY
    last_error = None
    recent = deque(maxlen=32)
    last_sampled = time.monotonic()
    last_diagnostic = None
    previous_started = None
    stopping = False
    previous_signal_handler = signal.getsignal(signal.SIGTERM)

    def stop_worker(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop_worker)
    try:
        while not stopping:
            started = time.monotonic()
            cpu_started = time.process_time()
            delay = 0.0
            output_ms = 0.0
            state = None
            try:
                state = sampler.sample()
                if state is not None:
                    retry_delay = WORKER_RETRY_INITIAL_DELAY
                    last_error = None
                    output_started = time.monotonic()
                    print(json.dumps(state, allow_nan=False), flush=True)
                    output_ms = (time.monotonic() - output_started) * 1000
            except SaturatedError as error:
                if hasattr(sampler, "last_diagnostic"):
                    sampler.last_diagnostic.update(outcome="saturated", error=str(error))
                sampler.reset_attitude("读数饱和后，航向已重新置零")
                retry_delay = WORKER_RETRY_INITIAL_DELAY
                last_error = None
                output_started = time.monotonic()
                print(json.dumps(dict(valid=False, status="saturated", error=str(error),
                                      saturated_axes=error.axes, raw_counts=error.raw,
                                      reset_count=sampler.reset_count)), flush=True)
                output_ms = (time.monotonic() - output_started) * 1000
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
                sampler.reset_attitude("连接中断后，航向已重新置零")
                sampler.close()
                status = "configuration_error" if isinstance(error, ConfigurationError) else "communication_error"
                if hasattr(sampler, "last_diagnostic"):
                    sampler.last_diagnostic.update(outcome=status, error=str(error))
                signature = (status, str(error))
                if signature != last_error:
                    output_started = time.monotonic()
                    print(json.dumps(dict(valid=False, status=status, error=str(error),
                                          reset_count=sampler.reset_count)), flush=True)
                    output_ms = (time.monotonic() - output_started) * 1000
                    last_error = signature
                delay = retry_delay
                retry_delay = min(retry_delay * 2, WORKER_RETRY_MAX_DELAY)
            finished = time.monotonic()
            diagnostic = dict(getattr(sampler, "last_diagnostic", {}))
            diagnostic["attempt_ms"] = round((finished - started) * 1000, 2)
            diagnostic["cpu_ms"] = round((time.process_time() - cpu_started) * 1000, 2)
            diagnostic["stdout_ms"] = round(output_ms, 2)
            if previous_started is not None:
                diagnostic["start_gap_ms"] = round((started - previous_started) * 1000, 2)
            previous_started = started
            recent.append(diagnostic)
            gap = finished - last_sampled
            if gap > STALE_SECONDS and (last_diagnostic is None or finished - last_diagnostic >= DIAGNOSTIC_INTERVAL):
                counts = {}
                maxima = {}
                errors = []
                for item in recent:
                    outcome = item.get("outcome", "unknown")
                    counts[outcome] = counts.get(outcome, 0) + 1
                    for name, value in item.items():
                        if name.endswith("_ms"):
                            maxima[name] = max(maxima.get(name, 0), value)
                    if item.get("error"):
                        errors.append(item["error"])
                print(json.dumps(dict(type="qmi_diagnostic", gap_ms=round(gap * 1000),
                                      attempts=len(recent), outcomes=counts, max_ms=maxima,
                                      last_error=errors[-1] if errors else None)), flush=True)
                last_diagnostic = finished
            if isinstance(state, dict) and isinstance(state.get("sampled_monotonic"), (int, float)):
                last_sampled = state["sampled_monotonic"]
            time.sleep(max(delay, period - (time.monotonic() - started), 0))
    finally:
        try:
            sampler.close()
        finally:
            signal.signal(signal.SIGTERM, previous_signal_handler)


class AuxiliaryImu:
    """Own a cancellable worker only while at least one status page is polling."""

    def __init__(self, hz, demo=False, profile_store=None):
        self.hz = hz
        self.demo = demo
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stopped = False
        self.clients = {}
        self.subscription_versions = {}
        self.workspace_requests = {}
        self.calibration = HeadCalibration(hz, store=profile_store)
        self.process = None
        self.last_progress_at = None
        self.recovery_grace_until = 0.0
        self.diagnostic_lock = threading.Lock()
        self.diagnostic_last = {}
        self.state = dict(valid=False, status="starting", error="等待 I2C3 IMU")
        self.thread = threading.Thread(target=self._manage, name="qmi-manager", daemon=True)
        self.thread.start()

    def snapshot(self, client, active, calibration=False, revision=None):
        waiting = time.monotonic()
        with self.lock:
            now = time.monotonic()
            lock_wait_ms = (now - waiting) * 1000
            calibrating = self.calibration.state["active"]
            if self._current_subscription_locked(client, revision):
                if revision is not None and client:
                    self.subscription_versions[client] = (revision, now)
                    previous_workspace = self.workspace_requests.get(client)
                    if previous_workspace is not None:
                        self.workspace_requests[client] = (previous_workspace[0], previous_workspace[1], now)
                if active and client:
                    self.clients[client] = now
                else:
                    self.clients.pop(client, None)
                    self._stop_unobserved_worker_locked()
                if self.calibration.owner == client and self.calibration.state["active"] and not calibration:
                    self.calibration.cancel(client, "已离开校准页面")
            state = dict(self.state)
        if lock_wait_ms > 100:
            self._diagnostic_warning("snapshot_lock", "头部 IMU 状态锁等待 %.1f ms，标定中=%s", lock_wait_ms, calibrating)
        self.wake.set()
        if self.demo and active:
            angle = math.sin(now * .7) * .1
            gyro = [math.cos(now * .7) * .07, 0, 0]
            sample = dict(frame="sensor", timestamp_ms=int(time.time() * 1000), sequence=int(now * 20),
                          age_us=0, raw_g=[0, math.sin(angle), math.cos(angle)],
                          corrected_g=[0, math.sin(angle), math.cos(angle)],
                          gyro_rad_s=gyro, raw_gyro_rad_s=gyro, corrected_gyro_rad_s=gyro,
                          accel_calibrated=False, gyro_calibrated=False)
            return dict(valid=True, status="ok", error=None, age_ms=0, demo=True, reset_count=0,
                        rpy_deg=[math.degrees(angle), 0, 0], gyro_rad_s=gyro, sample=sample,
                        accel_calibrated=False, gyro_calibrated=False,
                        gravity=[0, -math.sin(angle), -math.cos(angle)],
                        quaternion_wxyz=[math.cos(angle/2), math.sin(angle/2), 0, 0])
        sampled = state.pop("sampled_monotonic", None)
        state["age_ms"] = round((now - sampled) * 1000) if sampled is not None else None
        if state.get("sample") is not None and sampled is not None:
            state["sample"] = dict(state["sample"], age_us=max(0, round((now - sampled) * 1000000)))
        if state.get("valid") and (sampled is None or now - sampled > STALE_SECONDS):
            state = dict(valid=False, status="stale", error="I2C3 IMU 数据已过期", age_ms=state["age_ms"])
        return state

    def calibration_snapshot(self):
        with self.lock:
            return self.calibration.snapshot()

    def _diagnostic_warning(self, key, message, *args):
        now = time.monotonic()
        with self.diagnostic_lock:
            previous = self.diagnostic_last.get(key)
            if previous is not None and now - previous < DIAGNOSTIC_INTERVAL:
                return
            self.diagnostic_last[key] = now
        logging.warning(message, *args)

    def _current_subscription_locked(self, client, revision):
        previous = self.subscription_versions.get(client)
        return previous is None or revision is not None and revision >= previous[0]

    def current_workspace_request(self, client, revision, workspace, *, check_subscription=True):
        with self.lock:
            if check_subscription and not self._current_subscription_locked(client, revision):
                return False
            previous = self.workspace_requests.get(client)
            return (previous is None or revision is None or revision > previous[0]
                    or revision == previous[0] and workspace == previous[1])

    def remember_workspace_request(self, client, revision, workspace):
        if client and revision is not None:
            with self.lock:
                now = time.monotonic()
                if self._current_subscription_locked(client, revision):
                    self.subscription_versions[client] = (revision, now)
                self.workspace_requests[client] = (revision, workspace, now)

    def _stop_unobserved_worker_locked(self):
        if not self.clients and self.process is not None and self.process.poll() is None:
            try:
                self.process.terminate()
            except ProcessLookupError:
                pass

    def leave_workspace(self, client, revision=None):
        with self.lock:
            if not self._current_subscription_locked(client, revision):
                return
            if client and revision is not None:
                self.subscription_versions[client] = (revision, time.monotonic())
            self.clients.pop(client, None)
            self._stop_unobserved_worker_locked()
            if self.calibration.owner == client:
                self.calibration.cancel(client, "已离开校准页面")
        self.wake.set()

    def calibration_command(self, client, command):
        with self.lock:
            if self.demo:
                raise ValueError("演示模式不能进行硬件标定")
            if not client or client not in self.clients:
                raise PermissionError("校准页面尚未订阅头部 IMU")
            action = command.get("action")
            if action == "start":
                return self.calibration.start(client, command.get("sensor"), self.state)
            if action == "restore":
                return self.calibration.restore_default(command.get("sensor"))
            if action == "next":
                return self.calibration.next(client, self.state)
            if action == "cancel":
                return self.calibration.cancel(client)
            raise ValueError("未知头部 IMU 标定操作")

    def _read(self, process):
        for line in process.stdout:
            try:
                state = json.loads(line)
                if isinstance(state, dict) and state.get("type") == "qmi_diagnostic":
                    with self.lock:
                        current = self.process is process
                    if current:
                        self._diagnostic_warning("worker", "头部 IMU 采样诊断 %s",
                                                 json.dumps(state, ensure_ascii=False, separators=(",", ":")))
                    continue
                if not isinstance(state, dict) or type(state.get("valid")) is not bool:
                    raise ValueError("IMU 数据格式无效")
            except (ValueError, json.JSONDecodeError) as error:
                state = dict(valid=False, status="communication_error", error=f"IMU 数据异常：{error}")
            arrived = time.monotonic()
            detail = None
            with self.lock:
                if self.process is process:
                    self.state = state
                    received = time.monotonic()
                    sampled = state.get("sampled_monotonic")
                    if (isinstance(sampled, (int, float)) and not isinstance(sampled, bool)
                            and math.isfinite(sampled) and 0 <= received - sampled <= STALE_SECONDS
                            and isinstance(state.get("sample"), dict)) or state.get("status") == "saturated":
                        self.last_progress_at = received
                    try:
                        self.calibration.observe(state)
                    except RuntimeError as error:
                        logging.error("头部 IMU 标定失败：%s", error)
                    finished = time.monotonic()
                    if finished - received > STALE_SECONDS:
                        self.recovery_grace_until = finished + STALE_SECONDS
                    lock_ms = (received - arrived) * 1000
                    age_ms = ((received - sampled) * 1000 if isinstance(sampled, (int, float))
                              and not isinstance(sampled, bool) and math.isfinite(sampled) else None)
                    observe_ms = (finished - received) * 1000
                    if lock_ms > 100 or age_ms is not None and age_ms > 200 or observe_ms > 100:
                        detail = (lock_ms, age_ms, observe_ms, self.calibration.state["active"])
            if detail is not None:
                self._diagnostic_warning("reader", "头部 IMU 接收延迟 lock_ms=%.1f age_ms=%s observe_ms=%.1f calibrating=%s",
                                         detail[0], None if detail[1] is None else round(detail[1], 1), detail[2], detail[3])

    def _manage(self):
        process = None
        reader = None
        terminating = False
        restarting = False
        next_retry_at = 0.0
        retry_delay = RECOVERY_INITIAL_DELAY
        started_at = None
        last_gap_warning = None
        while True:
            with self.lock:
                now = time.monotonic()
                self.clients = {client: seen for client, seen in self.clients.items() if now - seen < CLIENT_TIMEOUT}
                self.subscription_versions = {client: item for client, item in self.subscription_versions.items()
                                              if now - item[1] < SUBSCRIPTION_VERSION_TIMEOUT}
                self.workspace_requests = {client: item for client, item in self.workspace_requests.items()
                                           if now - item[2] < SUBSCRIPTION_VERSION_TIMEOUT}
                try:
                    if self.calibration.owner and self.calibration.owner not in self.clients:
                        self.calibration.cancel(self.calibration.owner, "校准页面已断开")
                    self.calibration.tick(now)
                except RuntimeError as error:
                    logging.error("头部 IMU 标定失败：%s", error)
                active = bool(self.clients) and not self.stopped and not self.demo
                stopped = self.stopped
                last_progress_at = self.last_progress_at
                recovery_grace_until = self.recovery_grace_until
                status = self.state.get("status")
            if not active:
                next_retry_at = 0.0
                retry_delay = RECOVERY_INITIAL_DELAY
            if active and process is None and now >= next_retry_at:
                try:
                    with self.lock:
                        if self.clients and not self.stopped and not self.demo:
                            process = subprocess.Popen([sys.executable, "-u", "-m", "app.sensors.qmi_imu", "--worker", str(self.hz)],
                                                       stdout=subprocess.PIPE, text=True, cwd=CONSOLE_ROOT)
                            self.process = process
                            self.state = dict(valid=False, status="starting", error="等待 I2C3 IMU")
                            started_at = self.last_progress_at = time.monotonic()
                            self.recovery_grace_until = 0.0
                    if process is not None:
                        reader = threading.Thread(target=self._read, args=(process,), daemon=True)
                        reader.start()
                except OSError as error:
                    next_retry_at = time.monotonic() + retry_delay
                    retry_delay = min(retry_delay * 2, RECOVERY_MAX_DELAY)
                    with self.lock:
                        self.state = dict(valid=False, status="unavailable", error=f"IMU 采样启动失败：{error}")
            if (active and process is not None and not terminating and started_at is not None
                    and last_progress_at is not None and now - last_progress_at <= STALE_SECONDS
                    and now - started_at >= RECOVERY_STABLE_SECONDS):
                retry_delay = RECOVERY_INITIAL_DELAY
            if (active and process is not None and process.poll() is None and last_progress_at is not None
                    and now - last_progress_at > STALE_SECONDS
                    and (last_gap_warning is None or now - last_gap_warning >= DIAGNOSTIC_INTERVAL)):
                try:
                    wait_site = Path(f"/proc/{process.pid}/wchan").read_text().strip()
                except (OSError, AttributeError):
                    wait_site = "unavailable"
                logging.warning("头部 IMU 超过 500 ms 没有新采样 gap_ms=%.0f status=%s worker_wait=%s",
                                (now - last_progress_at) * 1000, status, wait_site)
                last_gap_warning = now
            if (active and process is not None and not terminating and process.poll() is None
                    and last_progress_at is not None and now - last_progress_at > RECOVERY_NO_SAMPLE_SECONDS
                    and now >= recovery_grace_until):
                restarting = True
                with self.lock:
                    self.state = dict(valid=False, status="stale", error="I2C3 IMU 采样中断，正在重新连接")
                logging.warning("I2C3 IMU 长时间没有新采样，正在重建采样进程")
            if process is not None and (not active or restarting or terminating or process.poll() is not None):
                if process.poll() is None and not terminating:
                    terminating = True
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        try:
                            process.kill()
                        except ProcessLookupError:
                            pass
                        try:
                            process.wait(timeout=1)
                        except subprocess.TimeoutExpired:
                            logging.error("I2C3 IMU 采样进程无法退出，禁止启动新采样进程")
                if process.poll() is not None:
                    exit_code = process.poll()
                    retry = active and (restarting or not terminating)
                    reader.join(timeout=1)
                    process.stdout.close()
                    with self.lock:
                        try:
                            self.calibration.lost("头部 IMU 采样进程已退出")
                        except RuntimeError as error:
                            logging.error("头部 IMU 标定失败：%s", error)
                        self.process = None
                        self.state = dict(valid=False, status="unavailable" if active else "starting",
                                          error=f"IMU 采样进程已退出（{exit_code}），正在重试" if retry else "等待 I2C3 IMU")
                        self.last_progress_at = None
                    process = reader = None
                    terminating = False
                    restarting = False
                    started_at = None
                    if retry:
                        next_retry_at = time.monotonic() + retry_delay
                        retry_delay = min(retry_delay * 2, RECOVERY_MAX_DELAY)
                else:
                    with self.lock:
                        self.state = dict(valid=False, status="unavailable", error="I2C3 IMU 采样进程无法退出")
            if stopped:
                return
            self.wake.wait(.1)
            self.wake.clear()

    def close(self):
        with self.lock:
            self.stopped = True
        self.wake.set()
        self.thread.join(timeout=4)
        if self.thread.is_alive():
            logging.error("I2C3 IMU 采样进程未能停止")


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--worker":
    worker(float(sys.argv[2]))
