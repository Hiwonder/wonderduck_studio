"""Bounded and atomic persistence for servo offset profiles."""

from __future__ import annotations

import csv
import logging
import os
import re
import tempfile
from collections.abc import Mapping
from pathlib import Path

OFFSET_PROFILE_FORMAT = "hiwonder-servo-offsets-v1"
SERVO_ID_RANGE = (0, 253)
POSITION_OFFSET_RANGE = (-2047, 2047)
MAX_OFFSET_PROFILE_BYTES = 16 * 1024
MAX_OFFSET_PROFILE_ENTRIES = SERVO_ID_RANGE[1] - SERVO_ID_RANGE[0] + 1
MAX_OFFSET_PROFILE_COLUMNS = 2
MAX_OFFSET_PROFILE_FIELD_LENGTH = 32
MAX_OFFSET_PROFILE_LINE_LENGTH = 128
MAX_OFFSET_PROFILE_LINES = 2 + MAX_OFFSET_PROFILE_ENTRIES
MAX_DIAGNOSTIC_FILENAME_LENGTH = 128
_INTEGER = re.compile(r"-?[0-9]+\Z")
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


class OffsetProfileError(ValueError):
    """A profile violates the versioned offset-file contract."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "invalid_format",
        filename: str | Path | None = None,
    ) -> None:
        self.code = code
        self.filename = None if filename is None else _safe_filename(filename)
        self._diagnostic_message = message
        display = f"{self.filename}: {message}" if self.filename else message
        super().__init__(display)

    def with_filename(self, filename: str | Path) -> OffsetProfileError:
        return type(self)(
            self._diagnostic_message,
            code=self.code,
            filename=filename,
        )


def _parse_integer(value: str, field: str, line_number: int) -> int:
    if len(value) > MAX_OFFSET_PROFILE_FIELD_LENGTH:
        raise OffsetProfileError(
            f"line {line_number}: {field} is too long",
            code="resource_limit",
        )
    if not _INTEGER.fullmatch(value):
        raise OffsetProfileError(f"line {line_number}: {field} must be a decimal integer")
    return int(value)


def _read_lines(path: Path) -> list[str]:
    try:
        if path.stat().st_size > MAX_OFFSET_PROFILE_BYTES:
            raise OffsetProfileError("offset profile exceeds the size limit", code="resource_limit")
        with path.open("rb") as stream:
            content = stream.read(MAX_OFFSET_PROFILE_BYTES + 1)
    except OSError:
        raise OffsetProfileError("cannot read offset profile", code="io_error") from None
    if len(content) > MAX_OFFSET_PROFILE_BYTES:
        raise OffsetProfileError("offset profile exceeds the size limit", code="resource_limit")
    try:
        lines = content.decode("utf-8-sig").splitlines()
    except UnicodeError as error:
        raise OffsetProfileError("offset profile must be UTF-8") from error
    if not lines:
        raise OffsetProfileError("offset profile is empty", code="invalid_document")
    if len(lines) > MAX_OFFSET_PROFILE_LINES:
        raise OffsetProfileError("offset profile exceeds the line limit", code="resource_limit")
    if any(len(line) > MAX_OFFSET_PROFILE_LINE_LENGTH for line in lines):
        raise OffsetProfileError("offset profile line is too long", code="resource_limit")
    return lines


def _load_offset_profile(path: Path) -> dict[int, int]:
    lines = _read_lines(path)
    if len(lines) < 3:
        raise OffsetProfileError("offset profile is incomplete", code="invalid_document")
    if lines[0] != f"# format={OFFSET_PROFILE_FORMAT}":
        raise OffsetProfileError("unsupported offset profile format")
    try:
        rows = csv.reader(lines[1:], strict=True)
        header = next(rows)
        if any(len(field) > MAX_OFFSET_PROFILE_FIELD_LENGTH for field in header):
            raise OffsetProfileError("offset profile header is too long", code="resource_limit")
        if len(header) > MAX_OFFSET_PROFILE_COLUMNS:
            raise OffsetProfileError(
                "offset profile has too many columns",
                code="resource_limit",
            )
        if header != ["servo_id", "position_offset"]:
            raise OffsetProfileError("offset profile header is invalid")
        result: dict[int, int] = {}
        for line_number, row in enumerate(rows, start=3):
            if len(result) >= MAX_OFFSET_PROFILE_ENTRIES:
                raise OffsetProfileError(
                    "offset profile has too many entries",
                    code="resource_limit",
                )
            if len(row) > MAX_OFFSET_PROFILE_COLUMNS:
                raise OffsetProfileError(
                    f"line {line_number}: too many columns",
                    code="resource_limit",
                )
            if len(row) != 2:
                raise OffsetProfileError(f"line {line_number}: invalid column count")
            servo_id = _parse_integer(row[0], "servo_id", line_number)
            offset = _parse_integer(row[1], "position_offset", line_number)
            if not SERVO_ID_RANGE[0] <= servo_id <= SERVO_ID_RANGE[1]:
                raise OffsetProfileError(f"line {line_number}: servo_id must be in 0..253")
            if not POSITION_OFFSET_RANGE[0] <= offset <= POSITION_OFFSET_RANGE[1]:
                raise OffsetProfileError(
                    f"line {line_number}: position_offset must be in -2047..2047"
                )
            if servo_id in result:
                raise OffsetProfileError(f"line {line_number}: duplicate servo_id {servo_id}")
            result[servo_id] = offset
    except csv.Error as error:
        raise OffsetProfileError("invalid offset profile CSV") from error
    if not result:
        raise OffsetProfileError("offset profile has no servo entries", code="invalid_document")
    return result


def load_offset_profile(path: str | Path) -> dict[int, int]:
    """Load a profile without exposing its parent path in diagnostics."""
    source = Path(path)
    try:
        return _load_offset_profile(source)
    except OffsetProfileError as error:
        raise error.with_filename(source) from None
    except OSError:
        raise OffsetProfileError(
            "cannot read offset profile",
            code="io_error",
            filename=source,
        ) from None


def _validated_entries(offsets: Mapping[int, int]) -> list[tuple[int, int]]:
    if not isinstance(offsets, Mapping) or not offsets:
        raise OffsetProfileError("offset profile has no servo entries", code="invalid_document")
    if len(offsets) > MAX_OFFSET_PROFILE_ENTRIES:
        raise OffsetProfileError("offset profile has too many entries", code="resource_limit")
    entries = []
    for servo_id, offset in offsets.items():
        if any(
            isinstance(value, bool) or not isinstance(value, int) for value in (servo_id, offset)
        ):
            raise OffsetProfileError("offset profile entries must be integers")
        if not SERVO_ID_RANGE[0] <= servo_id <= SERVO_ID_RANGE[1]:
            raise OffsetProfileError("servo_id must be in 0..253")
        if not POSITION_OFFSET_RANGE[0] <= offset <= POSITION_OFFSET_RANGE[1]:
            raise OffsetProfileError("position_offset must be in -2047..2047")
        entries.append((servo_id, offset))
    return sorted(entries)


def save_offset_profile(path: str | Path, offsets: Mapping[int, int]) -> None:
    """Atomically save a profile without exposing its parent path in diagnostics."""
    destination = Path(path)
    temporary_name: str | None = None
    try:
        entries = _validated_entries(offsets)
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
            stream.write(f"# format={OFFSET_PROFILE_FORMAT}\n")
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerow(["servo_id", "position_offset"])
            writer.writerows(entries)
            stream.flush()
            if stream.tell() > MAX_OFFSET_PROFILE_BYTES:
                raise OffsetProfileError(
                    "offset profile exceeds the size limit",
                    code="resource_limit",
                )
            os.fsync(stream.fileno())
        os.replace(temporary_name, destination)
        temporary_name = None
    except (OffsetProfileError, OSError, TypeError, ValueError) as error:
        if isinstance(error, OffsetProfileError):
            raise error.with_filename(destination) from None
        raise OffsetProfileError(
            "cannot write offset profile",
            code="io_error",
            filename=destination,
        ) from None
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except OSError as error:
                _LOGGER.warning(
                    "failed to remove temporary offset profile: error_type=%s",
                    type(error).__name__,
                )
