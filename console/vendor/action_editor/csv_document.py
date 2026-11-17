"""Validated, bounded and atomic action CSV persistence."""

from __future__ import annotations

import csv
import hashlib
import logging
import os
import re
import sqlite3
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

from .models import ACTION_DURATION_RANGE_MS, ACTION_SERVO_COUNT, ActionClip, ActionFrame

ACTION_CSV_FORMAT = "hiwonder-servo-studio-action-csv-v3"
MAX_ACTION_CSV_BYTES = 8 * 1024 * 1024
MAX_ACTION_CSV_FRAMES = 4096
MAX_ACTION_CSV_COLUMNS = ACTION_SERVO_COUNT + 1
MAX_ACTION_CSV_LINES = 4 + ACTION_SERVO_COUNT + 1 + MAX_ACTION_CSV_FRAMES
MAX_ACTION_CSV_LINE_LENGTH = 1024
MAX_ACTION_CSV_FIELD_LENGTH = 64
MAX_ACTION_CSV_LAYOUT_ENTRIES = ACTION_SERVO_COUNT
MAX_LAYOUT_COORDINATE = 1_000_000
MAX_DIAGNOSTIC_FILENAME_LENGTH = 128
LAYOUT_SCALE_RANGE = (50, 300)
DEFAULT_LAYOUT_SCALE_PERCENT = 100
LEGACY_D6A_SERVO_COUNT = 18
LEGACY_D6A_POSITION_RANGE = (0, 1000)
LEGACY_D6A_POSITION_CENTER = 500
LEGACY_D6A_NATIVE_ANGLE_SPAN = 240
TARGET_NATIVE_ANGLE_SPAN = 360
TARGET_POSITION_MAX_EXCLUSIVE = 4096
DEFAULT_LAYOUT_ORIGIN = (16, 16)
DEFAULT_LAYOUT_STEP = (160, 124)
DEFAULT_LAYOUT_COLUMNS = 4
_SERVO_COLUMN = re.compile(r"servo:([0-9]+)\Z")
_LAYOUT_KEY = re.compile(r"layout_servo:(\d+)")
_LEGACY_D6A_COLUMNS = (
    "Index",
    "Time",
    *[f"Servo{servo_id}" for servo_id in range(1, LEGACY_D6A_SERVO_COUNT + 1)],
)
_LOGGER = logging.getLogger(__name__)


def _safe_filename(value: str | Path) -> str:
    raw_value = os.fspath(value)
    filename = Path(raw_value).name.rsplit("\\", 1)[-1]
    if not filename or filename in {".", ".."}:
        return "<unnamed>"
    filename = "".join(character if character.isprintable() else "?" for character in filename)
    if len(filename) > MAX_DIAGNOSTIC_FILENAME_LENGTH:
        return filename[: MAX_DIAGNOSTIC_FILENAME_LENGTH - 3] + "..."
    return filename


