(() => {
  if (document.documentElement.dataset.studioEmbedded !== 'true' || window.parent === window || !document.referrer) return;
  const parentOrigin = new URL(document.referrer).origin;
  const panel = document.querySelector('.control-action-library');
  const select = document.querySelector('#control-action-select');
  const selectedName = document.querySelector('#control-action-name');
  const options = document.querySelector('#control-action-options');
  const run = document.querySelector('#control-action-run');
  const pending = new Map();
  let nextRequest = 0, listGeneration = 0, selected = '', active = false, busy = false;
  panel.hidden = false;

  function feedback(text, error = false) {
    window.dispatchEvent(new CustomEvent('console-feedback', { detail: { text, error } }));
  }

  function request(operation, name) {
    const requestId = ++nextRequest;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      window.parent.postMessage({ type: 'studio-action-request', requestId, operation, name }, parentOrigin);
    });
  }

  function render() {
    const name = selected ? selected.replace(/\.csv$/i, '') : '选择动作';
    selectedName.toggleAttribute('data-i18n-skip', !!selected);
    if (selectedName.textContent !== name) selectedName.textContent = name;
    select.disabled = active || busy;
    run.disabled = busy || (!active && !selected);
    const label = active ? '停止' : '运行';
    if (run.textContent !== label) run.textContent = label;
    run.setAttribute('aria-label', active ? '停止动作' : '运行动作');
    run.title = active ? '停止动作并归还控制' : '播放动作时停止当前策略，结束后不会自动恢复';
  }

  function closeOptions() {
    listGeneration++;
    options.hidden = true;
    select.setAttribute('aria-expanded', 'false');
  }

  function message(text) {
    const item = document.createElement('p');
    item.textContent = text;
    options.replaceChildren(item);
  }

  async function openOptions() {
    const generation = ++listGeneration;
    options.hidden = false;
    select.setAttribute('aria-expanded', 'true');
    message('正在刷新…');
    try {
      const { names } = await request('list');
      if (generation !== listGeneration) return;
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('动作列表无效');
      if (!names.includes(selected)) selected = '';
      render();
      if (!names.length) { message('暂无保存的动作'); return; }
      options.replaceChildren(...names.map(name => {
        const option = document.createElement('button');
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(name === selected));
        option.textContent = name.replace(/\.csv$/i, '');
        option.title = name;
        option.addEventListener('click', () => { selected = name; closeOptions(); render(); select.focus(); });
        return option;
      }));
    } catch (error) {
      if (generation !== listGeneration) return;
      message('动作列表读取失败');
      feedback(error.message, true);
    }
  }

  function setPlayback(result) {
    const wasActive = active;
    active = result.active === true;
    render();
    if (wasActive && !active) {
      if (result.state === 'error') feedback(`动作播放失败：${result.error || '未知错误'}`, true);
      else if (result.state === 'completed') feedback('动作播放完成');
      else if (result.state === 'stopped') feedback('动作已停止');
    }
  }

  select.addEventListener('click', () => options.hidden ? openOptions() : closeOptions());
  select.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && !options.hidden) {
      event.preventDefault();
      options.querySelector('[role="option"]')?.focus();
    }
  });
  options.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeOptions(); select.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const choices = [...options.querySelectorAll('[role="option"]')];
    if (!choices.length) return;
    const current = choices.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    choices[index].focus();
  });
  document.addEventListener('pointerdown', event => {
    if (!panel.contains(event.target) && !options.hidden) closeOptions();
  });
  run.addEventListener('click', async () => {
    if (busy || (!active && !selected)) return;
    closeOptions();
    busy = true;
    render();
    try {
      const result = await request(active ? 'stop' : 'start', selected);
      setPlayback(result);
    } catch (error) {
      if (error.active) active = true;
      feedback(error.message, true);
    } finally {
      busy = false;
      render();
    }
  });
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    if (event.data?.type === 'studio-action-state' && event.data.result) {
      setPlayback(event.data.result);
    } else if (event.data?.type === 'studio-action-result') {
      const waiting = pending.get(event.data.requestId);
      if (!waiting) return;
      pending.delete(event.data.requestId);
      if (event.data.error) waiting.reject(Object.assign(new Error(event.data.error), { active: event.data.active === true }));
      else waiting.resolve(event.data.result);
    }
  });
  render();
})();
