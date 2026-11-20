"""Finish the existing rest sequence before entering a servo workspace."""

import time

from app.models.update_control import UpdateControl
from app.robot.robotd_state import query_robotd


REST_TIMEOUT = 4.0
POLL_INTERVAL = .25


def _remaining(deadline, maximum=3.0):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("等待机器人休息完成超时")
    return min(maximum, remaining)


def rest_status(path, deadline=None):
    timeout = 3 if deadline is None else _remaining(deadline)
    status = query_robotd(path, (("robot.policies", {}),), timeout=timeout)["robot.policies"]
    if deadline is not None:
        _remaining(deadline)
    if (not isinstance(status, dict) or status.get("rest_phase") not in
            ("idle", "resting", "rested", "failed") or type(status.get("motion_enabled")) is not bool):
        raise RuntimeError("无法确认机器人休息状态")
    phase, enabled = status["rest_phase"], status["motion_enabled"]
    if phase == "rested" and enabled:
        raise RuntimeError("机器人休息状态不一致")
    return phase, enabled


def _wait_rest(path, deadline):
    while True:
        phase, _ = rest_status(path, deadline)
        if phase == "rested":
            return
        if phase == "failed":
            raise RuntimeError("机器人休息失败")
        if phase != "resting":
            raise RuntimeError("机器人休息被中断")
        time.sleep(_remaining(deadline, POLL_INTERVAL))


def ensure_rest(path):
    deadline = time.monotonic() + REST_TIMEOUT
    phase, enabled = rest_status(path, deadline)
    if phase == "rested":
        return
    if phase == "resting":
        _wait_rest(path, deadline)
        return
    # A later Start can re-enable motion while robotd still reports the earlier
    # failed rest. In that case try a fresh sit instead of cutting torque at once.
    if phase == "failed" and not enabled:
        raise RuntimeError("机器人休息失败")

    # Stop the existing control source before taking the web lease. The page
    # guard already blocks new manual movement during this transition.
    stopped = query_robotd(path, (("robot.stop", {}),), timeout=_remaining(deadline))["robot.stop"]
    if stopped.get("accepted") is not True:
        raise RuntimeError(f"无法停止当前控制：{stopped.get('reason') or '结果未确认'}")
    with UpdateControl(path, deadline=deadline) as control:
        phase, enabled = rest_status(path, deadline)
        if phase == "rested":
            return
        if phase == "failed" and not enabled:
            raise RuntimeError("机器人休息失败")
        if phase != "resting":
            reply = control.query((("robot.rest", {}),), timeout=_remaining(deadline))["robot.rest"]
            if reply.get("accepted") is not True:
                phase, _ = rest_status(path, deadline)
                if phase == "rested":
                    return
                if phase != "resting":
                    raise RuntimeError(f"机器人拒绝休息：{reply.get('reason') or '结果未确认'}")
        _wait_rest(path, deadline)
