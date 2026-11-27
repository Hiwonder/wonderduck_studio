"""Cooperative parameter saves executed only by the existing bus worker."""

from concurrent.futures import Future
import logging
import threading
import time

from app.robot.protocol import BY_ADDRESS, ServoOperationError, encode_register, integer, joint_id


EXCLUDED_ADDRESSES = {5, 6, 31, 33}


def batch_request(command, ids):
    targets, parameters = command.get('ids'), command.get('parameters')
    if not isinstance(targets, list) or not targets or len(targets) != len(set(targets)):
        raise ValueError('请选择有效且不重复的目标舵机')
    targets = [joint_id(value, ids) for value in targets]
    if not isinstance(parameters, list) or not parameters:
        raise ValueError('请选择批量保存参数')
    values = {}
    for item in parameters:
        if not isinstance(item, dict):
            raise ValueError('参数必须为对象')
        address = integer(item.get('address'), 0, 70, '地址')
        register = BY_ADDRESS.get(address)
        if not register or not register['writable'] or register['region'] != 'NVS' or address in EXCLUDED_ADDRESSES:
            raise ValueError(f'地址 {address} 不支持批量保存')
        if address in values:
            raise ValueError('批量参数地址不能重复')
        values[address] = encode_register(register, item.get('value'))
    return targets, values


def save_parameters(command, ids, read, write, check, progress):
    """Yield between bus operations so telemetry and cancellation stay responsive."""
    targets, values = batch_request(command, ids)
    plans, unlocked, errors = [], [], []
    total, confirmed, written = len(targets) * len(values), 0, 0
    cancelled = False
    current = '预检'
    start = min(values)
    end = max(address + len(data) for address, data in values.items())
    try:
        for device_id in targets:
            check()
            current = f'ID {device_id} · 参数预检'
            try:
                raw = read(device_id, 0, 56, '批量参数预检')
                if raw[5] != device_id:
                    raise ServoOperationError(f'目标 ID 不一致：读到 {raw[5]}')
                if raw[55] not in (0, 1):
                    raise ServoOperationError('写保护锁状态无效')
                lower = int.from_bytes(values.get(9, raw[9:11]), 'little')
                upper = int.from_bytes(values.get(11, raw[11:13]), 'little')
                if lower > upper:
                    raise ServoOperationError('最小角度限制不能大于最大角度限制')
                order = list(values)
                if lower > int.from_bytes(raw[11:13], 'little') and 11 in order:
                    order.remove(11)
                    order.insert(0, 11)
                elif upper < int.from_bytes(raw[9:11], 'little') and 9 in order:
                    order.remove(9)
                    order.insert(0, 9)
                changed = [address for address in order if raw[address:address + len(values[address])] != values[address]]
                plans.append((device_id, bytes((raw[55],)), changed))
            except ServoOperationError as error:
                errors.append(f'{current}：{error}')
            progress(phase='预检', total=total, confirmed=0, written=0)
            yield
        for device_id, lock, changed in plans:
            check()
            try:
                if changed and lock != b'\x00':
                    current = f'ID {device_id} · 解除写保护'
                    unlocked.append((device_id, lock))  # The write can reach a servo even if verification fails.
                    write(device_id, 55, b'\x00')
                    if read(device_id, 55, 1, '批量解除写保护') != b'\x00':
                        raise ServoOperationError('写保护锁未解除')
                    progress(phase='解锁')
                    yield
                for address in changed:
                    check()
                    current = f"ID {device_id} · {BY_ADDRESS[address]['name']}"
                    write(device_id, address, values[address])
                    written += 1
                    progress(phase='写入', written=written)
                    yield
                check()
                current = f'ID {device_id} · 统一读回'
                raw = read(device_id, start, end - start, '批量统一读回')
                for address, expected in values.items():
                    actual = raw[address - start:address - start + len(expected)]
                    if actual == expected:
                        confirmed += 1
                    else:
                        errors.append(f"ID {device_id} · {BY_ADDRESS[address]['name']}：请求 {int.from_bytes(expected, 'little')}，读回 {int.from_bytes(actual, 'little')}")
            except ServoOperationError as error:
                errors.append(f'{current}：{error}')
            progress(phase='统一校验', confirmed=confirmed, total=total, written=written)
            yield
    except InterruptedError as error:
        cancelled = True
        errors.append(str(error))
    except Exception as error:
        errors.append(f'{current}：{error}')
    # Restore every lock that was touched, even after cancellation or a bus fault.
    lock_errors = []
    for device_id, lock in unlocked:
        try:
            write(device_id, 55, lock)
            if read(device_id, 55, 1, '批量恢复写保护') != lock:
                raise RuntimeError('写保护锁读回不一致')
        except Exception as error:
            lock_errors.append(f'ID {device_id} · 恢复写保护：{error}')
        progress(phase='恢复写保护')
        yield
    errors.extend(lock_errors)
    return dict(verified=not errors and confirmed == total, cancelled=cancelled,
                total=total, confirmed=confirmed, written=written,
                locks_restored=not lock_errors, errors=errors)


