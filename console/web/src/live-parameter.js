export function createLiveParameter({ context, send, onSent, onComplete, onError }) {
  let pending = null, inFlight = false, generation = 0;

  function cancel() {
    generation++;
    pending = null;
  }

  async function pump() {
    if (!pending || inFlight) return;
    const current = context();
    if (!current.enabled || current.id !== pending.id || current.address !== pending.address) { cancel(); return; }
    const data = pending, version = generation;
    pending = null;
    inFlight = true;
    try {
      const result = await send(data);
      if (!result.sent) throw new Error('参数未能发送');
      if (version === generation) {
        onSent?.(data, result);
        if (pending?.value === data.value) pending = null;
        if (!pending) onComplete?.(data);
      }
    } catch (error) {
      if (version === generation) { cancel(); onError(error); }
    } finally {
      inFlight = false;
      pump();
    }
  }

  function setValue(value) {
    const current = context();
    if (!current.enabled || !Number.isInteger(value) || value < current.min || value > current.max) return false;
    pending = { id: current.id, address: current.address, value };
    pump();
    return true;
  }

  return { setValue, cancel };
}
