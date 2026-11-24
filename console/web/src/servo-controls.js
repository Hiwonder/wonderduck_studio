export function createServoControls({ request, command, toast, cancel, setBusy, active, onDiscovery, onPose }) {
  const get = id => document.getElementById(id);
  let scanning = false;
  let stopRequested = false;

  function update({ center, home, scan }) {
    get('center-all').disabled = scanning || !center;
    get('home-all').disabled = scanning || !home;
    get('scan-servos').disabled = scanning ? stopRequested : !scan;
  }

  for (const [id, action] of [['center-all', 'center_all'], ['home-all', 'home_all']]) {
    get(id).addEventListener('click', async () => {
      if (get(id).disabled) return;
      try { onPose(await command(action)); }
      catch (error) { toast(error.message, true); }
    });
  }

  get('scan-servos').addEventListener('click', async () => {
    if (get('scan-servos').disabled) return;
    if (scanning) {
      stopRequested = true;
      get('scan-servos').textContent = '停止中…';
      get('scan-servos').disabled = true;
      get('last-command').textContent = '正在停止扫描，等待当前探测结束…';
      return;
    }
    cancel(); scanning = true; stopRequested = false; setBusy(true);
    const found = [];
    const total = 252;
    let completed = 0;
    const progress = get('scan-progress');
    progress.hidden = false;
    progress.textContent = `0/${total} · 发现 0`;
    get('scan-servos').textContent = '停止';
    try {
      for (let id = 1; id <= 253; id++) {
        if (stopRequested) break;
        if (id === 200) continue;
        if (!active()) throw new Error('扫描已停止：控制状态已变化');
        progress.title = `正在扫描 ID ${id}`;
        get('last-command').textContent = `正在扫描 ID ${id} · 已完成 ${completed}/${total}`;
        const result = await request('command', { action: 'scan_servo', id });
        if (result.found) { found.push(id); onDiscovery(result.joint); }
        completed++;
        progress.textContent = `${completed}/${total} · 发现 ${found.length}`;
      }
      const message = `${stopRequested ? '扫描已停止' : '扫描完成'}：发现 ${found.length} 个舵机，ID ${found.join('、') || '无'}`;
      get('last-command').textContent = message; toast(message);
    } catch (error) {
      const message = `${error.message}；已发现 ${found.length} 个舵机，扫描未完成`;
      get('last-command').textContent = message; toast(message, true);
    } finally {
      scanning = false; stopRequested = false; progress.hidden = true;
      get('scan-servos').textContent = '扫描'; setBusy(false);
    }
  });

  return { update };
}
