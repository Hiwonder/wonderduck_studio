export function createLiveTarget({ context, send, onError, onComplete }) {
  let goal = null, timer = null, inFlight = false, generation = 0, lastSent = -Infinity;

  function cancel() {
    generation++;
    goal = null;
    clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    if (!goal || timer !== null || inFlight) return;
    timer = setTimeout(pump, Math.max(0, 20 - (performance.now() - lastSent)));
  }

  async function pump() {
    timer = null;
    if (!goal || inFlight) return;
    const current = context();
    if (!current.enabled || current.id !== goal.id || !Number.isFinite(current.actual)) { cancel(); return; }
    if (current.actual === goal.raw || (goal.sentRaw === goal.raw &&
        (Math.abs(current.actual - goal.raw) <= 1 || (goal.raw === 4096 && current.actual === 0)))) {
      const id = goal.id;
      cancel();
      onComplete?.(id);
      return;
    }
    if (Math.abs(current.actual - goal.progressPosition) > 1) {
      goal.progressPosition = current.actual;
      goal.progressTime = performance.now();
    }
    if (performance.now() - goal.progressTime > 4000 || performance.now() - goal.started > 30000) {
      cancel();
      onError(new Error('舵机未到达目标，已停止发送'));
      return;
    }
    // 56 encoder counts are less than 5 degrees, within the backend's 10-degree guard.
    const step = Math.max(current.actual - 56, Math.min(current.actual + 56, goal.raw));
    const raw = Math.max(current.min, Math.min(current.max, step));
    if (goal.sentRaw === raw) {
      timer = setTimeout(pump, 20);
      return;
    }
    const version = generation;
    inFlight = true;
    lastSent = performance.now();
    try {
      const result = await send({ id: goal.id, raw, speed: 0 });
      if (!result.verified) throw new Error('目标写入未确认，已停止发送');
      if (version === generation) goal.sentRaw = raw;
    } catch (error) {
      if (version === generation) { cancel(); onError(error); }
    } finally {
      inFlight = false;
      schedule();
    }
  }

  function setTarget(raw) {
    const current = context();
    if (!current.enabled || !Number.isInteger(raw) || !Number.isInteger(current.actual)) return false;
    if (goal?.id !== current.id) {
      cancel();
      goal = { id: current.id, started: performance.now(), progressTime: performance.now(), progressPosition: current.actual };
    }
    goal.raw = Math.max(current.min, Math.min(current.max, raw));
    schedule();
    return true;
  }

  return { setTarget, cancel };
}
