// Layout navigation owns visibility; control logic continues to own robot inputs.
(() => {
  const body = document.body;
  const expanded = matchMedia('(min-width: 1100px) and (min-height: 740px)');
  const notify = () => window.dispatchEvent(new CustomEvent('console-view-change'));
  const isVisionPage = page => page === 'target' || page === 'person';
  fetch('/licenses/source-info').then(response => response.ok ? response.json() : null).then(data => {
    if (!/^[0-9a-f]{40}$/.test(data?.revision || '')) return;
    document.querySelectorAll('[data-studio-source]').forEach(link => {
      const base = link.dataset.studioSource === 'gitee'
        ? 'https://gitee.com/hiwonder_official/wonderduck_studio'
        : 'https://github.com/Hiwonder/wonderduck_studio';
      link.href = `${base}/tree/${data.revision}`;
    });
  }).catch(() => {});
  const licensesDialog = document.querySelector('#licenses-dialog');
  document.querySelector('#licenses-open').addEventListener('click', () => licensesDialog.showModal());
  const closeLicenses = () => { if (licensesDialog.open) licensesDialog.close(); };
  window.addEventListener('studio-leave', closeLicenses);
  window.addEventListener('console-page-changed', () => {
    if (body.dataset.consolePage !== 'system') closeLicenses();
  });
  const recordButton = document.querySelector('#audio-record');
  const recordStatus = document.querySelector('#audio-record-status');
  const recordPath = document.querySelector('#audio-record-path');
  const deleteRecording = document.querySelector('#audio-record-delete');
  let recordingState = 'unknown', recordPending = false, recordRevision = 0, recordError = '';
  let savedRecordingPath = null, recordingStartedAt = null;
  function renderRecordTimer() {
    if (recordingState !== 'recording' || recordingStartedAt === null) return;
    const seconds = Math.min(120, Math.floor((performance.now() - recordingStartedAt) / 1000));
    const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    recordStatus.textContent = `录音中 ${time}`;
  }
  function showRecording(result) {
    recordingState = result.state;
    savedRecordingPath = typeof result.path === 'string' ? result.path : null;
    if (recordingState === 'recording') recordingStartedAt = performance.now() - Math.max(0, Number(result.elapsed_ms) || 0);
    if (['recording', 'stopping', 'saving', 'playing'].includes(recordingState)) recordError = '';
    const labels = { idle: '开始录音', recording: '停止录音', stopping: '正在停止', saving: '正在保存', playing: '正在播放', error: '开始录音' };
    recordButton.textContent = labels[recordingState] || '开始录音';
    recordButton.disabled = recordPending || !['idle', 'recording', 'error'].includes(recordingState);
    recordButton.setAttribute('aria-pressed', String(recordingState === 'recording'));
    recordStatus.textContent = recordingState === 'recording' ? ''
      : recordingState === 'playing' ? '正在播放录音'
      : recordingState === 'error' ? (result.error || '录音失败，请重试') : recordError;
    renderRecordTimer();
    const showPath = !!savedRecordingPath && !['recording', 'stopping', 'saving'].includes(recordingState);
    recordPath.hidden = !showPath;
    recordPath.textContent = showPath ? `保存路径：${savedRecordingPath}` : '';
    deleteRecording.hidden = !showPath;
    deleteRecording.disabled = recordPending || !['idle', 'error'].includes(recordingState);
  }
  async function requestRecording(path, options) {
    const response = await fetch(path, options);
    if (!response.ok) throw new Error((await response.text()) || '服务不可用');
    return response.json();
  }
  async function refreshRecording() {
    if (recordPending) return;
    const revision = recordRevision;
    try {
      const result = await requestRecording('/audio-recording');
      if (revision === recordRevision && !recordPending) showRecording(result);
    } catch (error) {
      if (revision !== recordRevision || recordPending) return;
      recordingState = 'unknown';
      recordButton.disabled = true;
      deleteRecording.disabled = true;
      recordStatus.textContent = `录音不可用：${error.message}`;
    }
  }
  recordButton.addEventListener('click', async () => {
    if (recordPending || !['idle', 'recording', 'error'].includes(recordingState)) return;
    const action = recordingState === 'recording' ? 'stop' : 'start';
    recordPending = true;
    recordError = '';
    recordRevision++;
    recordButton.disabled = true;
    deleteRecording.disabled = true;
    try {
      const result = await requestRecording(`/audio-recording/${action}`, { method: 'POST' });
      recordPending = false;
      showRecording(result);
    } catch (error) {
      recordPending = false;
      recordError = `录音操作失败：${error.message}`;
      recordStatus.textContent = recordError;
      await refreshRecording();
    }
  });
  deleteRecording.addEventListener('click', async () => {
    if (recordPending || !savedRecordingPath || !['idle', 'error'].includes(recordingState)) return;
    recordPending = true;
    recordRevision++;
    recordButton.disabled = deleteRecording.disabled = true;
    try {
      const result = await requestRecording('/audio-recording', { method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: savedRecordingPath }) });
      recordPending = false;
      recordError = '录音已删除';
      showRecording(result);
    } catch (error) {
      recordPending = false;
      recordError = `删除录音失败：${error.message}`;
      await refreshRecording();
    }
  });
  refreshRecording();
  window.addEventListener('console-page-changed', () => {
    if (body.dataset.consolePage === 'system') refreshRecording();
  });
  setInterval(() => {
    renderRecordTimer();
    if (body.dataset.consolePage === 'system' || ['recording', 'stopping', 'saving', 'playing'].includes(recordingState)) refreshRecording();
  }, 1000);
  const sticks = document.querySelector('[data-operator-panel="sticks"]');
  const sticksHome = document.createComment('joystick home');
  sticks.after(sticksHome);
  function placeSticks() {
    if (isVisionPage(body.dataset.consolePage) || (expanded.matches && body.dataset.consolePage === 'control')) {
      document.querySelector('.camera-column').append(sticks);
      sticks.hidden = body.dataset.consolePage === 'person'
        || (body.dataset.consolePage === 'target' && document.documentElement.dataset.debugMode === 'off');
    } else {
      sticksHome.before(sticks);
      sticks.hidden = !expanded.matches && body.dataset.operatorTab !== 'sticks';
    }
  }

  function selectGroup(attribute, panelAttribute, value) {
    const panelValue = panelAttribute === 'data-console-panel' && isVisionPage(value) ? 'vision' : value;
    for (const button of document.querySelectorAll(`button[${attribute}]`)) {
      const selected = button.getAttribute(attribute) === value;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of document.querySelectorAll(`[${panelAttribute}]`)) {
      panel.hidden = !(panelAttribute === 'data-operator-panel' && expanded.matches)
        && panel.getAttribute(panelAttribute) !== panelValue;
    }
    if (panelAttribute === 'data-console-panel' && isVisionPage(value)) {
      const title = value === 'target' ? '目标追踪' : '行人跟随';
      document.querySelector('#vision-heading').textContent = title;
      document.querySelector('#console-page-vision').setAttribute('aria-label', `${title}参数`);
      document.querySelector('#console-page-vision .section-icon use')
        .setAttribute('href', value === 'target' ? '#icon-eye' : '#icon-user-round-search');
    }
  }
  function resetCompactView() {
    body.dataset.compactView = 'control';
    const button = document.querySelector('#compact-view-toggle');
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', '查看画面');
    button.title = '查看画面';
    button.querySelector('use').setAttribute('href', '#icon-camera');
    button.querySelector('span').textContent = '查看画面';
  }
  const groups = [
    ['data-page', 'data-console-panel', 'consolePage'],
    ['data-operator-tab', 'data-operator-panel', 'operatorTab'],
  ];
  for (const [attribute, panelAttribute, property] of groups) {
    const buttons = [...document.querySelectorAll(`button[${attribute}]`)];
    const select = button => {
      const value = button.getAttribute(attribute);
      if (body.dataset[property] === value) return;
      notify();
      body.dataset[property] = value;
      selectGroup(attribute, panelAttribute, value);
      if (property === 'consolePage') {
        resetCompactView();
        placeSticks();
        window.dispatchEvent(new CustomEvent('console-page-changed'));
      }
    };
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => select(button));
      button.addEventListener('keydown', event => {
        const forward = attribute === 'data-page' ? 'ArrowDown' : 'ArrowRight';
        const backward = attribute === 'data-page' ? 'ArrowUp' : 'ArrowLeft';
        if (![backward, forward, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === forward ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
        select(buttons[next]);
      });
    });
    selectGroup(attribute, panelAttribute, body.dataset[property]);
  }
  placeSticks();
  let studioOrigin = null, latestFeedback = null;
  const pendingErrors = [];
  const feedbackNodes = ['notice', 'settings-status', 'connection', 'coordinated-status', 'maze-status', 'camera-status']
    .map(id => document.getElementById(id));
  const routineNodes = new Set(['connection', 'coordinated-status', 'maze-status', 'camera-status']);
  const previousStates = new Map();
  const previousErrors = new Map();
  function sendFeedback(text, error, node = null, routine = false) {
    latestFeedback = { node, message: { type: 'studio-feedback', text, error, routine } };
    if (studioOrigin) window.parent.postMessage(latestFeedback.message, studioOrigin);
    else if (error) pendingErrors.push(latestFeedback.message);
  }
  function forwardFeedback(node) {
    if (!node) return;
    const text = node.textContent.trim();
    if (!text) {
      previousStates.delete(node);
      previousErrors.delete(node);
      if (latestFeedback?.node === node) latestFeedback = null;
      return;
    }
    const error = node.classList.contains('error')
      || (node.id !== 'notice' && /失败|无效|不可用|中断|未连接|已断开|超时|错误/.test(text));
    const routine = routineNodes.has(node.id) || (node.id === 'settings-status' && !error
      && ['参数已修改，等待保存…', '正在自动保存…', '参数已自动保存'].includes(text));
    const state = `${error}:${text}`;
    if (routine && previousStates.get(node) === state) return;
    if (routine) {
      previousStates.set(node, state);
      if (error && previousErrors.get(node) === text) return;
      if (error) previousErrors.set(node, text);
      else if (node.id !== 'camera-status' && (node.id !== 'connection' || text.includes('已连接'))) previousErrors.delete(node);
    }
    sendFeedback(text, error, node, routine);
  }
  if (document.documentElement.dataset.studioEmbedded === 'true' && window.parent !== window) {
    for (const node of feedbackNodes) {
      if (node) {
        forwardFeedback(node);
        new MutationObserver(() => forwardFeedback(node)).observe(node, {
          childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'],
        });
      }
    }
    window.addEventListener('console-feedback', event => {
      if (typeof event.detail?.text === 'string' && event.detail.text && typeof event.detail.error === 'boolean') {
        sendFeedback(event.detail.text, event.detail.error);
      }
    });
    window.addEventListener('vision-recognition-failed', event => {
      if (event.detail?.source === 'object' && typeof event.detail.message === 'string' && event.detail.message) {
        sendFeedback(event.detail.message, true);
      }
    });
  }
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent || !document.referrer) return;
    const parent = new URL(document.referrer);
    if (parent.protocol !== location.protocol || parent.hostname !== location.hostname || event.origin !== parent.origin) return;
    if (event.data?.type === 'studio-workspace') {
      if (document.documentElement.dataset.studioEmbedded === 'true') {
        const firstHandshake = studioOrigin === null;
        studioOrigin = event.origin;
        if (latestFeedback && firstHandshake) {
          window.parent.postMessage(latestFeedback.message, studioOrigin);
        }
        if (firstHandshake) {
          for (const message of pendingErrors) {
            if (message !== latestFeedback?.message) window.parent.postMessage(message, studioOrigin);
          }
          pendingErrors.length = 0;
        }
      }
      const button = document.querySelector(`button[data-page="${event.data.page}"]`);
      button?.click();
      window.dispatchEvent(new Event('studio-enter'));
    } else if (event.data?.type === 'studio-leave' && Number.isSafeInteger(event.data.requestId)) {
      window.dispatchEvent(new CustomEvent('studio-leave', { detail: event.data.requestId }));
    } else if (event.data?.type === 'studio-debug-mode' && typeof event.data.enabled === 'boolean') {
      if (!event.data.enabled && document.documentElement.dataset.debugMode !== 'off'
          && body.dataset.consolePage === 'target') notify();
      document.documentElement.dataset.debugMode = event.data.enabled ? 'on' : 'off';
      placeSticks();
    } else if (event.data?.type === 'studio-theme' && ['light', 'dark'].includes(event.data.theme)) {
      document.documentElement.dataset.theme = event.data.theme;
    } else if (event.data?.type === 'studio-device-versions') {
      const versions = event.data.versions;
      document.getElementById('device-hardware-version').textContent = versions?.hardware_version || '未配置';
      document.getElementById('device-image-version').textContent = versions?.image_version || '未配置';
      document.getElementById('device-imu-firmware-version').textContent = versions?.imu_firmware_version || '未读取';
    }
  });
  expanded.addEventListener('change', () => {
    notify();
    selectGroup('data-operator-tab', 'data-operator-panel', body.dataset.operatorTab);
    placeSticks();
  });
  document.querySelector('#compact-view-toggle').addEventListener('click', event => {
    notify();
    const camera = body.dataset.compactView !== 'camera';
    body.dataset.compactView = camera ? 'camera' : 'control';
    const button = event.currentTarget;
    button.setAttribute('aria-pressed', String(camera));
    button.querySelector('span').textContent = camera
      ? (body.dataset.consolePage === 'control' ? '返回操控' : '返回参数') : '查看画面';
    button.setAttribute('aria-label', button.querySelector('span').textContent);
    button.title = button.querySelector('span').textContent;
    button.querySelector('use').setAttribute('href', camera ? '#icon-control' : '#icon-camera');
  });
  window.addEventListener('console-reveal-field', event => {
    const field = event.detail;
    for (const [attribute, panelAttribute] of groups) {
      const panel = field.closest(`[${panelAttribute}]`);
      if (panel) {
        let value = panel.getAttribute(panelAttribute);
        if (panelAttribute === 'data-console-panel' && value === 'vision') {
          const source = field.closest('[data-vision-fields]')?.dataset.visionFields;
          value = source ? (source === 'object' ? 'person' : 'target')
            : isVisionPage(body.dataset.consolePage) ? body.dataset.consolePage : 'target';
        }
        document.querySelector(`button[${attribute}="${value}"]`).click();
      }
    }
    const operator = field.closest('[data-operator-reveal]');
    if (operator) document.querySelector(`button[data-operator-tab="${operator.dataset.operatorReveal}"]`).click();
    if (body.dataset.compactView === 'camera') { notify(); resetCompactView(); }
  });
})();
