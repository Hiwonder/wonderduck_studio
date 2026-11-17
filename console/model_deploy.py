#!/usr/bin/env python3
"""Validate and publish a model through robotd, including while it is stopped."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time

from app.models.model_management import ModelManager, ModelUncertainError, OPERATION_TIMEOUT, _file_details, _filename, _sync_directory
from app.models.online_update import OnlineModelUpdater
from app.models.update_control import UpdateControl
from app.robot.robotd_state import query_robotd
from app.system.runtime_config import robot_root


@contextmanager
def directory_owner(directory):
    """Create model files as the environment owner even when committing as root."""
    owner = directory.stat()
    previous_uid, previous_gid = os.geteuid(), os.getegid()
    changed = (previous_uid, previous_gid) != (owner.st_uid, owner.st_gid)
    if changed:
        if previous_uid != 0:
            raise PermissionError("无法切换到模型目录所属用户")
        os.setegid(owner.st_gid)
        os.seteuid(owner.st_uid)
    try:
        yield
    finally:
        if changed:
            os.seteuid(previous_uid)
            os.setegid(previous_gid)


def _snapshot(path):
    """Read bytes and file identity consistently, including atomic replacements."""
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        data = stream.read()
        after = os.fstat(stream.fileno())
    current = path.stat()
    fields = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
    if fields(before) != fields(after) or fields(after) != fields(current):
        raise ValueError(f"文件读取期间发生变化：{path}")
    return data, fields(after), stat.S_IMODE(after.st_mode), after.st_uid, after.st_gid


def _read_manifest(path):
    snapshot = _snapshot(path)
    value = json.loads(snapshot[0])
    if not isinstance(value, dict) or not value:
        raise ValueError("模型清单为空或格式无效")
    for slot, entry in value.items():
        if (not isinstance(slot, str) or not slot or not isinstance(entry, dict) or set(entry) != {"path", "sha256"}
                or not isinstance(entry["path"], str) or not Path(entry["path"]).is_absolute()
                or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])):
            raise ValueError(f"模型清单包含无效的槽位：{slot}")
    return snapshot, value


def _check_files(manifest):
    for slot, entry in manifest.items():
        actual, _ = _file_details(Path(entry["path"]))
        if actual != entry["sha256"]:
            raise ValueError(f"当前模型文件与清单不一致：{slot}")


def _ort_library(root):
    configured = os.environ.get("ORT_DYLIB_PATH")
    if configured:
        path = Path(configured).resolve(strict=True)
        if not path.is_file():
            raise ValueError("ORT_DYLIB_PATH 不是模型运行库文件")
        return path
    libraries = {path.resolve() for path in root.glob("onnxruntime-linux-aarch64-*/lib/libonnxruntime.so.*")
                 if path.is_file()}
    if len(libraries) != 1:
        raise ValueError("无法唯一确定设备 ONNX Runtime 运行库")
    return libraries.pop()


def _fake_config(original, directory):
    # Reuse the TOML parser installed on the device; no changes to the real file.
    import toml

    config = toml.loads(original.decode("utf-8"))
    audio = config.setdefault("audio", {})
    if not isinstance(audio, dict):
        raise ValueError("音频配置格式无效")
    audio["enabled"] = False
    target = directory / "robotd.toml"
    target.write_text(toml.dumps(config), encoding="utf-8")
    return target


@contextmanager
def _fake_robotd(root, binary, params_bytes, manifest_bytes, manifest):
    """Run the existing policy loader against FakeIo and an isolated manifest."""
    with tempfile.TemporaryDirectory(prefix="model-validation-") as folder:
        directory = Path(folder)
        params = _fake_config(params_bytes, directory)
        params.with_suffix(".models.json").write_bytes(manifest_bytes)
        endpoint = directory / "robotd.sock"
        selected = ["velocity" if name == "walk" else name for name in sorted(manifest)]
        runtime = directory / "runtime"
        runtime.mkdir()
        environment = dict(os.environ, DUCK_RUNTIME_DIR=str(runtime), ORT_DYLIB_PATH=str(_ort_library(root)))
        command = [str(binary), "--fake", "--motion-only", "--no-camera", "--params", str(params),
                   "--socket", str(endpoint), "--enable-policies", ",".join(selected)]
        log = directory / "robotd.log"
        with log.open("w+b") as output:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                       env=environment, close_fds=True)
            try:
                deadline = time.monotonic() + OPERATION_TIMEOUT
                while True:
                    if process.poll() is not None:
                        output.flush()
                        detail = log.read_text(encoding="utf-8", errors="replace")[-4096:]
                        raise RuntimeError(f"离线模型校验进程退出：{detail.strip()}")
                    try:
                        result = query_robotd(endpoint, (("robot.managedModels", {}),), timeout=1)["robot.managedModels"]
                    except (ConnectionError, FileNotFoundError, TimeoutError):
                        result = None
                    if result is not None:
                        if type(result.get("enabled")) is not bool or not isinstance(result.get("models"), list):
                            raise ValueError("离线校验模型列表格式无效")
                        if not result["enabled"]:
                            raise ValueError("设备配置未启用策略模型")
                        models = result["models"]
                        if models:
                            loaded = {item.get("id"): item for item in models if isinstance(item, dict)}
                            if len(loaded) != len(models) or set(loaded) != set(manifest):
                                raise ValueError("离线校验未加载当前清单中的全部模型")
                            for slot, expected in manifest.items():
                                if (loaded[slot].get("path") != expected["path"]
                                        or loaded[slot].get("sha256") != expected["sha256"]):
                                    raise ValueError(f"离线校验加载的模型与清单不一致：{slot}")
                            break
                    if time.monotonic() >= deadline:
                        output.flush()
                        detail = log.read_text(encoding="utf-8", errors="replace")[-4096:]
                        raise RuntimeError(f"离线模型加载超时：{detail.strip()}")
                    time.sleep(.1)
                yield endpoint, directory
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)


class ModelDeployer:
    def __init__(self, root, params, endpoint, binary, control_factory=None):
        self.root = Path(root).resolve()
        self.params = Path(params)
        self.manifest = self.params.with_suffix(".models.json")
        self.endpoint = Path(endpoint)
        self.binary = Path(binary)
        self.control_factory = control_factory or (lambda: UpdateControl(self.endpoint))

    def _online(self, slot, payload=None, filename=None):
        caller_uid, caller_gid = os.geteuid(), os.getegid()

        def as_caller(operation):
            # Model files belong to the ordinary user, but the socket can be
            # restricted to root. Reacquire the caller's privileges for socket access.
            owner_uid, owner_gid = os.geteuid(), os.getegid()
            if owner_uid != caller_uid:
                os.seteuid(caller_uid)
            try:
                if owner_gid != caller_gid:
                    os.setegid(caller_gid)
                return operation()
            finally:
                if owner_gid != caller_gid:
                    os.setegid(owner_gid)
                if owner_uid != caller_uid:
                    os.seteuid(owner_uid)

        def query(calls, timeout=1):
            return as_caller(lambda: query_robotd(self.endpoint, calls, timeout))

        with directory_owner(self.root):
            manager = ModelManager(self.root, query)
            if payload is None:
                result = manager.list_models()
                model = manager._lookup(slot, result["models"])
                if model.get("error"):
                    raise ValueError(model["error"])
                return {"status": "current", "model": model, "mode": "online"}
            updater = OnlineModelUpdater(manager, lambda: as_caller(self.control_factory))
            with updater.manual_operation():
                result = manager.apply(slot, io.BytesIO(payload), len(payload), filename,
                                       before_apply=updater._require_rest)
            result["mode"] = "online"
            return result

    def _offline(self, slot, payload=None, filename=None):
        params_snapshot = _snapshot(self.params)
        manifest_snapshot, manifest = _read_manifest(self.manifest)
        if slot not in manifest:
            raise ValueError(f"模型槽位未配置：{slot}")
        _check_files(manifest)
        old = dict(id=slot, path=manifest[slot]["path"], sha256=manifest[slot]["sha256"], active=False)
        current = {**old, "loaded": False}
        if payload is None:
            return {"status": "current", "model": current, "mode": "offline"}
        digest = hashlib.sha256(payload).hexdigest()
        if digest == old["sha256"]:
            return {"status": "unchanged", "model": current, "mode": "offline"}

        # All validation and staging use the ordinary user's ownership and never touch a bus.
        with directory_owner(self.root):
            with _fake_robotd(self.root, self.binary, params_snapshot[0], manifest_snapshot[0], manifest) as (endpoint, directory):
                query = lambda calls, timeout=1: query_robotd(endpoint, calls, timeout)
                candidate_manager = ModelManager(directory / "validation", query)
                result = candidate_manager.apply(slot, io.BytesIO(payload), len(payload), filename)
                if result.get("status") != "applied" or result.get("model", {}).get("sha256") != digest:
                    raise ValueError("离线校验后的模型摘要不匹配")

            actual_manager = ModelManager(self.root, lambda *_args, **_kwargs: None)
            candidate = None
            committed = False
            try:
                candidate, staged_digest = actual_manager._stage(slot, io.BytesIO(payload), len(payload), filename)
                if staged_digest != digest:
                    raise ValueError("模型暂存后摘要不一致")
            except BaseException:
                if candidate is not None:
                    actual_manager._remove_candidate(candidate)
                raise

        try:
            if _snapshot(self.params)[:2] != params_snapshot[:2] or _snapshot(self.manifest)[:2] != manifest_snapshot[:2]:
                raise ValueError("设备配置或模型清单在校验期间变化，请重试")
            _check_files(manifest)
            if _file_details(candidate)[0] != digest:
                raise ValueError("已校验模型文件在提交前发生变化")
            manifest[slot] = {"path": str(candidate), "sha256": digest}
            content = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
            descriptor, staged = tempfile.mkstemp(prefix=".robotd-models-", suffix=".tmp", dir=self.manifest.parent)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    os.fchmod(stream.fileno(), manifest_snapshot[2])
                    os.fchown(stream.fileno(), manifest_snapshot[3], manifest_snapshot[4])
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                if _snapshot(self.params)[:2] != params_snapshot[:2] or _snapshot(self.manifest)[:2] != manifest_snapshot[:2]:
                    raise ValueError("设备配置或模型清单在提交前变化，请重试")
                os.replace(staged, self.manifest)
                committed = True
                try:
                    _sync_directory(self.manifest.parent)
                    if _read_manifest(self.manifest)[1] != manifest or _file_details(candidate)[0] != digest:
                        raise ValueError("提交后模型清单或摘要不一致")
                except (OSError, ValueError) as error:
                    raise ModelUncertainError(f"模型清单已替换，但结果无法确认：{error}") from error
            finally:
                Path(staged).unlink(missing_ok=True)
            with directory_owner(self.root):
                references = [entry["path"] for entry in manifest.values()]
                actual_manager._sync_policy_aliases(old, manifest[slot], references)
                actual_manager._discard_superseded(old, references)
            return {"status": "applied", "model": {"id": slot, "path": str(candidate), "sha256": digest,
                                                   "loaded": False, "active": False}, "mode": "offline"}
        except (OSError, ValueError) as error:
            if committed:
                raise ModelUncertainError(f"模型清单已替换，但结果无法确认：{error}") from error
            raise
        finally:
            if not committed:
                with directory_owner(self.root):
                    actual_manager._remove_candidate(candidate)

    def execute(self, slot, payload=None, expected_sha256=None, filename=None):
        if not isinstance(slot, str) or not slot:
            raise ValueError("模型槽位无效")
        if payload is not None:
            if filename is not None:
                _filename(filename)
            if not payload:
                raise ValueError("模型文件为空")
            digest = hashlib.sha256(payload).hexdigest()
            if not isinstance(expected_sha256, str) or digest != expected_sha256:
                raise ValueError("接收模型的 SHA256 与预期不一致")
        lock_path = Path(str(self.endpoint) + ".lock")
        with lock_path.open("a+b") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return self._online(slot, payload, filename)
            try:
                return self._offline(slot, payload, filename)
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slot", required=True)
    parser.add_argument("--robot-root", type=robot_root, default=robot_root())
    parser.add_argument("--sha256")
    parser.add_argument("--name")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if args.status == bool(args.sha256):
        parser.error("--status 和 --sha256 必须且只能选择一个")
    root = args.robot_root
    if os.geteuid() != 0:
        os.execvp("sudo", ["sudo", "-n", sys.executable, str(Path(__file__).resolve()),
                           *sys.argv[1:], "--robot-root", str(root)])
    deployer = ModelDeployer(root, "/etc/robot/robotd.toml", "/run/robotd.sock",
                             root / "target/release/robotd")
    try:
        result = deployer.execute(args.slot, None if args.status else sys.stdin.buffer.read(), args.sha256, args.name)
    except ModelUncertainError as error:
        print(json.dumps({"error": str(error), "uncertain": True}, ensure_ascii=False), flush=True)
        return 1
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error), "uncertain": False}, ensure_ascii=False), flush=True)
        return 1
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
