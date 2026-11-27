export function createLiveTarget({ context, send, onError, onComplete }) {
  let pending = null, inFlight = null, generation = 0;

  function cancel() {
    generation++;
    pending = null;
  }

  function pump() {
    if (!pending || inFlight) return;
    const current = context();
    if (!current.enabled || current.id !== pending.id) { cancel(); return; }
    const data = pending, version = generation;
    pending = null;
    inFlight = sendTarget(data, version).finally(() => {
      inFlight = null;
      pump();
    });
  }

  async function sendTarget(data, version) {
    try {
      const result = await send(data);
      if (!result.sent) throw new Error('目标未能发送');
      if (version === generation && !pending) onComplete?.(data.id);
    } catch (error) {
      if (version === generation) { cancel(); onError(error, data.id); }
    }
  }

  async function flush() {
    while (inFlight) await inFlight;
  }

  function setTarget(raw) {
    const current = context();
    if (!current.enabled || !Number.isInteger(raw)) return false;
    pending = { id: current.id, raw: Math.max(current.min, Math.min(current.max, raw)), speed: 0 };
    pump();
    return true;
  }

  return { setTarget, cancel, flush, busy: () => inFlight !== null };
}
