"""Hold a connection-bound control lease while a model update runs."""

import json
import logging
import socket
import threading
import time


MAX_REPLY_BYTES = 1024 * 1024
REFRESH_INTERVAL = .2
ACQUIRE_TIMEOUT = 5
REST_TIMEOUT = 120


class UpdateControl:
    def __init__(self, endpoint, *, deadline=None):
        self.deadline = deadline
        self.connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.connection.settimeout(self._timeout(5))
            self.connection.connect(str(endpoint))
            self.stream = self.connection.makefile('rwb')
        except BaseException:
            self.connection.close()
            raise
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.worker = None
        self.failure = None
        self.source = None
        self.next_id = 1
        self.closed = False

    def _timeout(self, maximum):
        if self.deadline is None:
            return maximum
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('等待机器人休息完成超时')
        return min(maximum, remaining)

    def _call(self, method, params):
        if self.deadline is not None:
            self.connection.settimeout(self._timeout(self.connection.gettimeout() or 5))
        request_id = self.next_id
        self.next_id += 1
        message = dict(jsonrpc='2.0', id=request_id, method=method, params=params)
        self.stream.write((json.dumps(message) + '\n').encode())
        self.stream.flush()
        line = self.stream.readline(MAX_REPLY_BYTES + 1)
        if not line or len(line) > MAX_REPLY_BYTES:
            raise ConnectionError('模型更新控制连接中断')
        reply = json.loads(line)
        if not isinstance(reply, dict):
            raise ValueError(f'机器人 {method} 返回的数据格式无效')
        if reply.get('id') != request_id or reply.get('error') is not None or not isinstance(reply.get('result'), dict):
            raise ValueError(f'机器人 {method} 请求失败：{reply.get("error")}')
        return reply['result']

    def _human(self, action):
        return self._call('robot.humanControl', {'action': action, 'source': self.source})

    @staticmethod
    def _accepted(result, label):
        if result.get('accepted') is not True:
            raise ValueError(f'{label}：{result.get("reason") or "结果未确认"}')

    def __enter__(self):
        try:
            deadline = time.monotonic() + REST_TIMEOUT
            if self.deadline is not None:
                deadline = min(deadline, self.deadline)
            while True:
                policy = self._call('robot.policies', {})
                if policy.get('rest_phase') not in ('idle', 'resting', 'rested', 'failed'):
                    raise ValueError('无法确认机器人休息状态')
                if policy.get('rest_phase') != 'resting':
                    break
                if time.monotonic() >= deadline:
                    raise ValueError('等待当前休息完成超时')
                time.sleep(min(.25, max(0, deadline - time.monotonic())))
            maintenance = self._call('robot.maintenance', {'action': 'status'})
            if maintenance.get('phase') != 'idle':
                raise ValueError('舵机维护或标定正在进行，暂不能更新模型')
            self.source = 'web'
            status = self._human('status')
            self._accepted(status, '无法读取控制权')
            if status.get('owner') in ('web', 'gamepad'):
                self.source = status['owner']
            self._accepted(self._call('robot.stop', {}), '无法停止当前控制')
            self._accepted(self._human('register'), '无法登记更新控制会话')
            deadline = time.monotonic() + ACQUIRE_TIMEOUT
            if self.deadline is not None:
                deadline = min(deadline, self.deadline)
            while True:
                result = self._human('acquire')
                if result.get('accepted') is True and result.get('owner') == self.source:
                    break
                reason = result.get('reason')
                if reason not in ('busy', 'robot_busy', 'tracking_active') or time.monotonic() >= deadline:
                    raise ValueError(f'无法取得模型更新控制权：{reason or "结果未确认"}')
                if reason in ('busy', 'tracking_active'):
                    self._accepted(self._call('robot.stop', {}), '无法停止当前控制')
                time.sleep(min(.1, max(0, deadline - time.monotonic())))
            self.worker = threading.Thread(target=self._heartbeat, name='model-control-lease', daemon=True)
            self.worker.start()
            return self
        except BaseException:
            self.close()
            raise

    def _refresh(self):
        result = self._human('refresh')
        if result.get('accepted') is not True or result.get('owner') != self.source:
            raise ValueError('模型更新期间控制权已被其他操作接管')

    def _heartbeat(self):
        while not self.stop.wait(REFRESH_INTERVAL):
            try:
                with self.lock:
                    self._refresh()
            except Exception as error:
                self.failure = error
                self.stop.set()

    def verify(self):
        with self.lock:
            if self.failure is not None:
                raise ValueError(f'模型更新控制会话失效：{self.failure}') from self.failure
            self._refresh()

    def query(self, calls, timeout=5):
        with self.lock:
            if self.failure is not None:
                raise ValueError(f'模型更新控制会话失效：{self.failure}') from self.failure
            self.connection.settimeout(self._timeout(timeout))
            self._refresh()
            return {method: self._call(method, params) for method, params in calls}

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.stop.set()
        if self.worker is not None:
            self.worker.join(timeout=6)
        try:
            with self.lock:
                if (self.source is not None and self.worker is not None and self.failure is None
                        and (self.deadline is None or time.monotonic() < self.deadline)):
                    self._human('abandon')
        except Exception as error:
            logging.warning('Cannot release model update control: %s', error)
        finally:
            try:
                self.stream.close()
            except Exception as error:
                logging.warning('Cannot close model update stream: %s', error)
            try:
                self.connection.close()
            except Exception as error:
                logging.warning('Cannot close model update socket: %s', error)

    def __exit__(self, *_):
        self.close()
