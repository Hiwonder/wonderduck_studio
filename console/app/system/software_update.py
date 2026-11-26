"""Check and schedule a signed WonderDuck runtime release from Studio."""

import json
import os
import re
import secrets
import subprocess
import sys
import threading
from pathlib import Path

from app.system.runtime_config import RELEASE_VERSION, SHA256, software_build, software_version
from app.system.service_control import _run


UNIT = "wonderduck-software-update"
STABLE_VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
UPDATE_LOCK = threading.Lock()


def available(root, compatible_path=Path("/proc/device-tree/compatible")):
    # The published runtime archives currently contain the RK3566 services and drivers.
    if not (root / "scripts" / "update.py").is_file():
        return False
    try:
        return b"rockchip,rk3566" in compatible_path.read_bytes().split(b"\0")
    except OSError:
        return False


def release_order(version):
    match = RELEASE_VERSION.fullmatch(version) if isinstance(version, str) else None
    if not match:
        raise ValueError("无法读取当前软件版本")
    return tuple(map(int, version.split("-")[0].split("."))) + ("-dev." not in version,)


def run_updater(command, timeout):
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("检查更新超时，请重试") from error
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "无法获取软件更新")
    return result.stdout


def active():
    result = subprocess.run(
        ["/usr/bin/systemctl", "is-active", f"{UNIT}.service", f"{UNIT}.timer"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    return result.returncode == 0


def status(root):
    running = active()
    try:
        job = json.loads((root / ".software-update-status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        job = None
    return {"active": running, "current": software_version(root), "job": job}


def handle(root, socket_path, command, studio_port):
    language = command.get("language")
    if language not in ("zh", "en"):
        raise ValueError("更新语言无效")
    source = "gitee" if language == "zh" else "github"
    updater = [sys.executable, str(root / "scripts" / "update.py"), "--source", source, "--lang", language]
    current, installed_sha256 = software_build(root)
    current_order = release_order(current)
    if command.get("action") == "check":
        latest = json.loads(run_updater(updater + ["--check"], 45))
        version, sha256 = latest["version"], latest.get("sha256")
        if not isinstance(sha256, str) or not SHA256.fullmatch(sha256):
            raise ValueError("发布包摘要无效")
        latest_order = release_order(version)
        if latest_order < current_order or (latest_order == current_order and sha256 == installed_sha256):
            return {"current": current, "version": None}
        return {"current": current, "version": version, "sha256": sha256}
    if command.get("action") != "install":
        raise ValueError("更新操作无效")
    version = command.get("version")
    if not isinstance(version, str) or not STABLE_VERSION.fullmatch(version):
        raise ValueError("更新版本无效或低于当前版本")
    requested_order = release_order(version)
    if requested_order < current_order:
        raise ValueError("更新版本无效或低于当前版本")
    sha256 = command.get("sha256")
    if sha256 is not None and (not isinstance(sha256, str) or not SHA256.fullmatch(sha256)):
        raise ValueError("发布包摘要无效")
    if requested_order == current_order and (sha256 is None or sha256 == installed_sha256):
        raise ValueError("请重新检查更新，确认可用的新构建")
    build_args = ["--expected-sha256", sha256] if sha256 is not None else []
    with UPDATE_LOCK:
        if active():
            raise RuntimeError("软件更新正在进行")
        run_updater(updater + ["--preflight"], 10)
        job_id = secrets.token_hex(8)
        _run(["sudo", "-n", "/usr/bin/systemd-run", f"--unit={UNIT}", "--on-active=2s",
              "--timer-property=RemainAfterElapse=no", "--collect", f"--uid={os.geteuid()}",
              *updater, "--version", version, *build_args, "--job-id", job_id, "--studio-port", str(studio_port),
              "--robot-socket", str(socket_path)],
             "无法启动软件更新")
    return {"accepted": True, "job_id": job_id}