class ParameterBatch:
    """One owned task; HTTP only observes/cancels, the bus worker advances it."""

    def __init__(self, armed, stopped):
        self.armed, self.stopped = armed, stopped
        self.lock = threading.Lock()
        self.job = None
        self.iterator = None
        self.future = None

    def active(self):
        with self.lock:
            return self.job is not None and not self.job['done']

    def start(self, command, client, ids, commands):
        batch_request(command, ids)
        job_id = command.get('job')
        if not isinstance(job_id, str) or not 16 <= len(job_id) <= 80:
            raise ValueError('批量任务编号无效')
        with self.lock:
            if self.job and not self.job['done']:
                raise RuntimeError('批量保存尚未完成')
            self.job = dict(job=job_id, owner=client, done=False, phase='排队',
                            confirmed=0, total=len(command['ids']) * len(command['parameters']),
                            written=0, cancel_reason='')
            future = Future()
            try:
                commands.put_nowait((dict(command, action='save_parameters'), client,
                                     time.monotonic() + 3, future))
            except Exception:
                self.job = None
                raise
            self.future = future
            snapshot = self.public()
        future.add_done_callback(self.finish)
        return snapshot

    def public(self):
        return {key: value for key, value in self.job.items() if key != 'owner'}

    def status(self, job_id, client):
        with self.lock:
            if not self.job or self.job['job'] != job_id or self.job['owner'] != client:
                raise ValueError('批量任务不存在或不属于当前会话')
            return self.public()

    def cancel(self, reason, client=None, job_id=None):
        with self.lock:
            if not self.job or self.job['done']:
                return
            if client is not None and self.job['owner'] != client:
                raise PermissionError('不能取消其他会话的批量任务')
            if job_id is not None and self.job['job'] != job_id:
                raise ValueError('批量任务编号无效')
            self.job['cancel_reason'] = reason

    def check(self):
        with self.lock:
            owner, reason = self.job['owner'], self.job['cancel_reason']
        if reason:
            raise InterruptedError(reason)
        if self.stopped() or not self.armed(owner):
            raise InterruptedError('控制已锁定或服务正在停止')

    def progress(self, **values):
        with self.lock:
            self.job.update(values)

    def begin(self, iterator):
        self.iterator = iterator

    def step(self):
        if self.iterator is None:
            return False
        try:
            next(self.iterator)
        except StopIteration as result:
            self.iterator = None
            self.future.set_result(result.value)
        except Exception as error:
            self.iterator = None
            self.future.set_exception(error)
        return True

    def finish(self, future):
        try:
            result = future.result()
        except Exception as error:
            result = dict(verified=False, errors=[str(error)], locks_restored=False)
        with self.lock:
            self.job.update(result, done=True, phase='完成')
            summary = self.public()
        logging.info('parameter batch result=%s', summary)
