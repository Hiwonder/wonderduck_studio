export function createLiveParameter({ context, send, onVerified, onComplete, onError }) {
  let pending = null, timer = null, inFlight = false, generation = 0, lastSent = -Infinity;

  function cancel() {
    generation++;
    pending = null;
    clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    if (!pending || timer !== null || inFlight) return;
    timer = setTimeout(pump, Math.max(0, 20 - (performance.now() - lastSent)));
  }

  async function pump() {
    timer = null;
    if (!pending || inFlight) return;
    const current = context();
    if (!current.enabled || current.id !== pending.id || current.address !== pending.address) { cancel(); return; }
    const data = pending, version = generation;
    pending = null;
    inFlight = true;
    lastSent = performance.now();
    try {
      const result = await send(data);
      if (!result.verified) throw new Error('参数写入未确认，已停止发送');
      if (version === generation) {
        onVerified?.(data, result);
        if (pending?.value === data.value) pending = null;
        if (!pending) onComplete?.(data);
      }
    } catch (error) {
      if (version === generation) { cancel(); onError(error); }
    } finally {
      inFlight = false;
      schedule();
    }
  }

  function setValue(value) {
    const current = context();
    if (!current.enabled || !Number.isInteger(value) || value < current.min || value > current.max) return false;
    pending = { id: current.id, address: current.address, value };
    schedule();
    return true;
  }

  return { setValue, cancel };
}