class ActionCsvError(ValueError):
    """Safe action document error which never includes a parent path."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "invalid_document",
        filename: str | Path | None = None,
    ) -> None:
        self.code = code
        self.filename = None if filename is None else _safe_filename(filename)
        self._diagnostic_message = message
        display = f"{self.filename}: {message}" if self.filename else message
        super().__init__(display)

    def with_filename(self, path: str | Path) -> ActionCsvError:
        return type(self)(self._diagnostic_message, code=self.code, filename=path)


@dataclass(frozen=True)
class ActionDocument:
    """An action clip plus the reusable servo-card layout."""

    clip: ActionClip
    layout: tuple[tuple[int, int, int], ...]
    layout_scale_percent: int = 100

    def __post_init__(self) -> None:
        if not isinstance(self.clip, ActionClip):
            raise TypeError("clip must be an ActionClip")
        if not self.clip.frames:
            raise ValueError("action document must contain at least one frame")
        if len(self.clip.frames) > MAX_ACTION_CSV_FRAMES:
            raise ValueError(f"action document must contain at most {MAX_ACTION_CSV_FRAMES} frames")
        if (
            isinstance(self.layout_scale_percent, bool)
            or not isinstance(self.layout_scale_percent, int)
            or not LAYOUT_SCALE_RANGE[0] <= self.layout_scale_percent <= LAYOUT_SCALE_RANGE[1]
        ):
            raise ValueError("layout_scale_percent must be in 50..300")
        if not isinstance(self.layout, tuple):
            raise TypeError("layout must be a tuple")
        layout = self.layout
        if not layout:
            raise ValueError("action document must contain at least one layout entry")
        if len(layout) > MAX_ACTION_CSV_LAYOUT_ENTRIES:
            raise ValueError("action document has too many layout entries")
        ids: set[int] = set()
        for item in layout:
            if not isinstance(item, tuple):
                raise TypeError("layout entries must be tuples")
            if len(item) != 3:
                raise ValueError("layout entries must contain servo_id, x and y")
            servo_id, x, y = item
            if isinstance(servo_id, bool) or not 1 <= servo_id <= ACTION_SERVO_COUNT:
                raise ValueError(f"layout servo ID must be in 1..{ACTION_SERVO_COUNT}")
            if servo_id in ids:
                raise ValueError("layout servo IDs must be unique")
            if any(isinstance(value, bool) or not isinstance(value, int) for value in (x, y)):
                raise TypeError("layout coordinates must be integers")
            if not 0 <= x <= MAX_LAYOUT_COORDINATE or not 0 <= y <= MAX_LAYOUT_COORDINATE:
                raise ValueError(f"layout coordinates must be in 0..{MAX_LAYOUT_COORDINATE}")
            ids.add(servo_id)
        object.__setattr__(self, "layout", tuple(sorted(layout)))


def _error(error: Exception, path: Path) -> ActionCsvError:
    if isinstance(error, ActionCsvError):
        return error.with_filename(path)
    if isinstance(error, OSError):
        return ActionCsvError("cannot access action CSV", code="io_error", filename=path)
    return ActionCsvError("invalid action CSV", filename=path)


def _metadata(document: ActionDocument) -> list[str]:
    result = [
        f"# format={ACTION_CSV_FORMAT}",
        f"# action_id={document.clip.action_id}",
        f"# frame_count={len(document.clip.frames)}",
        f"# layout_scale={document.layout_scale_percent}",
    ]
    result.extend(
        f"# layout_servo:{servo_id}={x},{y}" for servo_id, x, y in sorted(document.layout)
    )
    return result


def save_action_csv(path: str | Path, document: ActionDocument) -> None:
    """Write an action document atomically and report only its filename."""
    destination = Path(path)
    temporary_name: str | None = None
    try:
        if not isinstance(document, ActionDocument):
            raise ActionCsvError("document must be an ActionDocument", code="invalid_format")
        _validate_document(document)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temporary_name = stream.name
            stream.write("\n".join(_metadata(document)) + "\n")
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerow([
                "duration_ms",
                *[
                    f"servo:{item}"
                    for item in range(1, ACTION_SERVO_COUNT + 1)
                ],
            ])
            for frame in document.clip.frames:
                writer.writerow(
                    [
                        frame.duration_ms,
                        *["" if value is None else value for value in frame.positions],
                    ]
                )
            stream.flush()
            if stream.tell() > MAX_ACTION_CSV_BYTES:
                raise ActionCsvError("action CSV exceeds the size limit", code="resource_limit")
            os.fsync(stream.fileno())
        os.replace(temporary_name, destination)
        temporary_name = None
    except (ActionCsvError, OSError, TypeError, ValueError) as error:
        raise _error(error, destination) from None
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except OSError as error:
                _LOGGER.warning(
                    "failed to remove temporary action CSV: error_type=%s",
                    type(error).__name__,
                )


def _read_lines(path: Path) -> list[str]:
    if path.stat().st_size > MAX_ACTION_CSV_BYTES:
        raise ActionCsvError("action CSV exceeds the size limit", code="resource_limit")
    content = path.read_bytes()
    if len(content) > MAX_ACTION_CSV_BYTES:
        raise ActionCsvError("action CSV exceeds the size limit", code="resource_limit")
    try:
        lines = content.decode("utf-8-sig").splitlines()
    except UnicodeError as error:
        raise ActionCsvError("action CSV must be UTF-8", code="invalid_format") from error
    if not lines:
        raise ActionCsvError("action CSV is empty")
    if len(lines) > MAX_ACTION_CSV_LINES:
        raise ActionCsvError("action CSV exceeds the line limit", code="resource_limit")
    if any(len(line) > MAX_ACTION_CSV_LINE_LENGTH for line in lines):
        raise ActionCsvError("action CSV line is too long", code="resource_limit")
    return lines


def _parse_metadata(lines: list[str]) -> tuple[dict[str, str], int]:
    metadata: dict[str, str] = {}
    index = 0
    while index < len(lines) and lines[index].startswith("#"):
        line = lines[index]
        if not line.startswith("# ") or "=" not in line:
            raise ActionCsvError(f"line {index + 1}: invalid metadata")
        key_value = line[2:].split("=", 1)
        if len(key_value) != 2 or not all(key_value):
            raise ActionCsvError(f"line {index + 1}: invalid metadata")
        key, value = key_value
        if key != key.strip() or value != value.strip():
            raise ActionCsvError(f"line {index + 1}: invalid metadata")
        if len(key) > MAX_ACTION_CSV_FIELD_LENGTH or len(value) > MAX_ACTION_CSV_FIELD_LENGTH:
            raise ActionCsvError(
                f"line {index + 1}: metadata field is too long",
                code="resource_limit",
            )
        if key in metadata:
            raise ActionCsvError(f"line {index + 1}: duplicate metadata")
        standard_keys = {"format", "action_id", "frame_count", "layout_scale"}
        if key not in standard_keys and not _LAYOUT_KEY.fullmatch(key):
            raise ActionCsvError(f"line {index + 1}: unsupported metadata")
        metadata[key] = value
        index += 1
    required = {"format", "action_id", "frame_count"}
    if required - metadata.keys():
        raise ActionCsvError("action CSV metadata is incomplete")
    if metadata["format"] != ACTION_CSV_FORMAT:
        raise ActionCsvError("unsupported action CSV format")
    return metadata, index


def _decimal(value: str, field: str) -> int:
    if len(value) > MAX_ACTION_CSV_FIELD_LENGTH:
        raise ActionCsvError(f"{field} is too long", code="resource_limit")
    if not value.isascii() or not value.isdecimal():
        raise ActionCsvError(f"{field} must be a decimal integer")
    return int(value)


def _parse_layout(metadata: dict[str, str]) -> tuple[tuple[int, int, int], ...]:
    layout = []
    for key, value in metadata.items():
        match = _LAYOUT_KEY.fullmatch(key)
        if match is None:
            continue
        coordinates = value.split(",")
        if len(coordinates) != 2:
            raise ActionCsvError("invalid layout coordinates")
        servo_id = _decimal(match.group(1), "layout servo ID")
        x, y = (_decimal(item, "layout coordinate") for item in coordinates)
        if not 1 <= servo_id <= ACTION_SERVO_COUNT:
            raise ActionCsvError(f"layout servo ID must be in 1..{ACTION_SERVO_COUNT}")
        if x > MAX_LAYOUT_COORDINATE or y > MAX_LAYOUT_COORDINATE:
            raise ActionCsvError(f"layout coordinates must be in 0..{MAX_LAYOUT_COORDINATE}")
        layout.append((servo_id, x, y))
    if len(layout) > MAX_ACTION_CSV_LAYOUT_ENTRIES:
        raise ActionCsvError("action CSV has too many layout entries", code="resource_limit")
    if not layout:
        raise ActionCsvError("action CSV has no layout entries")
    return tuple(sorted(layout))


def _parse_layout_scale(metadata: dict[str, str]) -> int:
    value = metadata.get("layout_scale")
    if value is None:
        return DEFAULT_LAYOUT_SCALE_PERCENT
    scale = _decimal(value, "layout_scale")
    if not LAYOUT_SCALE_RANGE[0] <= scale <= LAYOUT_SCALE_RANGE[1]:
        raise ActionCsvError(
            f"layout_scale must be in {LAYOUT_SCALE_RANGE[0]}..{LAYOUT_SCALE_RANGE[1]}"
        )
    return scale


def _validate_document(document: ActionDocument) -> None:
    """Enforce the legacy document invariants beyond the dataclass itself.

    Mirrors the legacy ``_validate_document`` rule that every targeted servo
    of every frame must have a visible layout entry.
    """
    layout_ids = {entry[0] for entry in document.layout}
    for frame in document.clip.frames:
        for servo_id, value in enumerate(frame.positions, start=1):
            if value is not None and servo_id not in layout_ids:
                raise ActionCsvError(
                    f"servo:{servo_id} has no layout entry",
                    code="invalid_document",
                )


def load_action_csv(path: str | Path) -> ActionDocument:
    """Load a complete action CSV with bounded resource use."""
    source = Path(path)
    try:
        lines = _read_lines(source)
        metadata, header_index = _parse_metadata(lines)
        if header_index >= len(lines):
            raise ActionCsvError("action CSV has no header")
        rows = csv.reader(lines[header_index:], strict=True)
        try:
            header = next(rows)
        except StopIteration:
            raise ActionCsvError("action CSV has no header") from None
        if len(header) > MAX_ACTION_CSV_COLUMNS:
            raise ActionCsvError("action CSV has too many columns", code="resource_limit")
        if any(len(field) > MAX_ACTION_CSV_FIELD_LENGTH for field in header):
            raise ActionCsvError("action CSV header field is too long", code="resource_limit")
        if not header or header[0] != "duration_ms":
            raise ActionCsvError("first column must be duration_ms")
        if len(header) < 2:
            raise ActionCsvError("action CSV must define at least one servo column")
        servo_ids: list[int] = []
        seen_ids: set[int] = set()
        for column in header[1:]:
            match = _SERVO_COLUMN.fullmatch(column)
            if match is None:
                raise ActionCsvError("action CSV contains an invalid servo column")
            servo_id = int(match.group(1))
            if not 1 <= servo_id <= ACTION_SERVO_COUNT:
                raise ActionCsvError(f"servo ID must be in 1..{ACTION_SERVO_COUNT}")
            if servo_id in seen_ids:
                raise ActionCsvError(f"duplicate servo column servo:{servo_id}")
            seen_ids.add(servo_id)
            servo_ids.append(servo_id)
        frames = []
        for line_number, row in enumerate(rows, start=header_index + 2):
            if len(frames) >= MAX_ACTION_CSV_FRAMES:
                raise ActionCsvError("action CSV has too many frames", code="resource_limit")
            if not row:
                raise ActionCsvError(f"line {line_number}: blank action frame")
            if len(row) != len(servo_ids) + 1:
                raise ActionCsvError(f"line {line_number}: invalid column count")
            if any(len(field) > MAX_ACTION_CSV_FIELD_LENGTH for field in row):
                raise ActionCsvError(
                    f"line {line_number}: field is too long",
                    code="resource_limit",
                )
            duration = _decimal(row[0], "duration_ms")
            positions: list[int | None] = [None] * ACTION_SERVO_COUNT
            for servo_id, value in zip(servo_ids, row[1:]):
                if value:
                    positions[servo_id - 1] = _decimal(value, "servo position")
            frames.append(ActionFrame(duration, tuple(positions)))
        expected_count = _decimal(metadata["frame_count"], "frame_count")
        if expected_count != len(frames):
            raise ActionCsvError("frame_count does not match action rows")
        document = ActionDocument(
            ActionClip(_decimal(metadata["action_id"], "action_id"), tuple(frames)),
            _parse_layout(metadata),
            _parse_layout_scale(metadata),
        )
        _validate_document(document)
        return document
    except (ActionCsvError, OSError, TypeError, ValueError, csv.Error) as error:
        raise _error(error, source) from None


def _legacy_action_id(path: Path) -> int:
    """Return the stable action ID used by the offline legacy converter."""
    stem = path.stem
    if stem.isdecimal():
        numeric = int(stem)
        if 1 <= numeric <= 0xFFFF:
            return numeric
    digest = hashlib.blake2s(stem.encode("utf-8"), digest_size=4).digest()
    return int.from_bytes(digest, "big") % 0xFFFF + 1


def _round_signed_ratio(numerator: int, denominator: int) -> int:
    """Round a signed ratio to the nearest integer, with halves away from zero."""
    if denominator <= 0:
        raise ValueError("ratio denominator must be positive")
    if numerator < 0:
        return -((-numerator + denominator // 2) // denominator)
    return (numerator + denominator // 2) // denominator


def _convert_legacy_position(position: int) -> int:
    """Map an LX pulse to the HX pulse while preserving its servo angle."""
    minimum, maximum = LEGACY_D6A_POSITION_RANGE
    if isinstance(position, bool) or not isinstance(position, int):
        raise ActionCsvError("legacy servo position must be an integer")
    if not minimum <= position <= maximum:
        raise ActionCsvError(
            f"legacy servo position must be in {minimum}..{maximum}"
        )
    # Legacy LX and current HX action coordinates increase in opposite
    # directions. Preserve the centered span while reversing the delta.
    # Evaluate the migration expression as an exact rational:
    # (4096 * 240 * (lx - 500)) / (360 * 1000).
    delta = _round_signed_ratio(
        (position - LEGACY_D6A_POSITION_CENTER)
        * TARGET_POSITION_MAX_EXCLUSIVE
        * LEGACY_D6A_NATIVE_ANGLE_SPAN,
        TARGET_NATIVE_ANGLE_SPAN * 1000,
    )
    converted = 2048 - delta
    if not 0 <= converted < TARGET_POSITION_MAX_EXCLUSIVE:
        raise ActionCsvError(f"converted servo position is outside 0..4095: {converted}")
    return converted


def _legacy_layout() -> tuple[tuple[int, int, int], ...]:
    origin_x, origin_y = DEFAULT_LAYOUT_ORIGIN
    step_x, step_y = DEFAULT_LAYOUT_STEP
    return tuple(
        (
            servo_id,
            origin_x + (index % DEFAULT_LAYOUT_COLUMNS) * step_x,
            origin_y + (index // DEFAULT_LAYOUT_COLUMNS) * step_y,
        )
        for index, servo_id in enumerate(range(1, LEGACY_D6A_SERVO_COUNT + 1))
    )


def load_action_d6a(path: str | Path) -> ActionDocument:
    """Load a legacy SQLite ``.d6a`` action as a current action document.

    Legacy files contain 18 LX servo slots and no presentation metadata. The
    positions are converted to HX pulses using the aligned midpoint formula,
    while cards use the current four-column default layout.
    """
    source = Path(path)
    connection: sqlite3.Connection | None = None
    try:
        if source.stat().st_size > MAX_ACTION_CSV_BYTES:
            raise ActionCsvError("legacy action exceeds the size limit", code="resource_limit")
        connection = sqlite3.connect(
            f"file:{quote(str(source.resolve()), safe='/')}?mode=ro",
            uri=True,
        )
        connection.execute("PRAGMA query_only = ON")
        tables = connection.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        if [row[0] for row in tables] != ["ActionGroup"]:
            raise ActionCsvError("legacy database must contain only the ActionGroup table")
        columns = tuple(
            row[1] for row in connection.execute('PRAGMA table_info("ActionGroup")')
        )
        if columns != _LEGACY_D6A_COLUMNS:
            raise ActionCsvError(
                "legacy ActionGroup columns must be Index, Time, Servo1..Servo18"
            )
        selected = ", ".join(f'"{column}"' for column in _LEGACY_D6A_COLUMNS)
        rows = connection.execute(
            f'SELECT {selected} FROM "ActionGroup" ORDER BY "Index" ASC'
        )
        frames: list[ActionFrame] = []
        previous_index = 0
        for row_number, row in enumerate(rows, start=1):
            if len(frames) >= MAX_ACTION_CSV_FRAMES:
                raise ActionCsvError("legacy action has too many frames", code="resource_limit")
            index, duration, *positions = row
            if isinstance(index, bool) or not isinstance(index, int) or index <= previous_index:
                raise ActionCsvError(f"legacy frame {row_number} index is invalid")
            previous_index = index
            if isinstance(duration, bool) or not isinstance(duration, int):
                raise ActionCsvError(f"legacy frame {row_number} duration must be an integer")
            if not ACTION_DURATION_RANGE_MS[0] <= duration <= ACTION_DURATION_RANGE_MS[1]:
                raise ActionCsvError(
                    f"legacy frame {row_number} duration must be in "
                    f"{ACTION_DURATION_RANGE_MS[0]}..{ACTION_DURATION_RANGE_MS[1]} ms"
                )
            converted: list[int | None] = [None] * ACTION_SERVO_COUNT
            for servo_index, position in enumerate(positions):
                if position is not None:
                    converted[servo_index] = _convert_legacy_position(position)
            if not any(value is not None for value in converted):
                raise ActionCsvError(f"legacy frame {row_number} has no servo targets")
            frames.append(ActionFrame(duration, tuple(converted)))
        if not frames:
            raise ActionCsvError("legacy action contains no frames")
        return ActionDocument(
            ActionClip(_legacy_action_id(source), tuple(frames)),
            _legacy_layout(),
        )
    except (ActionCsvError, OSError, TypeError, ValueError, sqlite3.Error) as error:
        raise _error(error, source) from None
    finally:
        if connection is not None:
            connection.close()
