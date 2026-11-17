// Record only while the user holds the button, then send the recording for playback.
(() => {
  const button = document.querySelector('#voice-talk');
  const text = button.querySelector('span');
  const notice = document.querySelector('#notice');
  let session = null;
  let uploading = false;

  function feedback(message, error = false) {
    notice.textContent = message;
    notice.title = message;
    notice.classList.toggle('error', error);
  }

  function render(state = 'idle') {
    const labels = { idle: '按住喊话', requesting: '请求麦克风', recording: '松开发送', uploading: '发送中' };
    button.dataset.state = state;
    button.disabled = state === 'uploading';
    button.setAttribute('aria-pressed', String(state === 'recording'));
    button.title = state === 'recording' ? '松开后发送录音' : '按住录音，松开发送';
    text.textContent = labels[state];
  }

  function releaseTracks(stream) {
    stream.getTracks().forEach(track => track.stop());
  }

  function microphoneError(error) {
    if (!window.isSecureContext) return '请使用安全连接访问，浏览器才能申请麦克风权限';
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return '请在浏览器中允许麦克风权限';
    if (error.name === 'NotFoundError') return '未找到麦克风';
    if (error.name === 'NotReadableError') return '麦克风正在被占用或无法读取';
    return error.message || '无法使用麦克风';
  }

  async function upload(recording) {
    uploading = true;
    render('uploading');
    try {
      const response = await fetch('/voice-message', { method: 'POST', body: recording });
      if (!response.ok) throw new Error((await response.text()).trim() || `服务返回 ${response.status}`);
      feedback('喊话播放完成');
    } catch (error) {
      feedback(`喊话失败：${error.message}`, true);
    } finally {
      uploading = false;
      render();
    }
  }

  function finish(send) {
    const current = session;
    if (!current || !current.pressed) return;
    current.pressed = false;
    current.send = send;
    if (!current.recorder) return; // A permission request is still pending.
    if (current.recorder.state !== 'inactive') {
      if (send) {
        uploading = true;
        render('uploading');
      } else {
        render();
      }
      current.recorder.stop();
    }
  }

  async function start(input, pointerId = null) {
    if (session || uploading) return;
    if (!window.isSecureContext) {
      feedback('喊话不可用：浏览器需要安全连接才能使用麦克风', true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') {
      feedback(`喊话不可用：${microphoneError({name: 'NotSupportedError', message: '浏览器不支持录音'})}`, true);
      return;
    }
    const current = { input, pointerId, pressed: true, send: false, recorder: null };
    session = current;
    render('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      current.stream = stream;
      if (session !== current || !current.pressed) {
        releaseTracks(stream);
        if (session === current) {
          session = null;
          render();
          if (current.send) feedback('麦克风已允许，请按住喊话');
        }
        return;
      }
      const recorder = new MediaRecorder(stream);
      current.recorder = recorder;
      const parts = [];
      recorder.addEventListener('dataavailable', event => { if (event.data.size) parts.push(event.data); });
      recorder.addEventListener('error', event => {
        current.send = false;
        feedback(`录音失败：${event.error?.message || '麦克风不可用'}`, true);
      });
      recorder.addEventListener('stop', () => {
        releaseTracks(stream);
        if (session === current) session = null;
        if (!current.send) {
          uploading = false;
          render();
          return;
        }
        const recording = new Blob(parts, { type: recorder.mimeType || parts[0]?.type || '' });
        if (!recording.size) {
          uploading = false;
          render();
          feedback('录音为空，请按住按钮说话后再松开', true);
          return;
        }
        upload(recording);
      });
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => {
          if (session === current && current.pressed) {
            finish(false);
            feedback('录音中断：麦克风不可用', true);
          }
        }, { once: true });
      }
      recorder.start();
      render('recording');
    } catch (error) {
      if (current.stream) releaseTracks(current.stream);
      if (session === current) session = null;
      render();
      feedback(`喊话不可用：${microphoneError(error)}`, true);
    }
  }

  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || session || uploading) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    start('pointer', event.pointerId);
  });
  button.addEventListener('pointerup', event => {
    if (session?.input === 'pointer' && session.pointerId === event.pointerId) finish(true);
  });
  for (const name of ['pointercancel', 'lostpointercapture']) {
    button.addEventListener(name, event => {
      if (session?.input === 'pointer' && session.pointerId === event.pointerId) finish(false);
    });
  }
  button.addEventListener('keydown', event => {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) start('keyboard', event.key);
  });
  button.addEventListener('keyup', event => {
    if (session?.input !== 'keyboard' || session.pointerId !== event.key) return;
    event.preventDefault();
    finish(true);
  });
  for (const name of ['blur', 'pagehide', 'studio-leave', 'console-view-change']) {
    window.addEventListener(name, () => finish(false));
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(false); });
  render();
})();
