const loadTimeout = 15000;
const readyTimeout = 5000;
const leaveTimeout = 12000;

export function createWorkspaceFrames({ control, debug, controlUrl, onDebugPreview }) {
  let controlLoad = null;
  let debugLoad = null;
  let controlActive = false;
  let leaving = null;
  let messageId = 0;
  const navigations = new WeakMap();
  const hasFrame = frame => Boolean(frame.contentWindow && frame.src && frame.src !== 'about:blank');
  const origin = frame => new URL(frame.src).origin;

  function post(frame, type, data = {}) {
    if (hasFrame(frame)) frame.contentWindow.postMessage({ type, ...data }, origin(frame));
  }

  function notify(type, data) {
    post(control, type, data);
    post(debug, type, data);
  }

  // Associate acknowledgements with this frame and request even when the parent reuses the iframe.
  function exchange(type, reply, payload, timeout, timeoutMessage, signal) {
    const requestId = ++messageId;
    const source = control.contentWindow;
    const frameOrigin = origin(control);
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeout);
      function finish(error, result) {
        clearTimeout(timer);
        window.removeEventListener('message', receive);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(result);
      }
      function receive(event) {
        const data = event.data;
        if (event.source !== source || event.origin !== frameOrigin
            || data?.type !== reply || data.requestId !== requestId
            || (payload.page && data.page !== payload.page)) return;
        finish(null, data);
      }
      function cancel() { finish(signal.reason); }
      window.addEventListener('message', receive);
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        source.postMessage({ type, requestId, ...payload }, frameOrigin);
      } catch (error) { finish(error); }
    });
  }

  function load(frame, url, signal) {
    navigations.get(frame)?.abort();
    const navigation = new AbortController();
    navigations.set(frame, navigation);
    const cancellation = signal ? AbortSignal.any([signal, navigation.signal]) : navigation.signal;
    return new Promise((resolve, reject) => {
      cancellation.throwIfAborted();
      const timer = setTimeout(() => finish(new Error('页面加载超时，请重试')), loadTimeout);
      function finish(error) {
        clearTimeout(timer);
        frame.removeEventListener('load', loaded);
        cancellation.removeEventListener('abort', cancel);
        if (navigations.get(frame) === navigation) navigations.delete(frame);
        if (error) reject(error); else resolve();
      }
      function loaded() { finish(); }
      function cancel() { finish(cancellation.reason); }
      frame.addEventListener('load', loaded, { once: true });
      cancellation.addEventListener('abort', cancel, { once: true });
      frame.src = url;
    });
  }

  function clear(frame) {
    navigations.get(frame)?.abort();
    frame.classList.add('frame-clearing');
    if (frame.getAttribute('src') !== 'about:blank') frame.src = 'about:blank';
  }

  function previewControl(page, isVisible) {
    if (!controlLoad && !hasFrame(control)) {
      controlLoad = load(control, controlUrl()).catch(error => {
        if (error.name !== 'AbortError') clear(control);
        throw error;
      }).finally(() => { controlLoad = null; });
    }
    return Promise.resolve(controlLoad).then(() => {
      if (!isVisible() || controlActive || !hasFrame(control)) return;
      post(control, 'studio-workspace-preview', { page });
      control.classList.remove('frame-clearing');
    });
  }

  function previewDebug(isVisible) {
    if (debugLoad) return debugLoad;
    if (debug.getAttribute('src') === '/debug.html?preview=1'
        && !debug.classList.contains('frame-clearing')) return Promise.resolve();
    debugLoad = load(debug, '/debug.html?preview=1').then(() => {
      if (isVisible() && debug.getAttribute('src') === '/debug.html?preview=1') {
        debug.classList.remove('frame-clearing');
        onDebugPreview();
      }
    }).catch(error => console.debug('舵机调试预览不可用', error.message))
      .finally(() => { debugLoad = null; });
    return debugLoad;
  }

  async function activate(page, signal) {
    controlActive = true;
    await exchange('studio-workspace', 'studio-workspace-ready', { page },
      readyTimeout, '页面准备超时，请重试', signal);
    control.classList.remove('frame-clearing');
  }

  function resumeControl(page) {
    if (!hasFrame(control)) return;
    controlActive = true;
    post(control, 'studio-workspace', { page });
  }

  function leaveControl(signal) {
    if (leaving) return leaving;
    if (!controlActive || !hasFrame(control)) return Promise.resolve();
    controlActive = false;
    leaving = exchange('studio-leave', 'studio-leave-result', {}, leaveTimeout, '操控页面退出超时，请重试', signal)
      .then(result => {
        if (!result.accepted) throw new Error(result.reason || '操控页面退出失败');
      }).catch(error => {
        post(control, 'studio-disconnect');
        throw error;
      }).finally(() => { leaving = null; });
    return leaving;
  }

  return {
    notify,
    hasControl: () => hasFrame(control),
    previewControl,
    previewDebug,
    activate,
    resumeControl,
    leaveControl,
    async loadDebug(readonly, signal) {
      // Finish any preview navigation before replacing it with the live frame.
      await debugLoad;
      signal?.throwIfAborted();
      const url = readonly ? '/debug.html?preview=1' : '/debug.html';
      if (debug.getAttribute('src') !== url || debug.classList.contains('frame-clearing')) {
        await load(debug, url, signal);
      }
      debug.classList.remove('frame-clearing');
    },
    clearDebug() { clear(debug); },
    clearControl() { controlActive = false; clear(control); },
    disconnect() { controlActive = false; notify('studio-disconnect'); },
  };
}
