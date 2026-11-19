"""Cooperative action playback, executed by the serial owner's worker."""

import threading
import time


def action_frames(document, ids, locked_ids=()):
    frames = []
    for frame in document.clip.frames:
        entries = [(index, value) for index, value in enumerate(frame.positions, 1) if value is not None]
        unknown = [device_id for device_id, _ in entries if device_id not in ids and device_id not in locked_ids]
        if unknown:
            raise ValueError("动作包含当前机器人没有的舵机 ID：" + ", ".join(map(str, unknown)))
        frames.append((frame.duration_ms, {device_id: value for device_id, value in entries
                                           if device_id not in locked_ids}))
    return frames


class ActionPlayback:
    def __init__(self, armed, clock=time.monotonic):
        self.armed = armed
        self.clock = clock
        self.lock = threading.RLock()
        self.status_lock = threading.Lock()
        self.job = None
        self.run_id = 0
        self.status = dict(state="idle", frame=None, count=0, error=None,
                           run_id=0, dispatch=0, frame_targets={})

    def active(self):
        with self.lock:
            return self.job is not None

    def snapshot(self):
        with self.status_lock:
            return dict(self.status)

    def update_status(self, **changes):
        with self.status_lock:
            self.status.update(changes)

    def start(self, document, client, ids, loop, locked_ids=()):
        if type(loop) is not bool:
            raise ValueError("循环选项无效")
        frames = action_frames(document, ids, locked_ids)
        with self.lock:
            if self.job is not None:
                raise RuntimeError("动作正在播放")
            if not self.armed(client):
                raise PermissionError("写操作未解锁或已过期")
            self.run_id += 1
            self.job = dict(frames=frames, client=client, loop=loop, index=0, deadline=self.clock(),
                            prepared=set(), dispatched_targets={}, dispatch=0)
            self.update_status(state="playing", frame=None, count=len(frames), error=None,
                               run_id=self.run_id, dispatch=0, frame_targets={})
            return self.snapshot()

    def cancel(self, reason="已停止", client=None):
        with self.lock:
            if self.job is not None and (client is None or self.job["client"] == client):
                self.job = None
                self.update_status(state="stopped", error=reason)
            return self.snapshot()

    def next_deadline(self):
        with self.lock:
            return self.job["deadline"] if self.job else None

    def step(self, hardware):
        # Keep cancellation and dispatch ordered: once stop returns no new frame can start.
        with self.lock:
            job = self.job
            if job is None:
                return None
            if not self.armed(job["client"]):
                self.job = None
                self.update_status(state="stopped", error="控制租约已失效")
                return None
            if self.clock() < job["deadline"]:
                return None
            if job["index"] >= len(job["frames"]):
                if not job["loop"]:
                    self.job = None
                    self.update_status(state="completed", error=None)
                    return None
                job["index"] = 0
            index = job["index"]
            duration, targets = job["frames"][index]
            try:
                unprepared = [device_id for device_id in targets if device_id not in job["prepared"]]
                if unprepared:
                    hardware.prepare_action_playback(unprepared)
                    job["prepared"].update(unprepared)
                started = self.clock()
                if targets:
                    result = hardware.move_action_frame(targets, duration)
                    if not result.get("sent"):
                        raise RuntimeError("动作帧未发送完成")
            except Exception as error:
                self.job = None
                self.update_status(state="error", frame=index + 1, error=str(error))
                return None
            job["dispatched_targets"].update(targets)
            job["dispatch"] += 1
            self.update_status(frame=index + 1, dispatch=job["dispatch"],
                               frame_targets=dict(job["dispatched_targets"]))
            job["index"] += 1
            job["deadline"] = started + duration / 1000
            return targets
