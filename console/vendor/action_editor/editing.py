"""Pure action editor state and deterministic frame transformations."""

from __future__ import annotations

from .models import (
    ACTION_DURATION_RANGE_MS,
    ACTION_SERVO_COUNT,
    SERVO_POSITION_CENTER,
    SERVO_POSITION_RANGE,
    ActionClip,
    ActionFrame,
)


class ActionEditingState:
    """Own mutable editor selection while keeping action values immutable."""

    def __init__(self, clip: ActionClip | None = None, default_duration_ms: int = 1000) -> None:
        if not ACTION_DURATION_RANGE_MS[0] <= default_duration_ms <= ACTION_DURATION_RANGE_MS[1]:
            raise ValueError("default_duration_ms must be in 1..30000")
        self.clip = clip or ActionClip(1)
        self.default_duration_ms = int(default_duration_ms)
        self.selected_frame_index = -1
        self.editor_duration_ms = self.default_duration_ms
        self.speed_percent = 100
        self.speed_enabled = False
        self.lock_time = False

    def set_action_id(self, action_id: int) -> None:
        self.clip = ActionClip(action_id, self.clip.frames)

    def select(self, index: int) -> None:
        self._require_index(index)
        self.selected_frame_index = index
        if not self.lock_time:
            self.editor_duration_ms = self.clip.frames[index].duration_ms

    def set_editor_duration(self, duration_ms: int) -> None:
        self.editor_duration_ms = ActionFrame(
            duration_ms,
            (SERVO_POSITION_CENTER,) * ACTION_SERVO_COUNT,
        ).duration_ms

    def set_lock_time(self, locked: bool) -> None:
        if not isinstance(locked, bool):
            raise TypeError("locked must be a boolean")
        self.lock_time = locked
        self._sync_duration()

    def insert(self, positions: tuple[int | None, ...] | None = None) -> None:
        if positions is not None:
            resolved = positions
        elif self.clip.frames:
            source_index = min(max(self.selected_frame_index, 0), len(self.clip.frames) - 1)
            resolved = self.clip.frames[source_index].positions
        else:
            resolved = (SERVO_POSITION_CENTER,) * ACTION_SERVO_COUNT
        frame = ActionFrame(self.editor_duration_ms, resolved)
        index = min(self.selected_frame_index + 1, len(self.clip.frames))
        frames = list(self.clip.frames)
        frames.insert(index, frame)
        self.clip = ActionClip(self.clip.action_id, tuple(frames))
        self.selected_frame_index = index

    def replace_selected(self, positions: tuple[int | None, ...]) -> None:
        self._require_selection()
        frames = list(self.clip.frames)
        frames[self.selected_frame_index] = ActionFrame(self.editor_duration_ms, positions)
        self.clip = ActionClip(self.clip.action_id, tuple(frames))

    def replace_position(self, frame_index: int, servo_id: int, position: int) -> None:
        self._require_index(frame_index)
        self._require_servo_id(servo_id)
        frame = self.clip.frames[frame_index]
        positions = list(frame.positions)
        positions[servo_id - 1] = position
        frames = list(self.clip.frames)
        frames[frame_index] = ActionFrame(frame.duration_ms, tuple(positions))
        self.clip = ActionClip(self.clip.action_id, tuple(frames))

    def clear_position(self, frame_index: int, servo_id: int) -> None:
        self._require_index(frame_index)
        self._require_servo_id(servo_id)
        frame = self.clip.frames[frame_index]
        positions = list(frame.positions)
        positions[servo_id - 1] = None
        frames = list(self.clip.frames)
        frames[frame_index] = ActionFrame(frame.duration_ms, tuple(positions))
        self.clip = ActionClip(self.clip.action_id, tuple(frames))

    def clear(self) -> None:
        self.clip = ActionClip(self.clip.action_id)
        self.selected_frame_index = -1
        self._sync_duration()

    def append(self, positions: tuple[int | None, ...]) -> None:
        frame = ActionFrame(self.editor_duration_ms, positions)
        self.clip = ActionClip(self.clip.action_id, self.clip.frames + (frame,))
        self.selected_frame_index = len(self.clip.frames) - 1

    def append_clip(self, clip: ActionClip) -> None:
        self.clip = ActionClip(self.clip.action_id, self.clip.frames + clip.frames)
        if clip.frames:
            self.selected_frame_index = len(self.clip.frames) - 1
            self._sync_duration()

    def load_clip(self, clip: ActionClip) -> None:
        if not isinstance(clip, ActionClip):
            raise TypeError("clip must be an ActionClip")
        self.clip = clip
        self.selected_frame_index = 0 if clip.frames else -1
        self._sync_duration()

    def delete_selected(self) -> None:
        self._require_selection()
        frames = list(self.clip.frames)
        del frames[self.selected_frame_index]
        self.clip = ActionClip(self.clip.action_id, tuple(frames))
        self.selected_frame_index = min(self.selected_frame_index, len(frames) - 1)
        self._sync_duration()

    def move_selected(self, offset: int) -> bool:
        self._require_selection()
        destination = self.selected_frame_index + int(offset)
        if not 0 <= destination < len(self.clip.frames):
            return False
        frames = list(self.clip.frames)
        frame = frames.pop(self.selected_frame_index)
        frames.insert(destination, frame)
        self.clip = ActionClip(self.clip.action_id, tuple(frames))
        self.selected_frame_index = destination
        return True

    def move_selected_to(self, destination: int) -> bool:
        self._require_selection()
        if isinstance(destination, bool) or not 0 <= destination < len(self.clip.frames):
            raise IndexError("action frame destination is out of range")
        if destination == self.selected_frame_index:
            return False
        frames = list(self.clip.frames)
        frame = frames.pop(self.selected_frame_index)
        frames.insert(destination, frame)
        self.clip = ActionClip(self.clip.action_id, tuple(frames))
        self.selected_frame_index = destination
        return True

    def set_selected_duration(self, duration_ms: int) -> None:
        self._require_selection()
        frame = self.clip.frames[self.selected_frame_index]
        replacement = ActionFrame(duration_ms, frame.positions)
        frames = list(self.clip.frames)
        frames[self.selected_frame_index] = replacement
        self.clip = ActionClip(self.clip.action_id, tuple(frames))
        self.editor_duration_ms = replacement.duration_ms

    def set_duration(self, frame_index: int, duration_ms: int) -> None:
        self._require_index(frame_index)
        frame = self.clip.frames[frame_index]
        replacement = ActionFrame(duration_ms, frame.positions)
        frames = list(self.clip.frames)
        frames[frame_index] = replacement
        self.clip = ActionClip(self.clip.action_id, tuple(frames))
        if frame_index == self.selected_frame_index and not self.lock_time:
            self.editor_duration_ms = replacement.duration_ms

    def mirror(self, *, selected_only: bool = False) -> None:
        if selected_only:
            self._require_selection()
            indices = (self.selected_frame_index,)
        else:
            indices = range(len(self.clip.frames))
        frames = list(self.clip.frames)
        minimum, maximum = SERVO_POSITION_RANGE
        for index in indices:
            source = frames[index]
            mirrored = list(source.positions)
            for left in range(0, ACTION_SERVO_COUNT, 2):
                right = left + 1
                left_value = source.positions[left]
                right_value = source.positions[right]
                mirrored[left] = None if right_value is None else minimum + maximum - right_value
                mirrored[right] = None if left_value is None else minimum + maximum - left_value
            frames[index] = ActionFrame(source.duration_ms, tuple(mirrored))
        self.clip = ActionClip(self.clip.action_id, tuple(frames))

    def scale_speed(self, percent: int) -> None:
        if isinstance(percent, bool) or not 1 <= percent <= 1000:
            raise ValueError("speed percent must be in 1..1000")
        minimum, maximum = ACTION_DURATION_RANGE_MS
        frames = tuple(
            ActionFrame(
                max(minimum, min(maximum, round(frame.duration_ms * 100 / percent))),
                frame.positions,
            )
            for frame in self.clip.frames
        )
        self.clip = ActionClip(self.clip.action_id, frames)
        self._sync_duration()

    def set_speed_percent(self, percent: int) -> None:
        if isinstance(percent, bool) or not 1 <= percent <= 1000:
            raise ValueError("speed percent must be in 1..1000")
        if self.speed_enabled and percent != self.speed_percent:
            raise RuntimeError("disable speed scaling before changing its percent")
        self.speed_percent = percent

    def set_speed_enabled(self, enabled: bool) -> None:
        if not isinstance(enabled, bool):
            raise TypeError("enabled must be a boolean")
        if enabled == self.speed_enabled:
            return
        minimum, maximum = ACTION_DURATION_RANGE_MS
        factor = 100 / self.speed_percent if enabled else self.speed_percent / 100
        frames = tuple(
            ActionFrame(
                max(minimum, min(maximum, round(frame.duration_ms * factor))),
                frame.positions,
            )
            for frame in self.clip.frames
        )
        self.clip = ActionClip(self.clip.action_id, frames)
        self.speed_enabled = enabled
        self._sync_duration()

    def _require_index(self, index: int) -> None:
        if isinstance(index, bool) or not 0 <= index < len(self.clip.frames):
            raise IndexError("action frame index is out of range")

    def _require_selection(self) -> None:
        self._require_index(self.selected_frame_index)

    @staticmethod
    def _require_servo_id(servo_id: int) -> None:
        if isinstance(servo_id, bool) or not 1 <= servo_id <= ACTION_SERVO_COUNT:
            raise ValueError(f"servo ID must be in 1..{ACTION_SERVO_COUNT}")

    def _sync_duration(self) -> None:
        if self.selected_frame_index < 0:
            self.editor_duration_ms = self.default_duration_ms
        elif not self.lock_time:
            self.editor_duration_ms = self.clip.frames[self.selected_frame_index].duration_ms


def mask_locked_servos(clip: ActionClip, locked_ids: set[int]) -> ActionClip:
    """Return a clip with locked targets removed, failing on empty frames."""
    for servo_id in locked_ids:
        if isinstance(servo_id, bool) or not 1 <= servo_id <= ACTION_SERVO_COUNT:
            raise ValueError(f"locked servo IDs must be in 1..{ACTION_SERVO_COUNT}")
    frames = tuple(
        ActionFrame(
            frame.duration_ms,
            tuple(
                None if servo_id in locked_ids else position
                for servo_id, position in enumerate(frame.positions, start=1)
            ),
        )
        for frame in clip.frames
    )
    return ActionClip(clip.action_id, frames)
