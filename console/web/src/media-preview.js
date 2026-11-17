/** Receive the existing media service's WebRTC stream in the 3D viewer. */
export function createMediaPreview({ onError, root = document }) {
  const viewer = root.getElementById('viewer');
  const video = root.getElementById('camera-video');
  const status = root.getElementById('camera-status');
  const expand = root.getElementById('camera-expand');
  let current = null, retry = null, enabled = false, expanded = false, lastError = '';

  function show(message, error = false) {
    status.textContent = message;
    status.hidden = !message || error;
    if (!message) lastError = '';
    else if (error && message !== lastError) { lastError = message; onError(message); }
  }
  function setExpanded(value) {
    expanded = value;
    viewer.classList.toggle('camera-expanded', value);
    expand.setAttribute('aria-pressed', String(value));
    expand.setAttribute('aria-label', value ? '恢复摄像头小窗' : '摄像头全屏');
    expand.title = value ? '恢复左上角小窗' : '铺满3D视图区';
    expand.textContent = value ? '恢复小窗' : '全屏';
  }
  expand.addEventListener('click', () => setExpanded(!expanded));
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && expanded) setExpanded(false); });

  function disconnect(session, reason) {
    if (current !== session) return;
    current = null;
    clearTimeout(session.timeout);
    clearTimeout(session.listTimer);
    clearTimeout(session.disconnectedTimer);
    session.peer?.close();
    session.socket.close();
    video.srcObject = null;
    if (enabled && !root.hidden) {
      show(reason, true);
      retry = setTimeout(connect, 2000);
    }
  }
  function send(session, message) {
    if (current === session && session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message));
  }
  function startPeer(session) {
    const peer = session.peer = new RTCPeerConnection({ iceServers: [] });
    peer.ontrack = event => {
      if (current !== session || event.track.kind !== 'video') return;
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      event.track.onended = () => disconnect(session, '画面已断开，正在重连');
      video.play().catch(error => { if (current === session) show(`播放失败：${error.message}`, true); });
    };
    peer.onicecandidate = event => {
      if (event.candidate) send(session, { type: 'peer', sessionId: session.id,
        ice: { candidate: event.candidate.candidate, sdpMLineIndex: event.candidate.sdpMLineIndex } });
    };
    peer.onconnectionstatechange = () => {
      if (current !== session) return;
      if (['failed', 'closed'].includes(peer.connectionState)) disconnect(session, '图传连接中断，正在重连');
      else if (peer.connectionState === 'disconnected') {
        clearTimeout(session.disconnectedTimer);
        session.disconnectedTimer = setTimeout(() => disconnect(session, '图传连接中断，正在重连'), 5000);
      } else if (peer.connectionState === 'connected') clearTimeout(session.disconnectedTimer);
    };
    peer.ondatachannel = event => {
      if (current !== session || event.channel.label !== 'control') return;
      event.channel.onopen = () => event.channel.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'media.video', params: {} }));
      event.channel.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          const info = message.method === 'media.video' ? message.params : message.id === 1 ? message.result : null;
          if (info && [0, 90, 180, 270].includes(info.rotate)) video.className = info.rotate ? `turn${info.rotate}` : '';
        } catch (error) { console.warn('摄像头信息无效', error); }
      };
    };
  }
  async function signal(session, raw) {
    const message = JSON.parse(raw);
    if (message.type === 'welcome') send(session, { type: 'list' });
    else if (message.type === 'list' && !session.starting && !session.id) {
      const producer = (message.producers || [])[0];
      if (!producer) {
        show('等待摄像头');
        clearTimeout(session.listTimer);
        session.listTimer = setTimeout(() => send(session, { type: 'list' }), 2000);
      } else {
        session.starting = true;
        send(session, { type: 'startSession', peerId: producer.id });
      }
    } else if (message.type === 'sessionStarted') {
      session.id = message.sessionId;
      session.starting = false;
      startPeer(session);
    } else if (message.type === 'peer' && message.sessionId === session.id) {
      if (!session.peer) throw new Error('图传会话尚未创建');
      if (message.sdp) {
        await session.peer.setRemoteDescription(message.sdp);
        for (const candidate of session.pendingIce) await session.peer.addIceCandidate(candidate);
        session.pendingIce = [];
        const answer = await session.peer.createAnswer();
        await session.peer.setLocalDescription(answer);
        send(session, { type: 'peer', sessionId: session.id, sdp: { type: 'answer', sdp: answer.sdp } });
      } else if (message.ice) {
        const candidate = { candidate: message.ice.candidate, sdpMLineIndex: message.ice.sdpMLineIndex };
        if (session.peer.remoteDescription) await session.peer.addIceCandidate(candidate);
        else session.pendingIce.push(candidate);
      }
    } else if (message.type === 'endSession' || message.type === 'sessionRejected') {
      disconnect(session, '图传会话已结束，正在重连');
    }
  }
  function connect() {
    if (!enabled || root.hidden || current) return;
    if (!globalThis.RTCPeerConnection) { show('当前浏览器不支持实时摄像头', true); return; }
    show('摄像头连接中');
    const endpoint = new URL(location.href);
    endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.port = location.protocol === 'https:' ? '9445' : '8443'; endpoint.pathname = '/'; endpoint.search = ''; endpoint.hash = '';
    const session = current = { socket: new WebSocket(endpoint.href), peer: null, id: null,
      starting: false, pendingIce: [], queue: Promise.resolve(), timeout: null, listTimer: null, disconnectedTimer: null };
    session.timeout = setTimeout(() => disconnect(session, '图传超时，正在重连'), 20000);
    session.socket.onmessage = event => {
      session.queue = session.queue.then(() => { if (current === session) return signal(session, event.data); })
        .catch(error => { console.error('图传协商失败', error); disconnect(session, '图传协商失败，正在重连'); });
    };
    session.socket.onclose = () => disconnect(session, '图传未连接，正在重试');
    session.socket.onerror = () => session.socket.close();
  }
  function stop() {
    clearTimeout(retry); retry = null;
    if (current) disconnect(current, '图传已关闭');
    setExpanded(false);
  }
  video.addEventListener('playing', () => { if (current) { clearTimeout(current.timeout); show(''); } });
  root.addEventListener('visibilitychange', () => { if (root.hidden) stop(); else if (enabled) connect(); });
  globalThis.addEventListener('pagehide', () => { enabled = false; stop(); });
  return {
    start() { enabled = true; connect(); },
    stop() { enabled = false; stop(); },
    get expanded() { return expanded; },
  };
}
