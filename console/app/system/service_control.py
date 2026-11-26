"""Schedule a robot service restart after replying to the browser."""

import logging
import subprocess
import threading

from app.robot.manual_page_guard import ManualPageGuard
from app.robot.robotd_state import query_robotd
from app.robot.workspace_rest import ensure_rest, rest_status


_restart_lock = threading.Lock()


def _run(arguments, description):
    try:
        result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=8, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("{}：{}".format(description, error)) from error
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError("{}{}".format(description, "：" + detail if detail else ""))


def _check_maintenance(path):
    try:
        maintenance = query_robotd(path, (("robot.maintenance", {"action": "status"}),),
                                   timeout=2)["robot.maintenance"]
    except (OSError, ValueError) as error:
        logging.warning("Cannot read maintenance status before service restart: %s", error)
        return
    if maintenance.get("phase") != "idle":
        raise RuntimeError("舵机维护或标定正在进行，暂不能重启服务")


def restart_robotd(path):
    if not _restart_lock.acquire(blocking=False):
        raise RuntimeError("服务重启准备中")
    guard = ManualPageGuard(path)
    client = "service-restart"
    scheduled = False

    def release():
        try:
            guard.close()
        finally:
            _restart_lock.release()

    try:
        _check_maintenance(path)
        rest_warning = None
        try:
            guard.ensure(client)
            ensure_rest(path)
        except TimeoutError:
            rest_warning = "等待机器人休息完成超时"
        except (OSError, RuntimeError, ValueError) as error:
            rest_warning = str(error) or "机器人休息失败"

        # Keep control disabled until systemd stops robotd if IPC is responsive.
        if guard.contains(client):
            try:
                guard.set_transition(client, True)
                if rest_warning is None and rest_status(path) != ("rested", False):
                    rest_warning = "机器人已离开休息状态"
            except (OSError, RuntimeError, ValueError) as error:
                logging.warning("Cannot confirm control hold before service restart: %s", error)
                rest_warning = rest_warning or "无法确认机器人休息状态"
        if rest_warning:
            logging.warning("Restarting robotd before successful rest: %s", rest_warning)
        _check_maintenance(path)
        _run(["sudo", "-n", "/usr/bin/systemctl", "daemon-reload"], "重载服务配置失败")
        # PID 1 owns the delayed restart, so the HTTP server can reply before
        # robotd and its child processes are stopped.
        _run(["sudo", "-n", "/usr/bin/systemd-run", "--unit=wonderduck-robotd-restart",
              "--on-active=2s", "--timer-property=RemainAfterElapse=no", "--collect",
              "/usr/bin/systemctl", "restart", "robotd.service"], "安排服务重启失败")
        # The socket guard normally disappears with robotd. Release it if the
        # scheduled job never stops the service.
        expiry = threading.Timer(35, release)
        expiry.daemon = True
        expiry.start()
        scheduled = True
        return {"accepted": True, "rest_warning": rest_warning}
    finally:
        if not scheduled:
            release()
