/** Receive one hardware H.264 stream; expand it inside the existing 3D viewer. */
export function createCameraPreview({ request, headers, onError, root = document }) {
  const viewer = root.getElementById('viewer');
  const video = root.getElementById('camera-video');
  const button = root.getElementById('camera-expand');
  const status = root.getElementById('camera-status');
  let peer = null, session = null, generation = 0, retry = null, heartbeat = null;
  let enabled = false, expanded = false, lastError = '';

  function message(text, error = false) {
    status.textContent = text;
    status.hidden = !text || error;
    if (!text) lastError = '';
    else if (error && text !== lastError) { lastError = text; onError(text); }
  }

  function expand(value) {
    expanded = value;
    viewer.classList.toggle('camera-expanded', value);
    button.setAttribute('aria-pressed', String(value));
    button.setAttribute('aria-label', value ? '恢复摄像头小窗' : '摄像头全屏');
    button.title = value ? '恢复左上角小窗' : '铺满3D视图区';
    button.textContent = value ? '恢复小窗' : '全屏';
  }
  button.addEventListener('click', () => expand(!expanded));
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && expanded) expand(false);
  });

  function stop() {
    generation++;
    clearTimeout(retry); retry = null;
    clearInterval(heartbeat); heartbeat = null;
    const previousPeer = peer; peer = null;
    previousPeer?.close();
    video.srcObject = null;
    const previousSession = session; session = null;
    if (previousSession) {
      fetch('/api/camera/close', {
        method: 'POST', headers: headers(), body: JSON.stringify({ session: previousSession }),
        keepalive: true,
      }).catch(error => console.debug('摄像头会话关闭请求未送达', error.message));
    }
  }

  function reconnect(error) {
    stop();
    message(`摄像头未连接：${error.message}`, true);
    if (enabled && !root.hidden) retry = setTimeout(connect, 4000);
  }

  async function gather(connection) {
    if (connection.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('摄像头网络协商超时')), 8000);
      function finish(error) {
        clearTimeout(timeout);
        connection.removeEventListener('icegatheringstatechange', changed);
        if (error) reject(error); else resolve();
      }
      function changed() { if (connection.iceGatheringState === 'complete') finish(); }
      connection.addEventListener('icegatheringstatechange', changed);
    });
  }

  async function connect() {
    if (!enabled || root.hidden || peer) return;
    if (!globalThis.RTCPeerConnection) {
      message('当前浏览器不支持实时摄像头', true);
      return;
    }
    message('摄像头连接中');
    const current = generation;
    const connection = peer = new RTCPeerConnection({ iceServers: [] });
    try {
      const prepared = await request('camera/prepare', {});
      if (current !== generation) return;
      connection.setConfiguration({
        iceServers: [{ urls: `stun:${location.hostname}:${prepared.stun_port}` }],
      });
      const transceiver = connection.addTransceiver('video', { direction: 'recvonly' });
      const codecs = RTCRtpReceiver.getCapabilities('video').codecs.filter(codec =>
        codec.mimeType.toLowerCase() === 'video/h264'
        && /packetization-mode=1/.test(codec.sdpFmtpLine || '')
        && /profile-level-id=42/i.test(codec.sdpFmtpLine || ''));
      if (!codecs.length) throw new Error('当前浏览器不支持H.264摄像头画面');
      transceiver.setCodecPreferences(codecs);
      connection.addEventListener('track', event => {
        if (current !== generation) return;
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
        video.play().catch(error => { if (current === generation) reconnect(error); });
      });
      connection.addEventListener('connectionstatechange', () => {
        if (current === generation && ['failed', 'disconnected'].includes(connection.connectionState)) {
          reconnect(new Error('视频连接中断，正在重连'));
        }
      });
      await connection.setLocalDescription(await connection.createOffer());
      await gather(connection);
      if (current !== generation) return;
      const answer = await request('camera/offer', {
        type: 'offer', sdp: connection.localDescription.sdp,
      });
      if (current !== generation) {
        fetch('/api/camera/close', {
          method: 'POST', headers: headers(), body: JSON.stringify({ session: answer.session }),
          keepalive: true,
        }).catch(error => console.debug('过期摄像头会话关闭失败', error.message));
        return;
      }
      session = answer.session;
      await connection.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
      if (current !== generation) return;
      heartbeat = setInterval(async () => {
        try { await request('camera/keepalive', { session }); }
        catch (error) { if (current === generation) reconnect(error); }
      }, 4000);
    } catch (error) {
      if (current === generation) reconnect(error);
    }
  }

  video.addEventListener('playing', () => message(''));
  video.addEventListener('waiting', () => { if (peer) message('等待摄像头画面'); });
  root.addEventListener('visibilitychange', () => {
    if (root.hidden) { stop(); message('摄像头已暂停'); }
    else if (enabled) connect();
  });
  globalThis.addEventListener('pagehide', stop);
  return {
    start() { enabled = true; connect(); },
    stop() { enabled = false; stop(); expand(false); },
    get expanded() { return expanded; },
  };
}
