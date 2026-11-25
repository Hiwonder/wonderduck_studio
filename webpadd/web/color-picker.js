(() => {
  const video = document.querySelector('#camera-video');
  const frame = document.querySelector('.camera-frame');
  const overlay = document.querySelector('#color-overlay');
  const output = overlay.getContext('2d');
  const recognitionColor = getComputedStyle(overlay).getPropertyValue('--recognition-color').trim();
  const button = document.querySelector('#color-pick');
  const result = document.querySelector('#color-result');
  const lineResult = document.querySelector('#line-result');
  const swatch = document.querySelector('#color-swatch');
  const threshold = document.querySelector('#color-threshold');
  const thresholdValue = document.querySelector('#color-threshold-value');
  const fpsOutput = document.querySelector('#detection-fps');
  let phase = 'idle';
  let activeSource = 'color';
  let generation = 0;
  let reference = null;
  let explicitlySelected = false;
  let sample = null;
  let socket = null;
  function bindTracking() {
    if (socket?.readyState === WebSocket.OPEN && window.__visionControlToken) {
      socket.send(JSON.stringify({type: 'bind_tracking', token: window.__visionControlToken}));
    } else window.dispatchEvent(new CustomEvent('vision-direct-binding', {detail: {source: 'color', bound: false}}));
  }
  window.addEventListener('vision-control-token', bindTracking);
  let reconnect = null;
  let expiry = null;
  let lastCaptured = -1;
  let detectionFrames = 0;
  let fpsTime = performance.now();
  let disposed = false;
  let fpsTimer = null;
  const visionPageActive = () => document.body.hasAttribute('data-color-vision');
  const lineFollowing = () => document.body.dataset.consolePage === 'line';
  let lineMode = lineFollowing();
  let suspendedByPage = false;

  function setRecognitionActive(active) {
    if (active) document.body.dataset.recognitionSource = 'color';
    else if (document.body.dataset.recognitionSource === 'color') delete document.body.dataset.recognitionSource;
  }

  function startFps() {
    if (disposed || document.hidden || fpsTimer !== null) return;
    resetFps(activeSource);
    const timer = setInterval(() => {
      if (fpsTimer !== timer) return;
      const now = performance.now();
      if (now <= fpsTime) return;
      fpsOutput.textContent = (detectionFrames * 1000 / (now - fpsTime)).toFixed(0);
      detectionFrames = 0;
      fpsTime = now;
    }, 1000);
    fpsTimer = timer;
  }

  function stopFps() {
    if (fpsTimer !== null) clearInterval(fpsTimer);
    fpsTimer = null;
    resetFps(activeSource);
  }

  function recordFrame(source) {
    if (source === activeSource && !disposed && !document.hidden && fpsTimer !== null) detectionFrames++;
  }
  startFps();

  function publishTarget(ready, point = null, area = null, captured = null, line = null) {
    const detail = {ready, point, area, line};
    if (captured !== null) detail.captured_at_unix_us = captured;
    window.dispatchEvent(new CustomEvent('color-target', {detail}));
  }

  function clearTarget() {
    clearTimeout(expiry);
    output.clearRect(0, 0, overlay.width, overlay.height);
    lineResult.hidden = true;
    publishTarget(false);
  }

  function resetFps(source = 'color') {
    if (source !== activeSource) return;
    detectionFrames = 0;
    fpsTime = performance.now();
    fpsOutput.textContent = '0';
  }

  function showReference(message = '') {
    const hex = reference && explicitlySelected
      ? `#${reference.rgb.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}` : '';
    swatch.hidden = !hex;
    if (hex) swatch.style.backgroundColor = hex;
    result.replaceChildren();
    if (hex) result.append(document.createTextNode(hex));
    if (message) {
      const notice = document.createElement('span');
      notice.className = 'vision-notice';
      if (hex) notice.append(document.createTextNode(' · '));
      notice.append(document.createTextNode(message));
      result.append(notice);
      if (visionPageActive()) {
        window.dispatchEvent(new CustomEvent('console-feedback', {
          detail: {page: document.body.dataset.consolePage, text: message, error: true},
        }));
      }
    }
    result.title = '';
  }

  function disconnect() {
    setRecognitionActive(false);
    clearTimeout(reconnect);
    reconnect = null;
    const previous = socket;
    socket = null;
    window.dispatchEvent(new CustomEvent('vision-direct-binding', {detail: {source: 'color', bound: false}}));
    if (previous) previous.close();
  }

  function clear() {
    setRecognitionActive(false);
    generation++;
    phase = 'idle';
    reference = sample = null;
    explicitlySelected = false;
    lastCaptured = -1;
    resetFps();
    clearTarget();
    button.disabled = false;
    button.setAttribute('aria-pressed', 'false');
    frame.classList.remove('picking');
    showReference();
    window.dispatchEvent(new CustomEvent('color-reference-changed', {detail: null}));
    if (socket) sendSettings();
  }

  function suspend() {
    setRecognitionActive(false);
    generation++;
    phase = reference ? 'paused' : 'idle';
    sample = null;
    lastCaptured = -1;
    resetFps();
    clearTarget();
    button.setAttribute('aria-pressed', 'false');
    frame.classList.remove('picking');
    showReference();
    if (socket) sendSettings();
  }

  function command() {
    if ((phase === 'choose' && !reference) || (socket && (phase === 'idle' || phase === 'paused'))) {
      return {type: 'prepare', generation};
    }
    if (phase === 'sampling') {
      return {type: 'sample', generation, point: sample.point, threshold: Number(threshold.value),
        line: lineMode, ...(reference ? {previous_reference: reference} : {})};
    }
    if (phase === 'tracking' || phase === 'choose') {
      return {type: 'configure', generation, reference, threshold: Number(threshold.value), line: lineMode};
    }
    return null;
  }

  function sendSettings() {
    const settings = command();
    if (!settings) return;
    if (!socket) { connect(); return; }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(settings));
      setRecognitionActive(phase === 'tracking' || Boolean(reference && ['choose', 'sampling'].includes(phase)));
    }
  }

  function unavailable(message) {
    setRecognitionActive(false);
    clearTarget();
    resetFps();
    // Keep the preference (and its swatch) through camera/worker failures.
    showReference(message);
    window.dispatchEvent(new CustomEvent('vision-recognition-failed', {detail: {source: 'color', message}}));
  }

  function validReference(value) {
    return value && ['rgb', 'lab'].every(key => Array.isArray(value[key])
      && value[key].length === 3 && value[key].every(channel => Number.isFinite(channel)
        && (key !== 'rgb' || Number.isInteger(channel))
        && channel >= 0 && channel <= 255));
  }

  function validDimensions(data) {
    return Number.isInteger(data.width) && data.width > 0
      && Number.isInteger(data.height) && data.height > 0;
  }

  function sizeOverlay(data) {
    if (overlay.width !== data.width || overlay.height !== data.height) {
      overlay.width = data.width;
      overlay.height = data.height;
    }
    output.clearRect(0, 0, overlay.width, overlay.height);
  }

  function drawLineResult(data) {
    const toRaw = (x, y) => {
      if (data.rotate === 90) [x, y] = [y, 1 - x];
      else if (data.rotate === 180) [x, y] = [1 - x, 1 - y];
      else if (data.rotate === 270) [x, y] = [1 - y, x];
      return [x * data.width, y * data.height];
    };
    output.beginPath();
    for (const {top, bottom, center, box} of data.line.regions) {
      if (box) {
        output.moveTo(...toRaw(...box[0]));
        for (const point of box.slice(1)) output.lineTo(...toRaw(...point));
        output.closePath();
      }
      if (center !== null) {
        const [x, y] = toRaw(center, (top + bottom) / 2);
        output.moveTo(x + 6, y);
        output.arc(x, y, 6, 0, 2 * Math.PI);
      }
    }
    output.strokeStyle = recognitionColor;
    output.lineWidth = 3;
    output.stroke();
    if (data.line.center !== null) {
      output.lineWidth = 4;
      output.beginPath();
      output.arc(...toRaw(data.line.center, 0.84), 9, 0, 2 * Math.PI);
      output.stroke();
    }
  }

  function showSampleProgress(data) {
    if (!Array.isArray(data.point) || data.point.length !== 2
      || !data.point.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
      || !Number.isInteger(data.count) || data.count < 1 || data.count > 10) {
      throw new Error('取色进度格式无效');
    }
    sample.count = Math.max(sample.count, data.count);
    const message = `取色 ${sample.count}/10`;
    if (window.WonderduckLanguage) window.WonderduckLanguage.setLocalizedText(result, message);
    else result.textContent = message;
  }

  function canDrawOverlay() {
    return video.srcObject && !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }

  function drawSample(data) {
    if (phase !== 'sampling') return;
    if (!validDimensions(data)) throw new Error('取色进度格式无效');
    showSampleProgress(data);
    if (!canDrawOverlay()) {
      clearTarget();
      return;
    }
    sizeOverlay(data);
    drawSampleMarker(data);
    clearTimeout(expiry);
    expiry = setTimeout(clearTarget, 2000);
  }

  function drawSampleMarker(data) {
    output.beginPath();
    output.arc(sample.point[0] * data.width, sample.point[1] * data.height, sample.count, 0, 2 * Math.PI);
    output.strokeStyle = recognitionColor;
    output.lineWidth = 5;
    output.stroke();
  }

  function drawFrame(data) {
    const boundsValid = data.bounds === null || (Array.isArray(data.bounds) && data.bounds.length === 4
      && data.bounds.every(Number.isFinite) && data.bounds[0] >= 0 && data.bounds[1] >= 0
      && data.bounds[2] > 0 && data.bounds[3] > 0
      && data.bounds[0] + data.bounds[2] <= data.width
      && data.bounds[1] + data.bounds[3] <= data.height);
    if (!validDimensions(data) || !validReference(data.reference) || !boundsValid
      || !Number.isSafeInteger(data.captured_at_unix_us) || data.captured_at_unix_us < 0
      || !Number.isFinite(data.took_ms) || data.took_ms < 0
      || (data.bounds === null ? data.area !== null
        : !Number.isFinite(data.area) || data.area < 0 || data.area > 1)) {
      throw new Error('识别帧格式无效');
    }
    const normalized = value => Number.isFinite(value) && value >= 0 && value <= 1;
    const line = data.line;
    if (lineMode && (!line || (line.center !== null && !normalized(line.center))
      || !Number.isFinite(line.aspect) || line.aspect <= 0
      || !Array.isArray(line.regions) || line.regions.length !== 3
      || !line.regions.every(region => normalized(region.top) && normalized(region.bottom)
        && region.top < region.bottom && (region.center === null || normalized(region.center))
        && (region.box == null || (Array.isArray(region.box) && region.box.length === 4
          && region.box.every(point => Array.isArray(point) && point.length === 2 && point.every(normalized))))))) {
      throw new Error('识别帧格式无效');
    }
    if (data.captured_at_unix_us <= lastCaptured) return;
    lastCaptured = data.captured_at_unix_us;
    if (data.sampling && phase === 'sampling') showSampleProgress(data.sampling);
    else if (phase !== 'choose') {
      const completed = phase === 'sampling';
      reference = data.reference;
      sample = null;
      phase = 'tracking';
      button.setAttribute('aria-pressed', 'true');
      frame.classList.remove('picking');
      if (completed) {
        explicitlySelected = true;
        window.dispatchEvent(new CustomEvent('color-reference-changed', {detail: reference}));
        sendSettings();
      }
      showReference();
    }
    setRecognitionActive(true);
    if (lineMode) {
      const message = line.center === null ? '识别区域内未找到巡线' : '已识别巡线';
      if (window.WonderduckLanguage) window.WonderduckLanguage.setLocalizedText(lineResult, message);
      else if (lineResult.textContent !== message) lineResult.textContent = message;
      lineResult.hidden = false;
    }
    recordFrame('color');
    const drawOverlay = canDrawOverlay();
    if (drawOverlay) sizeOverlay(data);
    if (lineMode && drawOverlay) drawLineResult(data);
    let point = null;
    if (data.bounds) {
      const [x, y, width, height] = data.bounds;
      if (drawOverlay) {
        output.strokeStyle = recognitionColor;
        output.lineWidth = 2;
        output.strokeRect(x, y, width, height);
      }
      let u = (x + width / 2) / data.width, v = (y + height / 2) / data.height;
      if (data.rotate === 90) [u, v] = [1 - v, u];
      else if (data.rotate === 180) [u, v] = [1 - u, 1 - v];
      else if (data.rotate === 270) [u, v] = [v, 1 - u];
      point = [Math.max(-1, Math.min(1, 2 * u - 1)), Math.max(-1, Math.min(1, 2 * v - 1))];
    }
    if (drawOverlay && phase === 'sampling' && sample.count) drawSampleMarker(data);
    // A selected reference is ready even when no matching contour is present.
    publishTarget(true, point, data.area, data.captured_at_unix_us, lineMode ? line : null);
    clearTimeout(expiry);
    expiry = setTimeout(clearTarget, 2000);
  }

  function connect() {
    if (disposed || socket || !command()) return;
    clearTimeout(reconnect);
    reconnect = null;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(`${scheme}//${location.host}/colors`);
    socket = connection;
    lastCaptured = -1;
    // A reconnected worker starts sampling from its own first frame.
    if (sample) sample.count = 0;
    connection.onopen = () => { if (socket === connection) { bindTracking(); sendSettings(); } };
    connection.onmessage = event => {
      if (socket !== connection) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'tracking_bound') {
          window.dispatchEvent(new CustomEvent('vision-direct-binding', {detail: {source: 'color', bound: data.accepted === true}}));
        } else if (data.type === 'prepared') {
          if (data.generation !== generation || phase !== 'choose') return;
        } else if (data.type === 'sampling' || data.type === 'frame') {
          if (data.generation !== generation || !command()) return;
          if (data.type === 'sampling') drawSample(data);
          else if (activeSource === 'color' && (phase === 'sampling' || phase === 'tracking' || (phase === 'choose' && reference))) drawFrame(data);
        } else if (['waiting', 'recovering', 'error'].includes(data.type)) {
          const label = {waiting: '等待摄像头', recovering: '等待摄像头恢复', error: '颜色识别失败'}[data.type];
          const message = [label, data.message].filter(Boolean).join('：');
          clearTarget();
          resetFps();
          if (data.type === 'error') {
            // A failed worker cannot recover on this connection. Keep the
            // preference, but let an explicit user action start a fresh one.
            disconnect();
            showReference(message);
            window.dispatchEvent(new CustomEvent('vision-recognition-failed', {detail: {source: 'color', message}}));
          }
          else if (reference) {
            // Saved references remain visible before the camera is available.
            showReference();
            result.title = message;
          } else if (phase === 'choose' && data.type === 'waiting') {
            result.title = message;
          } else result.textContent = message;
        } else throw new Error('未知识别消息');
      } catch (error) { unavailable(`颜色识别数据错误：${error.message}`); }
    };
    connection.onerror = () => {
      if (socket === connection) unavailable('颜色识别连接失败');
    };
    connection.onclose = () => {
      if (socket !== connection) return;
      socket = null;
      window.dispatchEvent(new CustomEvent('vision-direct-binding', {detail: {source: 'color', bound: false}}));
      if (!command()) return;
      unavailable('颜色识别连接已断开，正在重连');
      reconnect = setTimeout(connect, 1000);
    };
  }

  function coordinates(event) {
    const width = video.videoWidth, height = video.videoHeight;
    if (width < 2 || height < 2) return null;
    const rotate = video.classList.contains('turn90') ? 90
      : video.classList.contains('turn180') ? 180
      : video.classList.contains('turn270') ? 270 : 0;
    const rect = frame.getBoundingClientRect();
    // The video fills the frame's padding box; its border is not image content.
    const boxWidth = rect.width - frame.offsetWidth + frame.clientWidth;
    const boxHeight = rect.height - frame.offsetHeight + frame.clientHeight;
    if (!boxWidth || !boxHeight) return null;
    const x = event.clientX - rect.left - frame.clientLeft;
    const y = event.clientY - rect.top - frame.clientTop;
    if (x < 0 || x >= boxWidth || y < 0 || y >= boxHeight) return null;
    const rotatedWidth = rotate % 180 ? height : width;
    const rotatedHeight = rotate % 180 ? width : height;
    const scale = Math.min(boxWidth / rotatedWidth, boxHeight / rotatedHeight);
    const shownWidth = rotatedWidth * scale, shownHeight = rotatedHeight * scale;
    let u = (x - (boxWidth - shownWidth) / 2) / shownWidth;
    let v = (y - (boxHeight - shownHeight) / 2) / shownHeight;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    if (rotate === 90) [u, v] = [v, 1 - u];
    else if (rotate === 180) [u, v] = [1 - u, 1 - v];
    else if (rotate === 270) [u, v] = [1 - v, u];
    // The included displayed left/top edge can become the raw right/bottom
    // edge. Send its last pixel while preserving every interior coordinate.
    return [u === 1 ? (width - 1) / width : u, v === 1 ? (height - 1) / height : v];
  }

  button.addEventListener('click', () => {
    if (phase === 'choose' || phase === 'sampling') {
      cancelPick();
      return;
    }
    if (phase !== 'tracking') clear();
    window.dispatchEvent(new Event('color-pick-start'));
    suspendedByPage = false;
    phase = 'choose';
    button.setAttribute('aria-pressed', 'true');
    frame.classList.add('picking');
    result.textContent = '请选择画面区域';
    window.dispatchEvent(new CustomEvent('console-feedback', {
      detail: {page: document.body.dataset.consolePage, text: '请将鼠标移到摄像头画面中，点击要取色的物体', error: false},
    }));
    sendSettings();
  });
  frame.addEventListener('click', event => {
    if (phase !== 'choose' || event.button !== 0) return;
    const point = coordinates(event);
    if (!point || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      result.textContent = video.videoWidth ? '请选择画面区域' : '画面未连接';
      return;
    }
    generation++;
    lastCaptured = -1;
    phase = 'sampling';
    sample = {point, count: 0};
    result.textContent = '取色 0/10';
    sendSettings();
  });
  function cancelPick() {
    if (!reference) { clear(); return; }
    generation++;
    phase = 'tracking';
    sample = null;
    frame.classList.remove('picking');
    showReference();
    sendSettings();
  }

  frame.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (phase === 'choose' || phase === 'sampling') cancelPick();
    else if (phase !== 'paused') clear();
  });
  window.addEventListener('vision-source-change', event => {
    if (activeSource !== event.detail) {
      activeSource = event.detail;
      resetFps(activeSource);
    }
    if (activeSource === 'object') { suspend(); disconnect(); }
  });
  window.addEventListener('vision-recognition-stop', () => { suspend(); disconnect(); });
  window.addEventListener('object-detection-frame', () => recordFrame('object'));
  window.addEventListener('object-detection-reset', () => resetFps('object'));
  function loadReference(value, presetThreshold, explicit) {
    if (!value) { clear(); return; }
    if (!validReference(value)) { showReference('已保存颜色参照无效'); return; }
    if (!explicit || !reference) clear();
    else {
      generation++;
      sample = null;
      frame.classList.remove('picking');
    }
    if (explicit) suspendedByPage = false;
    reference = value;
    explicitlySelected = explicit;
    phase = !explicit || activeSource === 'object' || !visionPageActive() || suspendedByPage ? 'paused' : 'tracking';
    if (presetThreshold !== undefined) {
      threshold.value = String(presetThreshold);
      thresholdValue.textContent = Number(threshold.value).toFixed(2);
    }
    button.setAttribute('aria-pressed', String(phase === 'tracking'));
    showReference();
    if (explicit) window.dispatchEvent(new CustomEvent('color-reference-changed', {detail: reference}));
    sendSettings();
  }
  window.addEventListener('color-reference-load', event => {
    if (event.cancelable && (phase === 'choose' || phase === 'sampling' || explicitlySelected)) {
      event.preventDefault();
      return;
    }
    loadReference(event.detail, undefined, false);
  });
  window.addEventListener('color-preset-load', event => {
    loadReference(event.detail.reference, event.detail.threshold, true);
  });
  threshold.addEventListener('input', () => {
    thresholdValue.textContent = Number(threshold.value).toFixed(2);
    sendSettings();
  });
  window.addEventListener('console-page-changed', () => {
    const lineChanged = lineMode !== lineFollowing();
    lineMode = lineFollowing();
    if (!visionPageActive()) {
      suspendedByPage = true;
      explicitlySelected = false;
      suspend();
      disconnect();
    } else if (lineChanged) {
      generation++;
      lastCaptured = -1;
      if (sample) sample.count = 0;
      clearTarget();
      sendSettings();
    }
  });
  window.addEventListener('studio-leave', () => {
    suspendedByPage = true;
    explicitlySelected = false;
    suspend();
    disconnect();
  });
  overlay.className = video.className;
  new MutationObserver(() => { overlay.className = video.className; })
    .observe(video, {attributes: true, attributeFilter: ['class']});
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopFps();
    else startFps();
  });
  window.addEventListener('pagehide', () => {
    disposed = true;
    stopFps();
    disconnect();
    clearTarget();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted || !disposed) return;
    disposed = false;
    startFps();
    // Restore recognition only. Movement remains controlled by its own UI.
    connect();
  });
})();
