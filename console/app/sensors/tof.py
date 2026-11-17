"""Read distance in the existing sensor environment, outside the servo bus loop."""

import errno
import json
import logging
import math
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time


WORKER_STATUSES = frozenset(('ok', 'out_of_range', 'invalid_data', 'not_detected',
                             'bus_unavailable', 'communication_error', 'permission_error',
                             'dependency_error', 'timeout', 'error'))


def reading_state(distance, sampled_monotonic):
    if type(distance) is not int:
        return dict(status='invalid_data', valid=False, distance_mm=None,
                    error=f'TOF数据类型无效：{distance!r}', sampled_monotonic=sampled_monotonic)
    valid = 20 <= distance <= 2500
    return dict(status='ok' if valid else 'out_of_range', valid=valid, distance_mm=distance,
                error=None if valid else f'TOF读数无效：{distance}', sampled_monotonic=sampled_monotonic)


def error_status(error, phase):
    if isinstance(error, ImportError):
        return 'dependency_error'
    cause = error.__cause__ or error.__context__
    if isinstance(error, PermissionError) or isinstance(cause, PermissionError):
        return 'permission_error'
    if isinstance(error, FileNotFoundError) and phase == 'bus':
        return 'bus_unavailable'
    if isinstance(error, ValueError) and str(error) == 'No I2C device at address: 0x29':
        return 'not_detected'
    if isinstance(error, OSError):
        if phase == 'sensor' and error.errno in (errno.ENODEV, errno.ENXIO, errno.EREMOTEIO):
            return 'not_detected'
        return 'communication_error'
    if isinstance(error, RuntimeError) and str(error) == 'Timeout waiting for VL53L0X!':
        return 'timeout'
    return 'error'


class TofReader:
    """Cache the most recent 5 Hz distance without blocking HTTP or servo reads."""

    def __init__(self, python=None, demo=False):
        self.lock = threading.Lock()
        self.stopped = False
        self.process = self.thread = None
        self.demo = demo
        self.state = dict(status='starting', valid=False, distance_mm=None, error="TOF连接中")
        if demo:
            return
        python = Path(python) if python else Path(sys.executable)
        try:
            self.process = subprocess.Popen(
                [str(python), '-u', str(Path(__file__).resolve()), '--worker'],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                start_new_session=True)
        except OSError as error:
            self.state.update(status='worker_error', error=f"TOF启动失败：{error}")
            logging.error(self.state['error'])
            return
        self.thread = threading.Thread(target=self._read, name='tof', daemon=True)
        self.thread.start()

    def _read(self):
        for line in self.process.stdout:
            try:
                state = json.loads(line)
                if (not isinstance(state, dict) or type(state.get('valid')) is not bool
                        or not isinstance(state.get('status'), str)
                        or state.get('status') not in WORKER_STATUSES
                        or state['valid'] != (state['status'] == 'ok')):
                    raise ValueError('无效的TOF数据')
                if state['status'] in ('ok', 'out_of_range') and not (
                        type(state.get('distance_mm')) is int
                        and type(state.get('sampled_monotonic')) in (int, float)
                        and math.isfinite(state['sampled_monotonic'])):
                    raise ValueError('TOF采样数据无效')
                if state['valid'] and not (
                        type(state.get('distance_mm')) is int
                        and 20 <= state['distance_mm'] <= 2500):
                    raise ValueError('TOF距离超出有效范围')
                if state['status'] == 'out_of_range' and 20 <= state['distance_mm'] <= 2500:
                    raise ValueError('TOF状态与读数不一致')
            except (json.JSONDecodeError, ValueError) as error:
                state = dict(status='invalid_data', valid=False, distance_mm=None,
                             error=f"TOF读取失败：{error}；{line.strip()[:160]}")
            with self.lock:
                self.state = state
        if not self.stopped:
            code = self.process.wait()
            with self.lock:
                if self.state.get('status') in ('ok', 'out_of_range', 'starting', 'invalid_data') or not self.state.get('error'):
                    self.state = dict(status='worker_error', valid=False, distance_mm=None,
                                      error=f"TOF采集已退出（{code}）")
            logging.error('%s', self.state['error'])

    def snapshot(self):
        if self.demo:
            return dict(status='ok', valid=True, distance_mm=420, age_ms=0, error=None)
        with self.lock:
            state = dict(self.state)
        sampled = state.pop('sampled_monotonic', None)
        state['age_ms'] = round((time.monotonic() - sampled) * 1000) if sampled else None
        if state['status'] in ('ok', 'out_of_range') and (sampled is None or state['age_ms'] > 1500):
            state.update(status='stale', valid=False, error='TOF数据已过期')
        return state

    def close(self):
        self.stopped = True
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=1)
            self.thread.join(timeout=1)
            self.process.stdout.close()


def worker():
    """Use the same library, bus, address and range checks as the distance test."""
    bus = None
    phase = 'import'
    try:
        import adafruit_vl53l0x
        from adafruit_extended_bus import ExtendedI2C
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        phase = 'bus'
        bus = ExtendedI2C(5)
        phase = 'sensor'
        sensor = adafruit_vl53l0x.VL53L0X(bus, address=0x29, io_timeout_s=1.0)
        phase = 'read'
        next_sample = time.monotonic()
        while True:
            time.sleep(max(0, next_sample - time.monotonic()))
            distance = sensor.range
            now = time.monotonic()
            print(json.dumps(reading_state(distance, now)), flush=True)
            next_sample = max(next_sample + .2, now)
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        print(json.dumps(dict(status=error_status(error, phase), valid=False, distance_mm=None,
                              error=f'TOF测距失败：{error}')), flush=True)
        return 1
    finally:
        if bus is not None:
            bus.deinit()
    return 0


if __name__ == '__main__':
    if sys.argv[1:] != ['--worker']:
        raise SystemExit('此模块由控制台启动，无独立操作参数')
    raise SystemExit(worker())
