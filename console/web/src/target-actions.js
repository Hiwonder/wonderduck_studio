export function createTargetActions({ request, toast, readTargets, readEncoders, readImu, applyTargets, run, cancel }) {
  const get = id => document.getElementById(id);
  let pending = false;
  let controls = { available: false, busy: true, enabled: false };

  function update(value = controls) {
    controls = value;
    get('load-state').disabled = get('export-state').disabled = !controls.available || controls.busy || pending;
    get('run-targets').disabled = !controls.enabled || pending || !readTargets().some(row => row[1] !== null);
    get('load-confirm').disabled = pending || !get('load-filename').value;
    get('load-cancel').disabled = get('export-save').disabled = get('export-cancel').disabled = pending;
  }

  function showError(id, error) {
    get(id).textContent = error.message;
    get(id).hidden = false;
  }

  get('export-state').addEventListener('click', () => {
    const input = get('export-filename');
    input.value = `servo-targets-${Date.now()}.csv`;
    get('export-error').hidden = true;
    get('export-name').showModal();
    input.select();
  });
  get('export-form').addEventListener('submit', async event => {
    event.preventDefault();
    pending = true;
    update();
    get('export-error').hidden = true;
    try {
      const result = await request('export-targets', { name: get('export-filename').value.trim(),
        targets: readTargets(), encoders: readEncoders(), imu: readImu() });
      get('export-name').close('saved');
      toast(`已保存：${result.path}`);
    } catch (error) { showError('export-error', error); }
    finally { pending = false; update(); }
  });
  get('export-cancel').addEventListener('click', () => get('export-name').close('cancel'));

  get('load-state').addEventListener('click', async () => {
    cancel();
    pending = true;
    const select = get('load-filename');
    select.replaceChildren();
    get('load-error').hidden = true;
    get('load-name').showModal();
    update();
    try {
      const result = await request('list-targets', {});
      for (const name of result.files) {
        const option = document.createElement('option');
        option.value = option.textContent = name;
        select.append(option);
      }
      if (!result.files.length) throw new Error('actions 目录中没有 CSV 文件');
    } catch (error) { showError('load-error', error); }
    finally { pending = false; update(); }
  });
  get('load-filename').addEventListener('change', () => update());
  get('load-form').addEventListener('submit', async event => {
    event.preventDefault();
    pending = true;
    update();
    get('load-error').hidden = true;
    try {
      const result = await request('load-targets', { name: get('load-filename').value });
      cancel();
      applyTargets(result.targets);
      get('load-name').close('loaded');
      toast(`已加载：${result.name}；点击运行发送目标`);
    } catch (error) { showError('load-error', error); }
    finally { pending = false; update(); }
  });
  get('load-cancel').addEventListener('click', () => get('load-name').close('cancel'));
  for (const id of ['export-name', 'load-name']) {
    get(id).addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  }
  get('run-targets').addEventListener('click', async () => {
    pending = true;
    update();
    try { await run(readTargets()); }
    catch (error) { toast(error.message, true); }
    finally { pending = false; update(); }
  });

  return { update };
}
