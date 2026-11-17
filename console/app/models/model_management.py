"""Manage loaded robotd models without replacing files in use."""

import hashlib
import logging
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import time
import unicodedata
import uuid
from urllib.parse import quote


MODEL_NAMES = {
    "walk": "行走", "stand": "站立", "sitstand": "坐立", "ground_pick": "地面拾取",
    "kick_left": "左踢", "kick_right": "右踢", "roulade": "翻滚", "headstand": "倒立",
}
POLICY_ALIASES = {
    "walk": ("velocity.onnx", "walking.onnx"), "stand": ("standing.onnx",),
    "sitstand": ("sitstand.onnx",), "ground_pick": ("ground_pick.onnx",),
    "kick_left": ("ball_kick_left.onnx",), "kick_right": ("ball_kick_right.onnx",),
    "roulade": ("roulade.onnx",), "headstand": ("headstand.onnx",),
}
CURRENT_POLICY_ENTRYPOINTS = frozenset(("velocity.onnx", "ball_kick_left.onnx", "ball_kick_right.onnx"))
CHUNK_SIZE = 1024 * 1024
RPC_TIMEOUT = 5
OPERATION_TIMEOUT = 120


class ModelUncertainError(RuntimeError):
    """A submitted operation may still take effect; retain its files."""


