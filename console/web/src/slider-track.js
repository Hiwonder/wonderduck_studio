const THUMB_SIZE = 12;
const REPEAT_DELAY_MS = 300;
const REPEAT_INTERVAL_MS = 45;

export function createSliderTrack() {
  let gesture = null, timer = null;

  function cancel() {
    clearTimeout(timer);
    timer = null;
    const previous = gesture;
    gesture = null;
    if (previous?.slider.hasPointerCapture(previous.pointerId)) {
      previous.slider.releasePointerCapture(previous.pointerId);
    }
  }

  function setValue(slider, value) {
    if (slider.disabled || !slider.isConnected || document.hidden) { cancel(); return; }
    const min = Number(slider.min), max = Number(slider.max), step = Number(slider.step);
    const next = Math.max(min, Math.min(max, min + Math.round((value - min) / step) * step));
    if (next === Number(slider.value)) return;
    slider.value = next;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function repeat() {
    if (!gesture) return;
    const current = gesture;
    setValue(current.slider, Number(current.slider.value) + current.direction * Number(current.slider.step));
    if (gesture !== current) return;
    current.repeated = true;
    timer = setTimeout(repeat, REPEAT_INTERVAL_MS);
  }

  function bind(slider) {
    slider.addEventListener('touchstart', event => {
      if (gesture?.slider === slider) event.preventDefault();
    }, { passive: false });
    slider.addEventListener('pointerdown', event => {
      if (slider.disabled || event.button !== 0 || event.isPrimary === false) return;
      const min = Number(slider.min), max = Number(slider.max), value = Number(slider.value);
      const bounds = slider.getBoundingClientRect();
      if (max <= min || !slider.clientWidth || !bounds.width) return;
      const scale = bounds.width / slider.clientWidth;
      const thumb = THUMB_SIZE * scale;
      const center = bounds.left + thumb / 2 + (value - min) / (max - min) * (bounds.width - thumb);
      if (Math.abs(event.clientX - center) <= thumb / 2) return;
      event.preventDefault();
      cancel();
      slider.focus({ preventScroll: true });
      slider.setPointerCapture(event.pointerId);
      gesture = { slider, pointerId: event.pointerId, startX: event.clientX, scale,
        direction: event.clientX < center ? -1 : 1, moved: false, repeated: false };
      timer = setTimeout(repeat, REPEAT_DELAY_MS);
    });
    slider.addEventListener('pointermove', event => {
      if (!gesture || gesture.slider !== slider || gesture.pointerId !== event.pointerId) return;
      if (!gesture.moved && Math.abs(event.clientX - gesture.startX) <= 2 * gesture.scale) return;
      gesture.moved = true;
      clearTimeout(timer);
      timer = null;
      const bounds = slider.getBoundingClientRect();
      const min = Number(slider.min), max = Number(slider.max);
      const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      setValue(slider, min + position * (max - min));
    });
    slider.addEventListener('pointerup', event => {
      if (!gesture || gesture.slider !== slider || gesture.pointerId !== event.pointerId) return;
      const previous = gesture;
      cancel();
      if (!previous.moved && !previous.repeated) {
        setValue(slider, Number(slider.value) + previous.direction * Number(slider.step));
      }
    });
    for (const type of ['pointercancel', 'lostpointercapture']) slider.addEventListener(type, event => {
      if (gesture?.slider === slider && gesture.pointerId === event.pointerId) cancel();
    });
  }

  for (const type of ['blur', 'pagehide']) window.addEventListener(type, cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  return { bind, cancel };
}
