export function bindMotionInput({
  state, headStickAxes, isVisionPage, headStickAvailable, displayMode, sticksBlocked,
  motionUnavailable, remindMotion, sendInput, triggerRanges,
}) {
  const headStickKnob = [0, 0];
  const knobs = new Map();
  const pads = [...document.querySelectorAll('.pad')];
  const stickLocks = new Map([...document.querySelectorAll('[data-stick-lock]')]
    .map(input => [input.dataset.stickLock, input]));
  const stickKeys = {
    left: ['KeyW', 'KeyS', 'KeyA', 'KeyD'],
    right: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
  };
  const positionLocked = side => document.body.dataset.consolePage === 'control' && stickLocks.get(side)?.checked === true;
  const axisLockTangent = Math.tan(20 * Math.PI / 180);
  const axisLockPad = pads.find(pad => pad.dataset.stick === 'left');
  const clamp = value => Math.max(-1, Math.min(1, value));

  const updateAxisLockIndicator = () => {
    const x = Math.abs(state.left_x);
    const y = Math.abs(state.left_y);
    let active = "";
    if (displayMode() === "drive" && y > 0 && x <= y * axisLockTangent) {
      active = state.left_y > 0 ? "forward" : "backward";
    } else if (displayMode() === "drive" && x > 0 && y <= x * axisLockTangent) {
      active = state.left_x < 0 ? "left" : "right";
    }
    for (const direction of ["forward", "backward", "left", "right"]) {
      axisLockPad.classList.toggle(`axis-lock-${direction}`, active === direction);
    }
  };

  const updateKnobs = () => {
    knobs.forEach((knob, side) => {
      const [x, y] = side === 'head' ? headStickKnob : [state[`${side}_x`], state[`${side}_y`]];
      knob.style.left = `${50 + x * 38}%`;
      knob.style.top = `${50 - y * 38}%`;
      knob.parentElement.classList.toggle('is-locked', positionLocked(side));
    });
    updateAxisLockIndicator();
  };

  const setStickLock = (side, lock) => {
    const input = stickLocks.get(side);
    input.checked = lock && !input.disabled && state.active;
    if (!input.checked) {
      stickKeys[side].forEach(key => keys.delete(key));
      state[`${side}_x`] = state[`${side}_y`] = 0;
      const pad = knobs.get(side).parentElement;
      if (pad.dataset.pointer) {
        const id = Number(pad.dataset.pointer);
        delete pad.dataset.pointer;
        if (pad.hasPointerCapture(id)) pad.releasePointerCapture(id);
        pad.classList.remove('is-active');
      }
    }
    updateKnobs();
    sendInput();
  };
  stickLocks.forEach((input, side) => {
    input.addEventListener('change', () => setStickLock(side, input.checked));
    const label = input.closest('label');
    let handledTouchId = null;
    // A finger holding the joystick may prevent a second finger from generating a click.
    label.addEventListener('pointerdown', event => {
      handledTouchId = null;
      if (document.body.dataset.consolePage !== 'control' || event.pointerType !== 'touch'
        || event.isPrimary || input.disabled) return;
      handledTouchId = event.pointerId;
      event.preventDefault();
      setStickLock(side, !input.checked);
    });
    label.addEventListener('click', event => {
      if (event.pointerId === handledTouchId) event.preventDefault();
      handledTouchId = null;
    });
  });
  pads.forEach((pad) => {
    const side = pad.dataset.stick;
    const lock = stickLocks.get(side);
    const blocked = () => sticksBlocked() || (side === 'head'
      && !headStickAvailable());
    knobs.set(side, pad.querySelector(".knob"));
    const setFromPointer = (event) => {
      const rect = pad.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = 1 - ((event.clientY - rect.top) / rect.height) * 2;
      if (side === 'head') {
        const radius = Math.max(1, Math.hypot(x, y));
        headStickKnob[0] = x / radius;
        headStickKnob[1] = y / radius;
        headStickAxes.fill(0);
        const deadzone = 0.1;
        const axis = Math.abs(x) >= Math.abs(y) ? 0 : 1;
        const deflection = headStickKnob[axis];
        if (Math.abs(deflection) > deadzone) {
          headStickAxes[axis] = Math.sign(deflection) * (Math.abs(deflection) - deadzone) / (1 - deadzone);
        }
      } else {
        state[`${side}_x`] = clamp(x);
        state[`${side}_y`] = clamp(y);
      }
      updateKnobs();
      sendInput();
    };
    pad.addEventListener("pointerdown", (event) => {
      if (!state.active || blocked() || pad.dataset.pointer) return;
      pad.dataset.pointer = event.pointerId;
      pad.setPointerCapture(event.pointerId);
      pad.classList.add("is-active");
      setFromPointer(event);
    });
    pad.addEventListener("pointermove", (event) => {
      if (state.active && !blocked() && pad.hasPointerCapture(event.pointerId)) setFromPointer(event);
    });
    const release = (event) => {
      if (pad.dataset.pointer !== String(event.pointerId)) return;
      delete pad.dataset.pointer;
      if (pad.hasPointerCapture(event.pointerId)) pad.releasePointerCapture(event.pointerId);
      pad.classList.remove("is-active");
      if (side === 'head') {
        headStickAxes.fill(0);
        headStickKnob.fill(0);
      } else if (event.type !== 'pointerup' || !(positionLocked(side) || (isVisionPage() && lock.checked))) {
        lock.checked = false;
        state[`${side}_x`] = state[`${side}_y`] = 0;
      }
      updateKnobs();
      sendInput();
    };
    pad.addEventListener("pointerup", release);
    pad.addEventListener("pointercancel", release);
    pad.addEventListener("lostpointercapture", release);
  });

  const keys = new Set();
  const tracked = new Set(Object.values(stickKeys).flat());
  const updateKeys = () => {
    for (const [side, [up, down, left, right]] of Object.entries(stickKeys)) {
      if (document.body.dataset.consolePage === 'control' && knobs.get(side).parentElement.dataset.pointer) continue;
      const holdsPosition = positionLocked(side) || (isVisionPage() && stickLocks.get(side).checked);
      if (holdsPosition && !stickKeys[side].some(key => keys.has(key))) continue;
      state[`${side}_y`] = (keys.has(up) ? 1 : 0) - (keys.has(down) ? 1 : 0);
      state[`${side}_x`] = (keys.has(right) ? 1 : 0) - (keys.has(left) ? 1 : 0);
    }
    updateKnobs();
    sendInput();
  };
  window.addEventListener("keydown", (event) => {
    if (!state.active || sticksBlocked() || event.repeat) return;
    if (/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(event.target.tagName)
      && !event.target.matches('[data-stick-lock]')) return;
    const lockSide = document.body.dataset.consolePage === 'control' && !event.altKey && !event.ctrlKey && !event.metaKey
      ? ({KeyQ: 'left', KeyE: 'right'})[event.code] : null;
    if (!tracked.has(event.code) && !lockSide) return;
    if (motionUnavailable()) { event.preventDefault(); remindMotion(); return; }
    event.preventDefault();
    if (lockSide) {
      setStickLock(lockSide, !stickLocks.get(lockSide).checked);
      return;
    }
    keys.add(event.code);
    updateKeys();
  });
  window.addEventListener("keyup", (event) => {
    if (!tracked.has(event.code) || !keys.has(event.code)) return;
    event.preventDefault();
    keys.delete(event.code);
    updateKeys();
  });

  function reset() {
    stickLocks.forEach(input => { input.checked = false; });
    state.left_x = state.left_y = state.right_x = state.right_y = 0;
    headStickAxes.fill(0);
    headStickKnob.fill(0);
    state.left_trigger = state.right_trigger = 0;
    state.buttons = [];
    triggerRanges.forEach((range) => { range.value = "0"; });
    pads.forEach((pad) => {
      pad.classList.remove("is-active");
      if (pad.dataset.pointer) {
        const id = Number(pad.dataset.pointer);
        delete pad.dataset.pointer;
        if (pad.hasPointerCapture(id)) pad.releasePointerCapture(id);
      }
    });
    updateKnobs();
  }

  function setDisabled(disabled) {
    pads.forEach(pad => pad.setAttribute('aria-disabled', String(disabled)));
    stickLocks.forEach(input => { input.disabled = disabled || motionUnavailable(); });
  }

  function renderMode() {
    axisLockPad.classList.toggle('axis-lock-mode', displayMode() === 'drive');
    updateAxisLockIndicator();
  }

  return {keys, reset, setDisabled, renderMode, updateKnobs};
}
