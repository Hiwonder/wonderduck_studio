"""Finish the existing rest sequence before entering a servo workspace."""

import time

from app.models.update_control import UpdateControl
from app.robot.robotd_state import query_robotd


REST_TIMEOUT = 120.0
POLL_INTERVAL = .25


def rest_status(path):
    status = query_robotd(path, (("robot.policies", {}),), timeout=3)["robot.policies"]
    if (not isinstance(status, dict) or status.get("rest_phase") not in
            ("idle", "resting", "rested", "failed") or type(status.get("motion_enabled")) is not bool):
        raise RuntimeError("无法确认机器人休息状态")
    phase, enabled = status["rest_phase"], status["motion_enabled"]
    if phase == "rested" and enabled:
        raise RuntimeError("机器人休息状态不一致")
    return phase, enabled


def _wait_rest(path, deadline):
    while True:
        phase, _ = rest_status(path)
        if phase == "rested":
            return
        if phase == "failed":
            raise RuntimeError("机器人休息失败")
        if phase != "resting":
            raise RuntimeError("机器人休息被中断")
        if time.monotonic() >= deadline:
            raise TimeoutError("等待机器人休息完成超时")
        time.sleep(POLL_INTERVAL)


def ensure_rest(path):
    deadline = time.monotonic() + REST_TIMEOUT
    phase, _ = rest_status(path)
    if phase == "rested":
        return
    if phase == "resting":
        _wait_rest(path, deadline)
        return

    # Stop the existing control source before taking the web lease. The page
    # guard already blocks new manual movement during this transition.
    stopped = query_robotd(path, (("robot.stop", {}),), timeout=3)["robot.stop"]
    if stopped.get("accepted") is not True:
        raise RuntimeError(f"无法停止当前控制：{stopped.get('reason') or '结果未确认'}")
    with UpdateControl(path) as control:
        phase, _ = rest_status(path)
        if phase == "rested":
            return
        if phase != "resting":
            reply = control.query((("robot.rest", {}),), timeout=3)["robot.rest"]
            if reply.get("accepted") is not True:
                phase, _ = rest_status(path)
                if phase == "rested":
                    return
                if phase != "resting":
                    raise RuntimeError(f"机器人拒绝休息：{reply.get('reason') or '结果未确认'}")
        _wait_rest(path, deadline)
