import { createLiveTarget } from './live-target.js';

function partnerId(id) {
  if (!Number.isInteger(id)) return null;
  if (id >= 10 && id <= 14) return id + 10;
  if (id >= 20 && id <= 24) return id - 10;
  return null;
}

export function createLinkedTarget({ context, isSelected, send, onError, onComplete, onTarget }) {
  const linkedPartner = id => {
    const partner = partnerId(id);
    return partner !== null && isSelected(partner) ? partner : null;
  };
  const ready = current => current.enabled && Number.isInteger(current.actual);

  function enabled() {
    const source = context(), partner = linkedPartner(source.id);
    return ready(source) && (partner === null || ready(context(partner)));
  }

  function cancel() { controllers.forEach(controller => controller.cancel()); }

  const controllers = [false, true].map(follow => createLiveTarget({
    context: () => {
      const source = context(), partner = linkedPartner(source.id);
      if (follow && partner === null) return { enabled: false };
      return { ...(follow ? context(partner) : source), enabled: enabled() };
    },
    send,
    onComplete,
    onError: error => { cancel(); onError(error); },
  }));

  function setTarget(raw) {
    const source = context(), partner = linkedPartner(source.id);
    const follower = partner === null ? null : context(partner);
    const mirrored = 4096 - raw;
    let error = null;
    if (!enabled()) error = '请确认所控舵机在线且扭矩已开启；联动时两侧均须满足';
    else if (!Number.isInteger(raw) || raw < source.min || raw > source.max) error = '目标位置超出所选舵机行程';
    else if (follower && (mirrored < follower.min || mirrored > follower.max)) {
      error = `联动目标 ID ${partner}：${mirrored} 步超出 ${follower.min}～${follower.max}，未下发`;
    }
    if (error) { cancel(); onError(new Error(error)); return false; }
    if (!controllers[0].setTarget(raw)) return false;
    if (follower) {
      if (!controllers[1].setTarget(mirrored)) { cancel(); return false; }
      onTarget(partner, mirrored);
    }
    return true;
  }

  return { setTarget, cancel, enabled };
}
