import { getLanguage, onLanguageChange } from '../../../webpadd/web/language.js';

const modelLabels = {
  walk: '行走（velocity）', stand: '站立（stand）', sitstand: '坐立（sitstand）',
  ground_pick: '地面拾取（ground_pick）', kick_left: '左踢（ball_kick_left）',
  kick_right: '右踢（ball_kick_right）', roulade: '翻滚', headstand: '倒立',
};
// Also send the fixed address for compatibility with an already running console.
const ONLINE_MODEL_DIRECTORY = 'https://wonderrl.hiwonder.com.cn/download/WonderDuck/';

function modelName(model) {
  return model ? (modelLabels[model.id] || model.name || model.id) : '--';
}

function sizeText(size) {
  if (!Number.isFinite(size) || size < 0) return '--';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

export function createModelControls({ request, requestHeaders, refreshSession, confirmAction, toast, supportsUpdates, supportsOnline }) {
  const element = id => document.getElementById(`models-${id}`);
  let active = false, generation = 0, readSequence = 0;
  let models = [], selectedId = '', loading = false, operation = '';
  let onlineJob = null, onlineReady = false, onlineStarting = false, onlinePolling = false;
  let onlineTimer = null, onlineSequence = 0, onlineError = '';
  const current = value => active && generation === value;
  const selected = () => models.find(model => model.id === selectedId);

  function optionText(model) {
    const name = modelName(model);
    const customEnglish = !Object.hasOwn(modelLabels, model.id) && getLanguage() === 'en';
    const status = model.active ? (customEnglish ? ' (Running)' : '（运行中）')
      : model.loaded === false ? (customEnglish ? ' (Not loaded)' : '（未加载）') : '';
    return `${name}${status}`;
  }

  onLanguageChange(() => {
    for (const option of element('select').options) {
      const model = models.find(item => item.id === option.value);
      if (model && !Object.hasOwn(modelLabels, model.id)) option.textContent = optionText(model);
    }
  });

  function clearFile() {
    element('file').value = '';
    element('filename').textContent = '尚未选择文件';
    element('filename').title = '';
  }

  function updateControls() {
    const model = selected(), busy = loading || !!operation || onlineStarting || onlineJob?.state === 'running';
    element('refresh').disabled = busy;
    element('refresh').querySelector('span').textContent = loading ? '刷新中' : '刷新';
    element('select').disabled = busy || !models.length;
    element('choose').disabled = busy || !model || !supportsUpdates();
    element('file').disabled = busy || !model || !supportsUpdates();
    element('apply').disabled = busy || !model || !supportsUpdates() || !element('file').files.length;
    element('apply').textContent = operation === 'apply' ? '更新中' : '应用更新';
    element('restore').disabled = busy || !supportsUpdates() || !model?.default_path || !!model?.default_error;
    element('restore').querySelector('span').textContent = operation === 'restore' ? '恢复中' : '恢复默认';
    element('online-update').disabled = busy || !supportsOnline() || !onlineReady;
    element('online-update').textContent = onlineJob?.state === 'running' ? '更新中' : onlineStarting ? '检查中' : '同步更新';
    element('online-hint').textContent = !supportsUpdates() ? '模型更新需要重启控制台服务后启用'
      : !supportsOnline() ? '在线更新需要重启控制台服务后启用'
      : onlineError ? `更新状态读取失败，正在重试：${onlineError}` : '';
  }

  function onlineItemText(item) {
    const labels = { waiting: '等待中', downloading: '下载中', downloaded: '已下载，等待更新', applying: '校验并更新中',
      applied: '已更新', unchanged: '内容相同，无需更新', failed: '失败',
      uncertain: '结果未知，请刷新模型列表确认', not_started: '未执行' };
    let detail = labels[item.state] || item.state;
    if (item.state === 'downloading') {
      detail += `（${sizeText(item.downloaded)}${Number.isFinite(item.total) ? ` / ${sizeText(item.total)}` : ''}）`;
    }
    return `${item.filename}：${detail}${item.error ? `：${item.error}` : ''}`;
  }

  function showVersionNotice(compatibility) {
    if (compatibility.status === 'compatible') return false;
    let title, message;
    if (compatibility.status === 'hardware_incompatible') {
      title = '无可用更新';
      message = '当前没有适用于本机硬件的模型更新。';
    } else if (compatibility.status === 'image_too_old') {
      title = '需要先更新镜像';
      message = `有最新模型可更新，但当前镜像版本 ${compatibility.current.image_version} 低于要求的 ${compatibility.required.image_version}，请先更新镜像。`;
    } else throw new Error('服务器返回的版本检查结果无效');
    element('result-title').textContent = title;
    const row = document.createElement('li');
    row.textContent = message;
    element('result-items').replaceChildren(row);
    const dialog = element('online-result');
    if (!dialog.open) dialog.showModal();
    return true;
  }

  function renderOnline(job) {
    onlineJob = job;
    const section = element('online-progress');
    section.hidden = !job || job.state === 'finished';
    if (job) {
      const finished = new Set(['applied', 'unchanged', 'failed', 'uncertain']);
      const done = job.items.filter(item => finished.has(item.state)).length;
      const currentItem = job.items.find(item => ['downloading', 'applying'].includes(item.state));
      const progress = job.items.reduce((sum, item) => sum + (finished.has(item.state) ? 1
        : item.state === 'applying' ? .95 : item.state === 'downloaded' ? .5
          : item.state === 'downloading' && item.total > 0 ? .5 * Math.min(1, item.downloaded / item.total) : 0), 0);
      const rest = { requesting: '准备休息', resting: '机器人休息中', rested: '休息已完成',
        policy_disabled: '休息未完成，策略已停用', failed: '休息未完成' }[job.rest?.state] || '休息状态未知';
      const pending = job.items.some(item => item.state === 'downloaded');
      const current = job.resume?.state === 'starting' ? '初始化并开启策略'
        : currentItem ? onlineItemText(currentItem)
        : pending ? (['rested', 'policy_disabled'].includes(job.rest?.state) ? '准备更新已下载模型' : '等待机器人就绪')
          : '准备中';
      element('online-summary').textContent = `${rest}；当前：${current}；已处理 ${done} / ${job.items.length} 项`;
      element('online-bar').max = job.items.length;
      element('online-bar').value = progress;
      if (job.state === 'finished' && active && sessionStorage.getItem('models-online-result') !== job.id) {
        element('result-title').textContent = '模型更新结果';
        const result = element('result-items');
        const rows = job.items.map(item => {
          const row = document.createElement('li');
          row.textContent = onlineItemText(item);
          return row;
        });
        if (job.resume) {
          const row = document.createElement('li');
          row.textContent = job.resume.state === 'started' ? '机器人已初始化并开启策略'
            : `机器人未自动启动：${job.resume.error || '启动状态未确认'}`;
          rows.push(row);
        }
        result.replaceChildren(...rows);
        sessionStorage.setItem('models-online-result', job.id);
        const dialog = element('online-result');
        if (!dialog.open) dialog.showModal();
      }
    }
    updateControls();
  }

  function scheduleOnlinePoll(delay = 1000) {
    clearTimeout(onlineTimer);
    if (active && supportsOnline()) onlineTimer = setTimeout(pollOnline, delay);
  }

  async function pollOnline() {
    if (!active || !supportsOnline()) return;
    if (onlinePolling || onlineStarting) { scheduleOnlinePoll(); return; }
    const sequence = onlineSequence, previous = onlineJob;
    onlinePolling = true;
    try {
      const data = await request('models/online');
      if (!active || sequence !== onlineSequence) return;
      if (data.job !== null && (!data.job || !Array.isArray(data.job.items)
          || !['running', 'finished'].includes(data.job.state))) throw new Error('更新状态格式不正确');
      onlineReady = true;
      onlineError = '';
      renderOnline(data.job);
      if (data.job?.state === 'finished' && previous?.state === 'running') refresh();
    } catch (error) {
      if (active && sequence === onlineSequence) {
        onlineReady = false;
        onlineError = error.message;
        updateControls();
      }
    } finally {
      onlinePolling = false;
      if (active) scheduleOnlinePoll(onlineJob?.state === 'running' ? 700 : 3000);
    }
  }

  function renderDetails() {
    const model = selected();
    element('loaded').textContent = typeof model?.loaded === 'boolean' ? (model.loaded ? '已加载' : '未加载') : '--';
    element('default').textContent = typeof model?.is_default === 'boolean' ? (model.is_default ? '相同' : '不同') : '--';
    element('size').textContent = sizeText(model?.size);
    element('name').toggleAttribute('data-i18n-skip', !!model?.original_name);
    element('name').textContent = model ? model.original_name || '原文件名未保留' : '--';
    element('path').textContent = model?.path || '--';
    element('default-name').textContent = model ? (model.default_path ? '原文件名未保留' : '未配置') : '--';
    element('default-path').toggleAttribute('data-i18n-skip', !!model?.default_path);
    element('default-path').textContent = model ? model.default_path || '未配置' : '--';
    element('default-size').textContent = sizeText(model?.default_size);
    element('default-sha256').textContent = model?.default_sha256 || '--';
    element('default-error-row').hidden = !model?.default_error;
    element('default-error').textContent = model?.default_error || '';
    element('sha256').textContent = model?.sha256 || '--';
    element('error-row').hidden = !model?.error;
    element('error').textContent = model?.error || '';
    updateControls();
  }

  function renderList(emptyLabel = '没有已加载的模型') {
    const select = element('select');
    select.replaceChildren();
    if (!models.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = emptyLabel;
      select.append(option);
    }
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id;
      // Model names supplied by the device are user content, even if they
      // happen to match a translated application label.
      option.toggleAttribute('data-i18n-skip', !Object.hasOwn(modelLabels, model.id));
      option.textContent = optionText(model);
      select.append(option);
    }
    select.value = selectedId;
    renderDetails();
  }

  async function refresh() {
    if (!active || operation) return;
    const requestGeneration = generation, sequence = ++readSequence;
    loading = true;
    updateControls();
    try {
      const data = await request('models');
      if (!current(requestGeneration) || sequence !== readSequence) return;
      if (!Array.isArray(data.models) || data.models.some(model => !model || typeof model.id !== 'string' || !model.id)) {
        throw new Error('模型列表格式不正确');
      }
      models = data.models;
      const nextId = models.some(model => model.id === selectedId) ? selectedId : models[0]?.id || '';
      if (selectedId !== nextId) clearFile();
      selectedId = nextId;
      renderList();
    } catch (error) {
      if (!current(requestGeneration) || sequence !== readSequence) return;
      models = [];
      selectedId = '';
      clearFile();
      renderList('模型列表不可用');
      toast(`模型列表读取失败：${error.message}`, true);
    } finally {
      if (current(requestGeneration) && sequence === readSequence) {
        loading = false;
        updateControls();
      }
    }
  }

  async function writeModel(kind, slot, file) {
    const headers = requestHeaders();
    let path, body;
    if (kind === 'apply') {
      path = `/api/models/apply?${new URLSearchParams({ slot, name: file.name })}`;
      headers['Content-Type'] = 'application/octet-stream';
      body = file;
    } else {
      path = '/api/models/restore';
      body = JSON.stringify({ slot });
    }
    let response, data;
    try {
      response = await fetch(path, { method: 'POST', headers, body, cache: 'no-store' });
      data = await response.json();
    } catch {
      throw Object.assign(new Error('连接中断，请刷新模型列表确认'), { uncertain: true });
    }
    if (!response.ok) {
      if (response.status === 403 && data?.error === '会话无效，请刷新页面') {
        await refreshSession();
        throw new Error('服务已重启，控制会话正在恢复');
      }
      const message = typeof data?.error === 'string' && data.error ? data.error : `HTTP ${response.status}`;
      throw Object.assign(new Error(message), { uncertain: data?.uncertain === true || message.includes('结果未知') });
    }
    if (!['applied', 'unchanged'].includes(data?.status) || data?.model?.id !== slot) {
      throw Object.assign(new Error('服务返回的结果不完整，请刷新模型列表确认'), { uncertain: true });
    }
    return data;
  }

  async function update(kind) {
    const model = selected(), file = element('file').files[0];
    if (!active || !supportsUpdates() || loading || operation || onlineStarting || onlineJob?.state === 'running'
        || !model || (kind === 'apply' && !file)
        || (kind === 'restore' && (!model.default_path || model.default_error))) return;
    operation = kind;
    ++readSequence;
    updateControls();
    try {
      const result = await writeModel(kind, model.id, file);
      clearFile();
      const outcome = result.status === 'unchanged'
        ? (kind === 'apply' ? '模型内容相同，已跳过更新' : '当前已是默认模型，已跳过恢复')
        : (kind === 'apply' ? '模型已更新' : '已恢复默认模型');
      if (active) toast(result.policy_restarted === false
        ? `${outcome}，休息未完成，策略保持停用`
        : result.status === 'unchanged' ? outcome : `${outcome}，机器人已初始化并开启策略`);
    } catch (error) {
      if (active) toast(error.uncertain ? (error.message.includes('结果未知') ? error.message : `模型操作结果未知：${error.message}`)
        : `${kind === 'apply' ? '模型更新失败' : '恢复默认失败'}：${error.message}`, true);
    } finally {
      operation = '';
      updateControls();
      if (active) refresh();
    }
  }

  element('select').addEventListener('change', event => {
    if (selectedId !== event.target.value) clearFile();
    selectedId = event.target.value;
    renderDetails();
  });
  element('choose').addEventListener('click', () => element('file').click());
  element('file').addEventListener('change', () => {
    const filename = element('file').files[0]?.name || '';
    element('filename').textContent = filename || '尚未选择文件';
    element('filename').title = filename;
    updateControls();
  });
  element('refresh').addEventListener('click', refresh);
  element('apply').addEventListener('click', () => update('apply'));
  element('restore').addEventListener('click', () => update('restore'));
  element('online-update').addEventListener('click', async () => {
    if (!active || !supportsOnline() || !onlineReady || loading || operation || onlineStarting
        || onlineJob?.state === 'running') return;
    const requestGeneration = generation;
    onlineStarting = true;
    onlineSequence++;
    clearTimeout(onlineTimer);
    updateControls();
    let starting = false;
    try {
      const compatibility = await request('models/online/check', { url: ONLINE_MODEL_DIRECTORY });
      if (!current(requestGeneration) || showVersionNotice(compatibility)) return;
      const confirmed = await confirmAction('同步更新', '机器人将先休息，同时下载六个模型；休息完成后更新，随后自动初始化并开启策略。是否继续？');
      if (!confirmed || !current(requestGeneration) || onlineJob?.state === 'running') return;
      starting = true;
      const data = await request('models/online', { url: ONLINE_MODEL_DIRECTORY });
      if (!current(requestGeneration)) return;
      if (data.compatibility && showVersionNotice(data.compatibility)) return;
      if (!data.job || data.job.state !== 'running' || !Array.isArray(data.job.items)) {
        throw new Error('服务返回的更新状态不完整');
      }
      renderOnline(data.job);
    } catch (error) {
      if (current(requestGeneration)) toast(!starting ? `模型版本检查失败：${error.message}` : error.status
        ? `无法启动在线更新：${error.message}` : `更新请求的结果未知，正在检查状态：${error.message}`, true);
    } finally {
      onlineStarting = false;
      if (active) { updateControls(); scheduleOnlinePoll(0); }
    }
  });
  return {
    setActive(value) {
      if (active === value) return;
      active = value;
      generation++;
      if (active) {
        if (!operation) refresh(); else updateControls();
        scheduleOnlinePoll(0);
      } else {
        readSequence++;
        onlineSequence++;
        clearTimeout(onlineTimer);
        loading = false;
      }
    },
  };
}
