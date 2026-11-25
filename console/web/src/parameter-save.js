const excludedAddresses = new Set([5, 6, 31, 33]);

export function batchWritable(register) {
  return !!register?.writable && register.region === 'NVS' && !excludedAddresses.has(register.address);
}

function validateValue(register, value) {
  if (!batchWritable(register)) throw new Error(`参数 ${register?.name || register?.address} 不支持批量保存`);
  if (!Number.isInteger(value) || value < register.minimum || value > register.maximum) {
    throw new Error(`${register.name} 必须为 ${register.minimum}～${register.maximum} 的整数`);
  }
}

export function parseParameterTemplate(data, registers) {
  if (!data || !Array.isArray(data.registers) || !data.registers.length) throw new Error('请选择导出的舵机参数 JSON 文件');
  const seen = new Set(), values = [];
  for (const entry of data.registers) {
    const register = registers.find(item => item.address === entry?.address);
    if (!register || !Number.isInteger(entry.address) || seen.has(entry.address)) throw new Error('参数地址无效或重复');
    seen.add(entry.address);
    if (!batchWritable(register)) continue;
    validateValue(register, entry.value);
    values.push({ address: register.address, value: entry.value });
  }
  if (!values.length) throw new Error('文件中没有可加载的配置参数');
  const value = address => values.find(item => item.address === address)?.value ?? registers.find(item => item.address === address)?.value;
  if (value(9) > value(11)) throw new Error('最小角度限制不能大于最大角度限制');
  return values;
}

export async function saveParameterBatch({ ids, parameters, send, active, onProgress,
  pause = () => new Promise(resolve => setTimeout(resolve, 200)) }) {
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !Number.isInteger(id))) throw new Error('请选择有效的目标舵机');
  if (!parameters.length || new Set(parameters.map(r => r.address)).size !== parameters.length) throw new Error('请选择有效且不重复的参数');
  for (const register of parameters) validateValue(register, register.value);
  if (!active()) throw new Error('操作已停止，尚未开始写入');
  const job = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
  let result, cancelSent = false, connectionLost = false;
  try {
    result = await send({ operation: 'start', job, ids,
      parameters: parameters.map(({ address, value }) => ({ address, value })) });
  } catch (error) {
    if (error.status && error.status < 500) throw error;
    connectionLost = true;
  }
  while (!result?.done) {
    onProgress?.(result || { phase: '连接中断，正在确认任务状态', confirmed: 0, total: ids.length * parameters.length });
    if ((!active() || connectionLost) && !cancelSent) {
      try { await send({ operation: 'cancel', job }); cancelSent = true; }
      catch (error) { if (error.status === 400 || error.status === 403) throw error; }
    }
    await pause();
    try { result = await send({ operation: 'status', job }); }
    catch (error) {
      if (error.status === 400 || error.status === 403) throw new Error(`任务状态无法确认：${error.message}`);
      connectionLost = true;
      onProgress?.({ phase: '连接中断，等待任务校验和锁恢复结束' });
    }
  }
  const total = ids.length * parameters.length;
  if (!result.verified || !result.locks_restored || result.confirmed !== total || result.total !== total) {
    const detail = result.written ? '部分参数可能已写入，请根据校验结果检查' : '尚未开始写入参数';
    throw new Error(`批量保存${result.cancelled ? '已取消' : '未全部完成'}：已确认 ${result.confirmed}/${total}；${(result.errors || []).join('；') || '结果不完整'}；${detail}${result.locks_restored ? '；锁状态已恢复' : '；写保护恢复失败，请检查'}`);
  }
  return result;
}

