(() => {
  const personClass = 0;
  const canvas = document.querySelector('#object-overlay');
  const video = document.querySelector('#camera-video');
  const status = document.querySelector('#object-status');
  const areaValue = document.querySelector('#object-area-value');
  const context = canvas.getContext('2d');
  let socket = null;
  function bindTracking() {
    if (socket?.readyState === WebSocket.OPEN && window.__visionControlToken) {
      socket.send(JSON.stringify({type: 'bind_tracking', token: window.__visionControlToken}));
    } else window.dispatchEvent(new CustomEvent('vision-direct-binding', {detail: {source: 'object', bound: false}}));
  }
  window.addEventListener('vision-control-token', bindTracking);
  let expiry = null;
  let lastCaptured = -1;

  function setRecognitionActive(active) {
    if (active) document.body.dataset.recognitionSource = 'object';
    else if (document.body.dataset.recognitionSource === 'object') delete document.body.dataset.recognitionSource;
  }

  function publishTarget(ready, point = null, area = null, captured = null, areaPx = null) {
    const detail = {ready, point, area, area_px: areaPx};
    if (captured !== null) detail.captured_at_unix_us = captured;
    window.dispatchEvent(new CustomEvent('object-target', {detail}));
  }

  function clear() {
    clearTimeout(expiry);
    context.clearRect(0, 0, canvas.width, canvas.height);
    areaValue.textContent = '--';
    publishTarget(false);
  }

  function stop(message = '') {
    setRecognitionActive(false);
    const previous = socket;
    socket = null;
    window.dispatchEvent(new CustomEvent('vision-direct-binding', {detail: {source: 'object', bound: false}}));
    if (previous) previous.close();
    window.dispatchEvent(new Event('object-detection-reset'));
    clear();
    status.textContent = message;
    status.classList.toggle('vision-notice', !!message);
    if (message) window.dispatchEvent(new CustomEvent('vision-recognition-failed', {detail: {source: 'object', message}}));
  }

  function validFrame(frame) {
    return Number.isSafeInteger(frame.captured_at_unix_us) && frame.captured_at_unix_us >= 0
      && Number.isInteger(frame.width) && frame.width > 0
      && Number.isInteger(frame.height) && frame.height > 0
      && Number.isFinite(frame.took_ms) && frame.took_ms >= 0
      && Array.isArray(frame.objects) && frame.objects.every(object => object
        && Number.isInteger(object.class) && object.class >= 0 && Number.isFinite(object.score)
        && Array.isArray(object.bounds) && object.bounds.length === 4 && object.bounds.every(Number.isFinite)
        && object.bounds[0] >= 0 && object.bounds[1] >= 0
        && object.bounds[2] > object.bounds[0] && object.bounds[2] <= frame.width
        && object.bounds[3] > object.bounds[1] && object.bounds[3] <= frame.height);
  }

  function draw(frame) {
    const area = (object) => (object.bounds[2] - object.bounds[0]) * (object.bounds[3] - object.bounds[1]);
    let selected = null;
    for (const object of frame.objects) {
      if (object.class === personClass && (!selected || area(object) > area(selected))) selected = object;
    }
    const areaPx = selected ? Math.round(area(selected)) : null;
    const areaFraction = selected ? area(selected) / (frame.width * frame.height) : null;
    areaValue.textContent = selected ? `${Math.round(areaFraction * 1280 * 720)} px²` : '--';
    if (video.srcObject && !video.paused) {
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (selected) {
        const [left, top, right, bottom] = selected.bounds;
        context.lineWidth = Math.max(2, frame.width / 400);
        context.strokeStyle = '#8fc7e7';
        context.strokeRect(left, top, right - left, bottom - top);
      }
    }
    if (status.textContent) status.textContent = '';
    // Detection bounds are already upright; the camera's CSS rotation must
    // not be applied again to the target sent to movement tracking.
    const point = selected ? [
      (selected.bounds[0] + selected.bounds[2]) / frame.width - 1,
      (selected.bounds[1] + selected.bounds[3]) / frame.height - 1,
    ] : null;
    publishTarget(true, point, areaFraction,
      frame.captured_at_unix_us, areaPx);
    clearTimeout(expiry);
    expiry = setTimeout(clear, 2000);
  }

  function start() {
    if (socket || document.body.dataset.consolePage !== 'person') return;
    window.dispatchEvent(new Event('object-detection-reset'));
    lastCaptured = -1;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(`${scheme}//${location.host}/objects`);
    socket = connection;
    connection.onopen = () => { if (socket === connection) { setRecognitionActive(true); bindTracking(); } };
    status.classList.remove('vision-notice');
    status.textContent = '';
    connection.onmessage = (event) => {
      if (socket !== connection) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'tracking_bound') {
          window.dispatchEvent(new CustomEvent('vision-direct-binding', {detail: {source: 'object', bound: data.accepted === true}}));
        } else if (data.type === 'frame') {
          if (!validFrame(data)) throw new Error('识别帧格式无效');
          if (data.captured_at_unix_us <= lastCaptured) return;
          lastCaptured = data.captured_at_unix_us;
          setRecognitionActive(true);
          draw(data);
          window.dispatchEvent(new Event('object-detection-frame'));
        }
        else if (data.type === 'waiting' || data.type === 'recovering') {
          window.dispatchEvent(new Event('object-detection-reset'));
          if (data.type === 'recovering') { clear(); status.textContent = '等待摄像头恢复'; }
        }
        else if (data.type === 'error') stop(data.message);
      } catch (error) { stop(`检测数据错误：${error.message}`); }
    };
    connection.onerror = () => { if (socket === connection) stop('物体检测连接失败'); };
    connection.onclose = () => { if (socket === connection) stop('物体检测已断开'); };
  }

  window.addEventListener('vision-source-change', event => {
    if (event.detail === 'color' && socket) stop();
  });
  window.addEventListener('vision-recognition-start', event => {
    if (event.detail === 'object') start();
  });
  window.addEventListener('vision-recognition-stop', () => { if (socket) stop(); });
  window.addEventListener('camera-preview-paused', event => {
    if (event.detail) context.clearRect(0, 0, canvas.width, canvas.height);
  });
  window.addEventListener('console-page-changed', () => {
    if (document.body.dataset.consolePage !== 'person' && socket) stop();
  });
  window.addEventListener('pagehide', () => stop());
})();
