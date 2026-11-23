"""Shared paths for the robot runtime used by Studio services."""

import json
import logging
import os
from pathlib import Path
import re
import tempfile
import threading


RELEASE_VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-dev\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))?\Z")
REVISION = re.compile(r"[0-9a-f]{40}\Z")
PALETTES = frozenset(("white_orange", "yellow_black", "black_orange", "navy"))
DEFAULT_PALETTE = "yellow_black"
DEFAULT_PALETTE_PATH = Path.home() / ".config" / "wonderduck-studio" / "model-palette.json"
DEFAULT_NETWORK_ANNOUNCEMENT_PATH = Path.home() / ".config" / "wonderduck-studio" / "network-announcement.json"


class ModelPaletteStore:
    """Keep the 3D palette in the device owner's persistent configuration."""

    def __init__(self, path=DEFAULT_PALETTE_PATH):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.value = DEFAULT_PALETTE
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            value = data.get("palette") if isinstance(data, dict) else None
            if value not in PALETTES:
                raise ValueError("模型配色无效")
            self.value = value
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError) as error:
            logging.warning("读取模型配色失败，使用默认配色：%s", error)

    def snapshot(self):
        with self.lock:
            return dict(palette=self.value)

    def save(self, palette):
        if not isinstance(palette, str) or palette not in PALETTES:
            raise ValueError("模型配色无效")
        with self.lock:
            if palette == self.value:
                return dict(palette=self.value)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, name = tempfile.mkstemp(prefix=".model-palette-", suffix=".tmp", dir=str(self.path.parent))
            temporary = Path(name)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    json.dump(dict(palette=palette), stream, ensure_ascii=False)
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(str(temporary), str(self.path))
                self.value = palette
                directory = os.open(str(self.path.parent), os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                if temporary.exists():
                    temporary.unlink()
            return dict(palette=self.value)


class NetworkAnnouncementStore:
    """Persist whether network details are spoken automatically at boot."""

    def __init__(self, path=DEFAULT_NETWORK_ANNOUNCEMENT_PATH):
        self.path = Path(path)
        self.lock = threading.Lock()

    def snapshot(self):
        with self.lock:
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return dict(enabled=True)
            if not isinstance(value, dict) or type(value.get("enabled")) is not bool:
                raise ValueError("网络播报设置无效")
            return dict(enabled=value["enabled"])

    def save(self, enabled):
        if type(enabled) is not bool:
            raise ValueError("网络播报设置无效")
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, name = tempfile.mkstemp(prefix=".network-announcement-", suffix=".tmp", dir=str(self.path.parent))
            temporary = Path(name)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    json.dump(dict(enabled=enabled), stream)
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(str(temporary), str(self.path))
                directory = os.open(str(self.path.parent), os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                if temporary.exists():
                    temporary.unlink()
            return dict(enabled=enabled)


def robot_root(value=None):
    """Resolve the configured robot directory independently of the Studio checkout."""
    if value is None:
        value = os.environ.get("ROBOT_ROOT", str(Path.home() / "wonderduck"))
    return Path(value).expanduser().resolve()


def software_version(root=None, identity_path=Path("/run/robotd/identity.json")):
    """Report the installed release or the running build's identity."""
    def read_object(path):
        try:
            with path.open("r", encoding="utf-8") as stream:
                text = stream.read(16385)
            value = json.loads(text) if len(text) <= 16384 else None
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError, UnicodeError):
            return {}

    marker = read_object(robot_root(root) / ".runtime-release.json")
    version, tag, source = marker.get("version"), marker.get("tag"), marker.get("source_revision")
    release = (version if marker.get("install_status") == "installed" and isinstance(version, str)
               and RELEASE_VERSION.fullmatch(version) and tag == "v" + version
               and isinstance(source, str) and REVISION.fullmatch(source) else None)
    identity = read_object(Path(identity_path))
    running = identity.get("revision")
    if isinstance(running, str) and REVISION.fullmatch(running):
        if not release or running != source:
            return "本地构建 · " + running[:8]
    if release:
        return release
    running_version = identity.get("version")
    return running_version if isinstance(running_version, str) and RELEASE_VERSION.fullmatch(running_version) else None