export function createParameterSave({ context, request, command, toast, setBusy, cancelMotion, onServoSelectionChange, loaded, refresh }) {
  const get = id => document.getElementById(id);
  const selectedIds = new Set(), selectedParameters = new Set(), drafts = new Map();
  let sourceId = null, running = false, loading = false, loadId = null, cancelReason = '';

  function source() {
    const current = context();
    if (sourceId !== current.id) {
      if (running) cancelReason = '已切换参数来源舵机';
      sourceId = current.id;
      selectedParameters.clear(); drafts.clear();
    }
    return current;
  }

  function value(register) { source(); return drafts.has(register.address) ? drafts.get(register.address) : register.value; }
  function draft(address) { source(); return drafts.get(address); }

  function edit(register, number) {
    source();
    if (!batchWritable(register)) return;
    drafts.set(register.address, number);
    const row = document.querySelector(`#parameter-rows tr[data-address="${register.address}"]`);
    if (row) { row.children[3].textContent = number; row.children[3].title = '尚未保存的编辑值'; row.classList.add('parameter-draft'); }
  }

  function checkbox(label, selected, key, className) {
    const input = document.createElement('input');
    input.type = 'checkbox'; input.className = className;
    input.setAttribute('aria-label', label); input.title = label;
    input.checked = selected.has(key);
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('keydown', event => event.stopPropagation());
    input.addEventListener('change', () => { input.checked ? selected.add(key) : selected.delete(key); update(); });
    return input;
  }

  function servoCheckbox(id) {
    const input = checkbox(`选择 ID ${id}`, selectedIds, id, 'servo-select-toggle');
    input.title = `批量保存到 ID ${id}；对应腿被勾选时，目标滑杆按 4096 − 当前值联动`;
    input.addEventListener('change', () => { cancelMotion(); onServoSelectionChange(); });
    return input;
  }
  function parameterCheckbox(register) {
    source();
    const input = checkbox(`批量保存参数 ${register.name}`, selectedParameters, register.address, 'batch-parameter-toggle');
    input.dataset.batchWritable = String(batchWritable(register));
    input.disabled = !batchWritable(register);
    if (input.disabled) input.title = `${register.name} 不支持批量保存`;
    return input;
  }

  function canContinue(current = context()) {
    return !cancelReason && current.id === sourceId && current.armed && current.online && !document.hidden;
  }

  function selectAll(selector, selected, key, checked) {
    for (const input of document.querySelectorAll(selector)) {
      if (input.disabled) continue;
      const value = Number(input.closest('tr').dataset[key]);
      checked ? selected.add(value) : selected.delete(value);
      input.checked = checked;
    }
    update();
  }

  function updateSelectAll(id, selector, blocked) {
    const input = get(id);
    const options = [...document.querySelectorAll(selector)].filter(option => option.dataset.batchWritable !== 'false' && option.dataset.unavailable !== 'true');
    const count = options.filter(option => option.checked).length;
    input.checked = options.length > 0 && count === options.length;
    input.indeterminate = count > 0 && count < options.length;
    input.disabled = blocked || options.length === 0;
  }

  get('select-all-servos').addEventListener('change', event => {
    if (event.target.disabled) return;
    cancelMotion();
    selectAll('.servo-select-toggle', selectedIds, 'id', event.target.checked);
    onServoSelectionChange();
  });
  get('select-all-parameters').addEventListener('change', event => {
    if (event.target.disabled) return;
    selectAll('.batch-parameter-toggle', selectedParameters, 'address', event.target.checked);
  });

  function update() {
    const current = source();
    const validIds = new Set(current.joints?.map(joint => joint.id));
    for (const id of selectedIds) if (!validIds.has(id)) selectedIds.delete(id);
    if (running && !canContinue(current)) cancelReason ||= '控制状态已变化';
    const blocked = current.readonly || running || loading || current.busy || current.parameterWriteBusy;
    get('load-params').disabled = blocked || current.parameterId !== current.id || !current.registers;
    for (const input of document.querySelectorAll('.servo-select-toggle, .batch-parameter-toggle')) {
      const id = input.classList.contains('servo-select-toggle') ? Number(input.closest('tr').dataset.id) : null;
      const unavailable = id !== null && !current.servos?.some(servo => servo.id === id && servo.online === true);
      if (id !== null) input.dataset.unavailable = String(unavailable);
      if (unavailable) { selectedIds.delete(id); input.checked = false; }
      input.disabled = blocked || unavailable || input.dataset.batchWritable === 'false';
    }
    updateSelectAll('select-all-servos', '.servo-select-toggle', blocked);
    updateSelectAll('select-all-parameters', '.batch-parameter-toggle', blocked);
    // Configuration reads and writes do not depend on a valid motion position.
    const offlineIds = [...selectedIds].filter(id => !current.servos?.some(servo => servo.id === id && servo.online === true));
    let reason = '';
    if (current.readonly) reason = 'robotd 只读模式不允许设置';
    else if (blocked) reason = '上一操作尚未完成，请等待';
    else if (document.hidden) reason = '请返回当前页面';
    else if (!current.online) reason = '设备数据已过期，请等待连接恢复';
    else if (!current.armed) reason = '尚未取得控制权，请关闭其他控制页面并等待重连';
    else if (!canContinue(current)) reason = cancelReason || '参数来源已变化，请重新读取';
    else if (current.parameterId !== current.id) reason = '请先读取当前舵机参数';
    else if (!selectedParameters.size) reason = '请勾选需要保存的参数';
    else if (!selectedIds.size) reason = '请在舵机总览勾选目标舵机';
    else if (offlineIds.length) reason = `目标舵机未在线：ID ${offlineIds.join('、')}`;
    get('batch-save').disabled = !!reason;
    get('batch-save').title = reason || '将勾选的参数值写入勾选舵机，并逐项读回校验';
  }

  get('load-params').addEventListener('click', () => {
    if (get('load-params').disabled) return;
    cancelMotion(); loadId = source().id;
    get('parameter-file').value = ''; get('parameter-file').click();
  });
  get('parameter-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    const current = source();
    if (get('load-params').disabled || current.id !== loadId) { toast('参数来源已变化，请重新选择文件', true); return; }
    loading = true; setBusy(true);
    try {
      const values = parseParameterTemplate(JSON.parse(await file.text()), current.registers);
      if (source().id !== loadId || context().parameterId !== loadId) throw new Error('已切换舵机，参数未加载');
      drafts.clear(); selectedParameters.clear();
      for (const { address, value } of values) { drafts.set(address, value); selectedParameters.add(address); }
      loaded(values[0].address);
      const message = `已加载 ${values.length} 项配置到 ID ${loadId}，并勾选参数；请选择目标舵机后批量保存`;
      toast(message);
    } catch (error) { toast(error instanceof SyntaxError ? '参数文件 JSON 格式无效' : error.message, true); }
    finally { loading = false; setBusy(false); update(); }
  });

  get('write-parameter').addEventListener('click', async () => {
    const current = source();
    if (get('write-parameter').disabled || current.address === 31) return;
    try {
      const result = await command('write_register', { id: current.id, address: current.address, value: current.value });
      drafts.delete(current.address);
      await refresh(result);
    } catch (error) { toast(error.message, true); }
  });

  get('batch-save').addEventListener('click', async () => {
    if (get('batch-save').disabled) return;
    const current = source();
    const ids = [...selectedIds].sort((a, b) => a - b);
    const parameters = [...selectedParameters].sort((a, b) => a - b).map(address => {
      const register = current.registers.find(r => r.address === address);
      return { ...register, value: value(register) };
    });
    cancelReason = ''; running = true;
    cancelMotion(); setBusy(true);
    try {
      const result = await saveParameterBatch({ ids, parameters,
        send: data => request('parameter-batch', data), active: () => canContinue(),
        onProgress: ({ phase }) => {
          get('batch-save').textContent = '保存中…';
          toast(`批量保存 · ${phase}，请等待全部完成`, false, { routine: true, source: 'parameter-batch' });
        },
      });
      if (ids.includes(sourceId)) for (const register of parameters) drafts.delete(register.address);
      const message = `批量保存完成：${ids.length} 个舵机 × ${parameters.length} 项参数，已确认 ${result.confirmed}/${result.total}`;
      toast(message, false, { source: 'parameter-batch' });
    } catch (error) {
      toast(error.message, true, { source: 'parameter-batch' });
    } finally {
      running = false; cancelReason = ''; get('batch-save').textContent = '批量保存';
      setBusy(false); await refresh(); update();
    }
  });
  get('release').addEventListener('click', () => { if (running) cancelReason = '已请求卸力'; }, { capture: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden && running) cancelReason = '页面已隐藏'; });
  window.addEventListener('pagehide', () => { if (running) cancelReason = '页面已离开'; });
  return { isRunning: () => running || loading, update, value, draft, edit, servoCheckbox, parameterCheckbox, isServoSelected: id => selectedIds.has(id) };
}