def _sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _file_details(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        before = os.fstat(source.fileno())
        while chunk := source.read(CHUNK_SIZE):
            digest.update(chunk)
        after = os.fstat(source.fileno())
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise OSError("模型文件读取期间发生变化")
    return digest.hexdigest(), after.st_size


def _component(slot):
    encoded = quote(slot, safe="")
    return encoded if len(encoded) <= 200 else "id-" + hashlib.sha256(slot.encode()).hexdigest()


def _filename(name):
    if (not isinstance(name, str) or not name or name.strip() != name
            or name in (".", "..") or "/" in name or "\\" in name
            or any(unicodedata.category(char).startswith("C") for char in name)
            or len(os.fsencode(name)) > 255 or not name.lower().endswith(".onnx")):
        raise ValueError("模型文件名无效")
    return name


class ModelManager:
    def __init__(self, root, query):
        self.root = Path(root).resolve()
        self.current = self.root / "model-current"
        self.defaults = self.root / "model-defaults"
        self.query = query
        self.lock = threading.Lock()

    def _rpc(self, method, params):
        response = self.query(((method, params),), timeout=RPC_TIMEOUT)
        return response[method]

    def _loaded(self):
        result = self._rpc("robot.managedModels", {})
        if type(result.get("enabled")) is not bool or not isinstance(result.get("models"), list):
            raise ValueError("robotd 模型列表格式无效")
        models = result["models"]
        seen = set()
        for model in models:
            if not isinstance(model, dict):
                raise ValueError("robotd 模型信息格式无效")
            slot, path, sha = model.get("id"), model.get("path"), model.get("sha256")
            if (not isinstance(slot, str) or not slot or slot in seen or not isinstance(path, str)
                    or not Path(path).is_absolute() or not isinstance(sha, str)
                    or re.fullmatch(r"[0-9a-f]{64}", sha) is None
                    or type(model.get("active")) is not bool):
                raise ValueError("robotd 模型信息格式无效")
            seen.add(slot)
        return result["enabled"], models

    def _lookup(self, slot, models):
        if not isinstance(slot, str) or not slot:
            raise ValueError("模型选项无效")
        model = next((item for item in models if item["id"] == slot), None)
        if model is None:
            raise ValueError("该模型当前未加载")
        return model

    def _known_name(self, model):
        path = Path(model["path"])
        if path.name == "model.onnx":
            try:
                relative = path.relative_to(self.current)
            except ValueError:
                return None
            prefix = f"{_component(model['id'])}-named-"
            if (len(relative.parts) != 2 or not relative.parts[0].startswith(prefix)
                    or re.fullmatch(r"[0-9a-f]{32}", relative.parts[0][len(prefix):]) is None):
                return None
        try:
            return _filename(path.name)
        except ValueError:
            return None

    def _describe(self, model):
        slot, sha = model["id"], model["sha256"]
        default_path = self.defaults / f"{_component(slot)}.onnx"
        size, error = None, None
        default_sha, default_size, default_error = None, None, None
        try:
            file_sha, size = _file_details(Path(model["path"]))
            if file_sha != sha:
                size = None
                error = "模型文件与已加载内容不一致"
        except OSError as exc:
            error = f"无法读取已加载模型文件：{exc}"
        try:
            default_sha, default_size = _file_details(default_path)
        except FileNotFoundError:
            default_error = "未配置默认模型"
        except OSError as exc:
            default_error = f"无法读取默认模型：{exc}"
        slot_name = MODEL_NAMES.get(slot, slot)
        original_name = self._known_name(model)
        return dict(id=slot, name=original_name or slot_name, original_name=original_name, path=model["path"], loaded=True,
                    active=model["active"], sha256=sha, size=size, error=error,
                    default_path=str(default_path) if default_sha else None,
                    default_name=slot_name if default_sha else None,
                    default_sha256=default_sha, default_size=default_size, default_error=default_error,
                    is_default=(sha == default_sha) if default_sha else None)

    def list_models(self):
        enabled, models = self._loaded()
        return dict(enabled=enabled, models=[self._describe(model) for model in models])

    def _stage(self, slot, source, length=None, filename=None):
        if filename is not None:
            filename = _filename(filename)
        self.current.mkdir(parents=True, exist_ok=True)
        marker = "-named" if filename is not None else ""
        directory = self.current / f"{_component(slot)}{marker}-{uuid.uuid4().hex}"
        directory.mkdir()
        path = directory / (filename or "model.onnx")
        digest = hashlib.sha256()
        remaining = length
        try:
            with path.open("xb") as target:
                while remaining is None or remaining:
                    chunk = source.read(CHUNK_SIZE if remaining is None else min(CHUNK_SIZE, remaining))
                    if not chunk:
                        if remaining:
                            raise ValueError("模型上传中断，请重新选择文件")
                        break
                    target.write(chunk)
                    digest.update(chunk)
                    if remaining is not None:
                        remaining -= len(chunk)
                target.flush()
                os.fchmod(target.fileno(), 0o444)
                os.fsync(target.fileno())
            directory.chmod(0o555)
            _sync_directory(directory)
            _sync_directory(self.current)
            return path, digest.hexdigest()
        except BaseException:
            self._remove_candidate(path)
            raise

    @staticmethod
    def _remove_candidate(path):
        path.parent.chmod(0o755)
        path.unlink(missing_ok=True)
        path.parent.rmdir()

    def _discard_superseded(self, old, referenced_paths):
        """Remove a verified managed file only after a successful, confirmed swap."""
        path = Path(old["path"])
        try:
            relative = path.relative_to(self.current)
        except ValueError:
            return
        try:
            if len(relative.parts) != 2 or self.current.is_symlink() or path.parent.is_symlink() or path.is_symlink():
                return
            prefix = _component(old["id"])
            folder = relative.parts[0]
            if folder != f"{prefix}-initial" and re.fullmatch(
                    re.escape(prefix) + r"-(?:named-)?[0-9a-f]{32}", folder) is None:
                return
            if any(Path(item).resolve() == path.resolve() for item in referenced_paths):
                return
            if list(path.parent.iterdir()) != [path] or _file_details(path)[0] != old["sha256"]:
                return
            self._remove_candidate(path)
            _sync_directory(self.current)
        except (OSError, ValueError) as error:
            # The new model is already committed. Keep an unremovable old file
            # rather than falsely reporting that the model update failed.
            logging.getLogger(__name__).warning("无法清理旧模型 %s: %s", path, error)

    def _sync_policy_aliases(self, old, current, referenced_paths):
        """Keep current copies in sync while retaining default fallback copies."""
        directory = self.root / "policies"
        names = POLICY_ALIASES.get(old["id"], ())
        if not names or directory.is_symlink() or not directory.is_dir():
            return
        default = self.defaults / f"{_component(old['id'])}.onnx"
        try:
            default_sha = _file_details(default)[0]
        except OSError as error:
            logging.getLogger(__name__).warning("无法核对默认模型 %s: %s", default, error)
            return
        for name in names:
            path = directory / name
            temporary = None
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                sha, _ = _file_details(path)
                if sha == current["sha256"] or (sha == default_sha and name not in CURRENT_POLICY_ENTRYPOINTS):
                    continue
                if sha != old["sha256"] or any(Path(item).resolve() == path.resolve() for item in referenced_paths):
                    continue
                info = path.stat()
                if info.st_uid != os.geteuid():
                    continue
                permissions = stat.S_IMODE(info.st_mode)
                descriptor, temporary = tempfile.mkstemp(prefix=".policy-current-", dir=str(directory))
                digest = hashlib.sha256()
                with os.fdopen(descriptor, "wb") as target, Path(current["path"]).open("rb") as source:
                    while chunk := source.read(CHUNK_SIZE):
                        target.write(chunk)
                        digest.update(chunk)
                    target.flush()
                    os.fchmod(target.fileno(), permissions)
                    os.fsync(target.fileno())
                if digest.hexdigest() != current["sha256"] or path.is_symlink() or _file_details(path)[0] != sha:
                    raise ValueError("固定模型入口或新模型在更新期间发生变化")
                os.replace(temporary, path)
                temporary = None
                _sync_directory(directory)
            except (OSError, ValueError) as error:
                logging.getLogger(__name__).warning("无法同步固定模型入口 %s: %s", path, error)
            finally:
                if temporary is not None:
                    try:
                        Path(temporary).unlink(missing_ok=True)
                    except OSError as error:
                        logging.getLogger(__name__).warning("无法清理模型暂存文件 %s: %s", temporary, error)

    def apply(self, slot, source, length, filename=None, before_apply=None):
        if type(length) is not int or length <= 0:
            raise ValueError("模型文件为空")
        if filename is not None:
            filename = _filename(filename)
        with self.lock:
            _, models = self._loaded()
            old = self._lookup(slot, models)
            candidate, sha = self._stage(slot, source, length, filename)
            if before_apply is not None:
                try:
                    before_apply()
                except BaseException:
                    self._remove_candidate(candidate)
                    raise
            return self._apply_candidate(old, candidate, sha, before_apply)

    def restore(self, slot, before_apply=None):
        with self.lock:
            _, models = self._loaded()
            old = self._lookup(slot, models)
            path = self.defaults / f"{_component(slot)}.onnx"
            try:
                with path.open("rb") as source:
                    before = os.fstat(source.fileno())
                    candidate, sha = self._stage(slot, source)
                    after = os.fstat(source.fileno())
            except FileNotFoundError as exc:
                raise ValueError("未配置默认模型") from exc
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                self._remove_candidate(candidate)
                raise ValueError("默认模型读取期间发生变化，请重试")
            if before_apply is not None:
                try:
                    before_apply()
                except BaseException:
                    self._remove_candidate(candidate)
                    raise
            return self._apply_candidate(old, candidate, sha, before_apply)

    def _apply_candidate(self, old, candidate, sha, before_apply=None):
        if sha == old["sha256"]:
            self._remove_candidate(candidate)
            model = self._describe(old)
            if model["error"]:
                raise ValueError(f"{model['error']}，无法确认重启后使用的模型")
            return dict(status="unchanged", model=model)
        try:
            if _file_details(Path(old["path"]))[0] != old["sha256"]:
                raise ValueError("当前模型文件与已加载内容不一致")
        except BaseException:
            self._remove_candidate(candidate)
            raise
        if before_apply is not None:
            try:
                before_apply()
            except BaseException:
                self._remove_candidate(candidate)
                raise
        try:
            reply = self._rpc("robot.applyModel", {"id": old["id"], "path": str(candidate),
                                                   "expected_sha256": old["sha256"],
                                                   "candidate_sha256": sha})
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ModelUncertainError("模型请求连接中断，请刷新模型列表确认") from exc
        if reply.get("accepted") is False:
            self._remove_candidate(candidate)
            raise ValueError(f"robotd 拒绝更新模型：{reply.get('reason') or '未知原因'}")
        operation_id = reply.get("operation_id")
        if reply.get("accepted") is not True or not isinstance(operation_id, str) or not operation_id:
            raise ModelUncertainError("robotd 未返回有效的操作编号，请刷新模型列表确认")
        deadline = time.monotonic() + OPERATION_TIMEOUT
        while True:
            try:
                status = self._rpc("robot.modelUpdateStatus", {"operation_id": operation_id})
            except (OSError, ValueError, KeyError, TypeError) as exc:
                raise ModelUncertainError("模型更新状态不可用，请刷新模型列表确认") from exc
            if status.get("operation_id") != operation_id:
                raise ModelUncertainError("模型更新状态不匹配，请刷新模型列表确认")
            state = status.get("state")
            if state == "failed":
                self._remove_candidate(candidate)
                raise ValueError(f"模型校验或更新失败：{status.get('error') or '未知原因'}")
            if state == "uncertain":
                raise ModelUncertainError(f"模型更新结果未知：{status.get('error') or '请刷新模型列表确认'}")
            if state in ("applied", "unchanged"):
                break
            if state != "pending" or time.monotonic() >= deadline:
                raise ModelUncertainError("模型更新尚未确认，请刷新模型列表确认")
            time.sleep(.25)
        try:
            _, models = self._loaded()
            current = self._lookup(old["id"], models)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ModelUncertainError("模型更新后无法读取当前状态，请刷新模型列表确认") from exc
        if current["sha256"] != sha or (state == "applied" and current["path"] != str(candidate)):
            raise ModelUncertainError("模型更新后的状态不匹配，请刷新模型列表确认")
        if state == "unchanged":
            if current["path"] == str(candidate):
                raise ModelUncertainError("模型路径状态不匹配，请刷新模型列表确认")
            self._remove_candidate(candidate)
        description = self._describe(current)
        if description["error"]:
            raise ModelUncertainError(f"模型已加载，但{description['error']}；请检查后重试")
        if state == "applied":
            references = [model["path"] for model in models]
            self._sync_policy_aliases(old, current, references)
            self._discard_superseded(old, references)
        return dict(status=state, model=description)
