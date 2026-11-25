// Layout navigation owns visibility; control logic continues to own robot inputs.
(() => {
  const body = document.body;
  const expanded = matchMedia('(min-width: 1100px) and (min-height: 740px)');
  const notify = () => window.dispatchEvent(new CustomEvent('console-view-change'));
  const colorPages = new Set(['target', 'pickup', 'line']);
  const isVisionPage = page => colorPages.has(page) || page === 'person';
  const visionActions = {
    target: ['开始追踪', '停止追踪'],
    pickup: ['开始搬运', '停止搬运'],
    line: ['开始巡线', '停止巡线'],
    person: ['开始跟随', '停止跟随'],
  };
  const trackingButtons = [document.querySelector('#tracking-start'), document.querySelector('#tracking-stop')];
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
      sticks.hidden = false;
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
    if (panelAttribute === 'data-console-panel') {
      body.toggleAttribute('data-vision-page', isVisionPage(value));
      body.toggleAttribute('data-color-vision', colorPages.has(value));
    }
    if (panelAttribute === 'data-console-panel' && isVisionPage(value)) {
      const button = document.querySelector(`button[data-page="${value}"]`);
      const title = button.querySelector('span').textContent;
      trackingButtons.forEach((action, index) => {
        const label = visionActions[value][index];
        if (window.WonderduckLanguage) window.WonderduckLanguage.setLocalizedText(action, label);
        else action.textContent = label;
      });
      document.querySelector('#vision-heading').textContent = title;
      document.querySelector('#console-page-vision').setAttribute('aria-label', `${title}参数`);
      document.querySelector('#console-page-vision .section-icon use')
        .setAttribute('href', button.querySelector('use').getAttribute('href'));
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
    const buttons = [...document.querySelectorAll(`button[${attribute}]`)]
      .filter(button => body.dataset.tofEnabled !== 'false' || !button.hasAttribute('data-requires-tof'));
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
    buttons.forEach(button => {
      button.addEventListener('click', () => select(button));
      button.addEventListener('keydown', event => {
        const forward = attribute === 'data-page' ? 'ArrowDown' : 'ArrowRight';
        const backward = attribute === 'data-page' ? 'ArrowUp' : 'ArrowLeft';
        if (![backward, forward, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const visibleButtons = buttons.filter(candidate => !candidate.hidden);
        const index = visibleButtons.indexOf(button);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleButtons.length - 1
          : (index + (event.key === forward ? 1 : -1) + visibleButtons.length) % visibleButtons.length;
        visibleButtons[next].focus();
        select(visibleButtons[next]);
      });
    });
    selectGroup(attribute, panelAttribute, body.dataset[property]);
  }
  placeSticks();
  let studioOrigin = null, activeStudioPage = null;
  const softwareUpdate = document.querySelector('#check-software-update');
  softwareUpdate.addEventListener('click', () => {
    if (!studioOrigin || body.dataset.consolePage !== 'system') return;
    softwareUpdate.disabled = true;
    window.parent.postMessage({ type: 'studio-software-update-request' }, studioOrigin);
  });
  const feedbackNodes = ['notice', 'settings-status', 'connection', 'coordinated-status', 'maze-status', 'camera-status']
    .map(id => document.getElementById(id));
  const routineNodes = new Set(['connection', 'coordinated-status', 'maze-status', 'camera-status']);
  const previousStates = new Map();
  const previousErrors = new Map();
  function sendFeedback(text, error, node = null, routine = false) {
    if (!activeStudioPage || activeStudioPage !== body.dataset.consolePage) return;
    window.parent.postMessage({ type: 'studio-feedback', page: activeStudioPage, text, error,
      routine, source: node?.id || null }, studioOrigin);
  }
  function pauseFeedback() {
    activeStudioPage = null;
    previousStates.clear();
    previousErrors.clear();
  }
  const networkAnnouncement = document.querySelector('#network-announcement-enabled');
  let announcementRequestId = 0, announcementConfirmed = null, announcementTimer = null;
  function requestNetworkAnnouncement(enabled) {
    if (!studioOrigin) return;
    const requestId = ++announcementRequestId;
    clearTimeout(announcementTimer);
    networkAnnouncement.disabled = true;
    window.parent.postMessage({ type: 'studio-network-announcement-request', requestId,
      ...(typeof enabled === 'boolean' ? { enabled } : {}) }, studioOrigin);
    announcementTimer = setTimeout(() => {
      if (requestId !== announcementRequestId) return;
      if (announcementConfirmed !== null) networkAnnouncement.checked = announcementConfirmed;
      networkAnnouncement.disabled = announcementConfirmed === null;
      sendFeedback('网络播报设置超时，请重试', true);
    }, 8000);
  }
  function cancelNetworkAnnouncement() {
    announcementRequestId++;
    clearTimeout(announcementTimer);
    networkAnnouncement.disabled = true;
  }
  networkAnnouncement.addEventListener('change', () => requestNetworkAnnouncement(networkAnnouncement.checked));
  window.addEventListener('studio-enter', () => {
    if (body.dataset.consolePage === 'system') requestNetworkAnnouncement();
  });
  window.addEventListener('studio-preview', cancelNetworkAnnouncement);
  window.addEventListener('studio-leave', cancelNetworkAnnouncement);
  window.addEventListener('studio-disconnect', cancelNetworkAnnouncement);
  function forwardFeedback(node) {
    if (!node || !activeStudioPage || activeStudioPage !== body.dataset.consolePage) return;
    if (node.id === 'camera-status' && activeStudioPage === 'system') return;
    if (node.id === 'maze-status' && activeStudioPage !== 'maze') return;
    if (node.id === 'coordinated-status' && !isVisionPage(activeStudioPage)) return;
    const visibleText = node.textContent.trim();
    const sourceText = (window.WonderduckLanguage?.sourceText(node) || visibleText).trim();
    const error = node.classList.contains('error')
      || (node.id !== 'notice' && /失败|无效|不可用|中断|未连接|已断开|超时|错误/.test(sourceText));
    if (!sourceText || (node.id === 'camera-status' && !error)) {
      previousStates.delete(node);
      if (!sourceText) previousErrors.delete(node);
      window.parent.postMessage({ type: 'studio-feedback-clear', page: activeStudioPage, source: node.id }, studioOrigin);
      return;
    }
    const routine = routineNodes.has(node.id) || (node.id === 'settings-status' && !error
      && ['参数已修改，等待保存…', '正在自动保存…', '参数已自动保存'].includes(sourceText));
    const state = `${error}:${sourceText}`;
    if (routine && previousStates.get(node) === state) return;
    if (routine) {
      previousStates.set(node, state);
      if (error && previousErrors.get(node) === sourceText) return;
      if (error) previousErrors.set(node, sourceText);
      else if (node.id !== 'camera-status' && (node.id !== 'connection' || sourceText.includes('已连接'))) previousErrors.delete(node);
    }
    sendFeedback(sourceText, error, node, routine);
  }
  if (document.documentElement.dataset.studioEmbedded === 'true' && window.parent !== window) {
    for (const node of feedbackNodes) {
      if (node) {
        new MutationObserver(() => forwardFeedback(node)).observe(node, {
          childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'],
        });
      }
    }
    window.addEventListener('console-feedback', event => {
      if (event.detail?.page === activeStudioPage && typeof event.detail.text === 'string'
          && event.detail.text && typeof event.detail.error === 'boolean') {
        sendFeedback(event.detail.text, event.detail.error);
      }
    });
    window.addEventListener('vision-recognition-failed', event => {
      if (activeStudioPage === 'person' && event.detail?.source === 'object'
          && typeof event.detail.message === 'string' && event.detail.message) {
        sendFeedback(event.detail.message, true);
      }
    });
  }
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent || !document.referrer) return;
    const parent = new URL(document.referrer);
    if (parent.protocol !== location.protocol || parent.hostname !== location.hostname || event.origin !== parent.origin) return;
    const page = event.data?.page;
    const button = typeof page === 'string' && document.querySelector(`button[data-page="${CSS.escape(page)}"]`);
    const pageAvailable = button && (body.dataset.tofEnabled !== 'false' || !button.hasAttribute('data-requires-tof'));
    if (event.data?.type === 'studio-workspace-preview') {
      if (!pageAvailable) return;
      pauseFeedback();
      button.click();
      window.dispatchEvent(new Event('studio-preview'));
    } else if (event.data?.type === 'studio-workspace') {
      if (!pageAvailable) return;
      button.click();
      if (document.documentElement.dataset.studioEmbedded === 'true') {
        studioOrigin = event.origin;
        activeStudioPage = page;
        forwardFeedback(document.querySelector('#camera-status'));
      }
      window.dispatchEvent(new Event('studio-enter'));
      if (button && Number.isSafeInteger(event.data.requestId)) {
        window.parent.postMessage({ type: 'studio-workspace-ready', page: event.data.page,
          requestId: event.data.requestId }, event.origin);
      }
    } else if (event.data?.type === 'studio-leave' && Number.isSafeInteger(event.data.requestId)) {
      pauseFeedback();
      window.dispatchEvent(new CustomEvent('studio-leave', { detail: event.data.requestId }));
    } else if (event.data?.type === 'studio-disconnect') {
      pauseFeedback();
      window.dispatchEvent(new Event('studio-disconnect'));
    } else if (event.data?.type === 'studio-debug-mode' && typeof event.data.enabled === 'boolean') {
      const debugMode = event.data.enabled ? 'on' : 'off';
      if (document.documentElement.dataset.debugMode !== debugMode) notify();
      document.documentElement.dataset.debugMode = debugMode;
    } else if (event.data?.type === 'studio-theme' && ['light', 'dark'].includes(event.data.theme)) {
      document.documentElement.dataset.theme = event.data.theme;
    } else if (event.data?.type === 'studio-device-versions') {
      const versions = event.data.versions;
      document.getElementById('device-hardware-version').textContent = versions?.hardware_version || '未配置';
      document.getElementById('device-image-version').textContent = versions?.image_version || '未配置';
      document.getElementById('device-software-version').textContent = versions?.software_version || '未读取';
      softwareUpdate.hidden = event.data.softwareUpdate !== true;
      softwareUpdate.disabled = event.data.busy === true;
      document.getElementById('device-imu-firmware-version').textContent = versions?.imu_firmware_version || '未读取';
    } else if (event.data?.type === 'studio-software-update-busy') {
      softwareUpdate.disabled = event.data.busy === true;
    } else if (event.data?.type === 'studio-network-announcement-result'
        && event.data.requestId === announcementRequestId) {
      clearTimeout(announcementTimer);
      if (typeof event.data.enabled === 'boolean') {
        announcementConfirmed = event.data.enabled;
        networkAnnouncement.checked = announcementConfirmed;
        networkAnnouncement.disabled = false;
      } else {
        if (announcementConfirmed !== null) networkAnnouncement.checked = announcementConfirmed;
        networkAnnouncement.disabled = announcementConfirmed === null;
        sendFeedback(`网络播报设置失败：${event.data.error || '请重试'}`, true);
      }
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
          const current = body.dataset.consolePage;
          value = source === 'object' ? 'person'
            : source === 'color' && !colorPages.has(current) ? 'target'
            : isVisionPage(current) ? current : 'target';
        }
        document.querySelector(`button[${attribute}="${value}"]`).click();
      }
    }
    const operator = field.closest('[data-operator-reveal]');
    if (operator) document.querySelector(`button[data-operator-tab="${operator.dataset.operatorReveal}"]`).click();
    if (body.dataset.compactView === 'camera') { notify(); resetCompactView(); }
  });
})();
