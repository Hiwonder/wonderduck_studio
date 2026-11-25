"""Action documents shared by the browser editor and the serial player."""

import re
import tempfile
import threading
from pathlib import Path

from app.robot.protocol import mirror_action_targets
from vendor.action_editor.csv_document import (
    MAX_ACTION_CSV_BYTES, ActionDocument, load_action_csv, save_action_csv,
)
from vendor.action_editor.models import ACTION_SERVO_COUNT, ActionClip, ActionFrame
from vendor.action_editor.offset_profile import MAX_OFFSET_PROFILE_BYTES, load_offset_profile, save_offset_profile


def document_from_json(data):
    if not isinstance(data, dict) or not isinstance(data.get("frames"), list):
        raise ValueError("动作数据无效")
    frames = []
    for frame in data["frames"]:
        if not isinstance(frame, dict) or not isinstance(frame.get("positions"), dict):
            raise ValueError("动作帧无效")
        values = [None] * ACTION_SERVO_COUNT
        for key, value in frame["positions"].items():
            if not isinstance(key, str) or not key.isascii() or not key.isdecimal():
                raise ValueError("舵机 ID 无效")
            servo_id = int(key)
            if str(servo_id) != key or not 1 <= servo_id <= ACTION_SERVO_COUNT:
                raise ValueError("通用动作舵机 ID 必须为 1～36")
            values[servo_id - 1] = value
        frames.append(ActionFrame(frame.get("duration_ms"), tuple(values)))
    layout = data.get("layout")
    if not isinstance(layout, list) or any(not isinstance(item, list) for item in layout):
        raise ValueError("舵机布局无效")
    return ActionDocument(ActionClip(data.get("action_id"), tuple(frames)),
                          tuple(tuple(item) for item in layout), data.get("layout_scale_percent", 100))


def document_to_json(document):
    return dict(action_id=document.clip.action_id,
                frames=[dict(duration_ms=frame.duration_ms,
                             positions={str(index): value for index, value in enumerate(frame.positions, 1)
                                        if value is not None}) for frame in document.clip.frames],
                layout=[list(item) for item in document.layout],
                layout_scale_percent=document.layout_scale_percent)


class ActionDocuments:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.offset_directory = self.directory.with_name("offset-profiles")
        self.lock = threading.Lock()

    def path(self, name, directory):
        if not isinstance(name, str) or not name or len(name) > 120 or name.strip() != name:
            raise ValueError("动作组名称无效")
        if name in (".", "..") or re.search(r"[\\/\x00-\x1f]", name):
            raise ValueError("动作组名称不能包含路径或控制字符")
        filename = name if name.lower().endswith(".csv") else name + ".csv"
        target = directory / filename
        if target.is_symlink():
            raise ValueError("动作组不能是符号链接")
        return target

    def save(self, command, directory, writer, value):
        overwrite = command.get("overwrite", False)
        if type(overwrite) is not bool:
            raise ValueError("覆盖选项无效")
        with self.lock:
            target = self.path(command.get("name"), directory)
            if target.exists() and not overwrite:
                raise FileExistsError("同名文件已存在")
            writer(target, value)
        return dict(name=target.name)

    def handle(self, command, joints=None, full_servo_range=False):
        operation = command.get("operation")
        if operation == "mirror":
            document = document_from_json(command.get("document"))
            indices = command.get("indices")
            if not isinstance(indices, list) or not indices or any(
                    type(index) is not int or not 0 <= index < len(document.clip.frames) for index in indices):
                raise ValueError("镜像帧序号无效")
            if len(set(indices)) != len(indices) or joints is None:
                raise ValueError("镜像帧序号或机器人配置无效")
            frames = list(document.clip.frames)
            for index in indices:
                frame = frames[index]
                targets = {device_id: value for device_id, value in enumerate(frame.positions, 1) if value is not None}
                mirrored = mirror_action_targets(targets, joints, full_servo_range)
                values = [None] * ACTION_SERVO_COUNT
                for device_id, value in mirrored.items():
                    if not 1 <= device_id <= ACTION_SERVO_COUNT:
                        raise ValueError(f"镜像后 ID {device_id} 不在通用动作范围内")
                    values[device_id - 1] = value
                frames[index] = ActionFrame(frame.duration_ms, tuple(values))
            layout = list(document.layout)
            visible = {entry[0] for entry in layout}
            for frame in frames:
                for device_id, value in enumerate(frame.positions, 1):
                    if value is not None and device_id not in visible:
                        raise ValueError(f"镜像后 ID {device_id} 缺少动作布局")
            result = ActionDocument(ActionClip(document.clip.action_id, tuple(frames)), document.layout,
                                    document.layout_scale_percent)
            return dict(document=document_to_json(result))
        if operation == "parse_offsets":
            content = command.get("content")
            if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_OFFSET_PROFILE_BYTES:
                raise ValueError("偏差文件无效或过大")
            with tempfile.TemporaryDirectory(prefix="console-offset-") as temp:
                path = Path(temp) / "offsets.csv"
                path.write_text(content, encoding="utf-8")
                return dict(offsets=load_offset_profile(path))
        if operation in ("serialize_offsets", "save_offsets"):
            values = command.get("offsets")
            if not isinstance(values, dict) or any(not key.isascii() or not key.isdecimal() for key in values):
                raise ValueError("偏差数据无效")
            offsets = {int(key): value for key, value in values.items()}
            if operation == "save_offsets":
                return self.save(command, self.offset_directory, save_offset_profile, offsets)
            with tempfile.TemporaryDirectory(prefix="console-offset-") as temp:
                path = Path(temp) / "offsets.csv"
                save_offset_profile(path, offsets)
                return dict(content=path.read_text(encoding="utf-8"))
        if operation in ("list", "list_offsets"):
            directory = self.offset_directory if operation == "list_offsets" else self.directory
            if not directory.exists():
                return dict(names=[])
            return dict(names=sorted(path.name for path in directory.iterdir()
                                     if path.suffix.lower() == ".csv" and path.is_file() and not path.is_symlink()))
        if operation == "load":
            path = self.path(command.get("name"), self.directory)
            return dict(document=document_to_json(load_action_csv(path)))
        if operation == "load_offsets":
            return dict(offsets=load_offset_profile(self.path(command.get("name"), self.offset_directory)))
        if operation == "parse":
            content = command.get("content")
            if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_ACTION_CSV_BYTES:
                raise ValueError("动作文件无效或过大")
            with tempfile.TemporaryDirectory(prefix="console-action-") as temp:
                path = Path(temp) / "action.csv"
                path.write_text(content, encoding="utf-8")
                return dict(document=document_to_json(load_action_csv(path)))
        if operation in ("save", "serialize"):
            document = document_from_json(command.get("document"))
            if operation == "serialize":
                with tempfile.TemporaryDirectory(prefix="console-action-") as temp:
                    path = Path(temp) / "action.csv"
                    save_action_csv(path, document)
                    return dict(content=path.read_text(encoding="utf-8"))
            return self.save(command, self.directory, save_action_csv, document)
        raise ValueError("未知动作文件操作")
