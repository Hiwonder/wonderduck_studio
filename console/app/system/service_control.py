"""Schedule a robot service restart after replying to the browser."""

import subprocess
import threading


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


def restart_robotd():
    with _restart_lock:
        _run(["sudo", "-n", "/usr/bin/systemctl", "daemon-reload"], "重载服务配置失败")
        # PID 1 owns the delayed restart, so the HTTP server can reply before
        # robotd and its child processes are stopped.
        _run(["sudo", "-n", "/usr/bin/systemd-run", "--unit=wonderduck-robotd-restart",
              "--on-active=2s", "--timer-property=RemainAfterElapse=no", "--collect",
              "/usr/bin/systemctl", "restart", "robotd.service"], "安排服务重启失败")
    return {"accepted": True}
