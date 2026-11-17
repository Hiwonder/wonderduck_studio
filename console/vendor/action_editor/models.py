"""Immutable data edited by the common action editor."""

from __future__ import annotations

from dataclasses import dataclass

ACTION_ID_RANGE = (1, 0xFFFF)
ACTION_DURATION_RANGE_MS = (1, 30_000)
ACTION_SERVO_COUNT = 36
MAX_ACTION_FRAME_COUNT = 0xFFFF
SERVO_POSITION_RANGE = (0, 4095)
SERVO_POSITION_CENTER = 2048


def _integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer")
    return value


@dataclass(frozen=True)
class ActionFrame:
    """One duration and up to 36 sparse servo targets."""

    duration_ms: int
    positions: tuple[int | None, ...]

    def __post_init__(self) -> None:
        duration = _integer(self.duration_ms, "duration_ms")
        if not ACTION_DURATION_RANGE_MS[0] <= duration <= ACTION_DURATION_RANGE_MS[1]:
            raise ValueError("duration_ms must be in 1..30000")
        positions = tuple(self.positions)
        if len(positions) != ACTION_SERVO_COUNT:
            raise ValueError(f"positions must contain {ACTION_SERVO_COUNT} values")
        if not any(position is not None for position in positions):
            raise ValueError("an action frame must contain at least one servo target")
        for position in positions:
            if position is None:
                continue
            value = _integer(position, "servo position")
            if not SERVO_POSITION_RANGE[0] <= value <= SERVO_POSITION_RANGE[1]:
                raise ValueError("servo position must be in 0..4095")
        object.__setattr__(self, "positions", positions)


@dataclass(frozen=True)
class ActionClip:
    """Editable action identified by its controller action ID."""

    action_id: int
    frames: tuple[ActionFrame, ...] = ()

    def __post_init__(self) -> None:
        action_id = _integer(self.action_id, "action_id")
        if not ACTION_ID_RANGE[0] <= action_id <= ACTION_ID_RANGE[1]:
            raise ValueError("action_id must be in 1..65535")
        frames = tuple(self.frames)
        if len(frames) > MAX_ACTION_FRAME_COUNT:
            raise ValueError(f"an action must contain at most {MAX_ACTION_FRAME_COUNT} frames")
        if any(not isinstance(frame, ActionFrame) for frame in frames):
            raise TypeError("frames must contain ActionFrame values")
        object.__setattr__(self, "frames", frames)


def frame_from_positions(positions: tuple[int | None, ...], duration_ms: int = 1000) -> ActionFrame:
    return ActionFrame(duration_ms, positions)
