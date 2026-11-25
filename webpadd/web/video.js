(() => {
  const video = document.querySelector('#camera-video');
  const frame = document.querySelector('.camera-frame');
  const cameraPanel = video.closest('.camera-panel');
  const workspace = video.closest('.workspace');
  const status = document.querySelector('#camera-status');
  const placeholder = document.querySelector('#camera-placeholder');
  const page = () => document.body.dataset.consolePage;
  const wantsPreview = () => previewEnabled && !stopped && page() !== 'system';
  const endpoint = new URL(location.href);
  endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.port = location.protocol === 'https:' ? '9445' : document.body.dataset.mediaPort;
  endpoint.pathname = '/';
  endpoint.search = '';
  endpoint.hash = '';

  let current = null;
  let retryTimer = null;
  let retryDelay = 1000;
  let stopped = false;
  let previewEnabled = document.documentElement.dataset.studioEmbedded !== 'true' || window.parent === window;
  const fpsOutput = document.querySelector('#video-fps');
  let frameHandle = null;
  let frames = 0;
  let fpsTime = performance.now();
  let lastVideoTime = -1;
  let lastPresentedFrames = null;
  const fpsTimer = setInterval(() => {
    const now = performance.now();
    fpsOutput.textContent = (frames * 1000 / (now - fpsTime)).toFixed(0);
    frames = 0;
    fpsTime = now;
  }, 1000);

  function countFrames() {
    if (frameHandle !== null || stopped || video.paused) return;
    const callback = (_, metadata) => {
      frameHandle = null;
      if (stopped || video.paused) return;
      if (metadata) {
        frames += lastPresentedFrames === null || metadata.presentedFrames < lastPresentedFrames
          ? 1 : metadata.presentedFrames - lastPresentedFrames;
        lastPresentedFrames = metadata.presentedFrames;
      } else if (video.currentTime !== lastVideoTime) {
        frames++;
        lastVideoTime = video.currentTime;
      }
      countFrames();
    };
    frameHandle = video.requestVideoFrameCallback
      ? video.requestVideoFrameCallback(callback) : requestAnimationFrame(callback);
  }

  function stopCounting() {
    if (frameHandle !== null) {
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
      else cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    frames = 0;
    lastVideoTime = -1;
    lastPresentedFrames = null;
    fpsOutput.textContent = '0';
  }

  function show(text, live = false, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
    placeholder.textContent = text;
    placeholder.hidden = live;
  }

  function disconnect(session, reason) {
    if (current !== session) return;
    if (session.id) send(session, {type: 'endSession', sessionId: session.id});
    current = null;
    window.dispatchEvent(new CustomEvent('camera-metadata', {detail: null}));
    clearTimeout(session.timeout);
    clearTimeout(session.listTimer);
    clearTimeout(session.disconnectedTimer);
    if (session.peer) session.peer.close();
    session.socket.close();
    video.srcObject = null;
    if (!wantsPreview()) return;
    show(reason, false, true);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10000);
  }

  function send(session, message) {
    if (current === session && session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify(message));
    }
  }

  function applyVideoInfo(info) {
    const intrinsics = info?.intrinsics;
    const distortion = intrinsics?.distortion;
    const validDistortion = distortion === undefined
      || (Array.isArray(distortion) && (distortion.length === 0
        || (distortion.length === 5 && distortion.every(Number.isFinite))));
    const valid = info && Number.isSafeInteger(info.width) && info.width > 0
      && Number.isSafeInteger(info.height) && info.height > 0 && [0, 90, 180, 270].includes(info.rotate)
      && intrinsics && Number.isFinite(intrinsics.fx) && intrinsics.fx > 0
      && Number.isFinite(intrinsics.fy) && intrinsics.fy > 0
      && Number.isFinite(intrinsics.cx) && Number.isFinite(intrinsics.cy) && validDistortion;
    const camera = valid ? {
      width: info.width, height: info.height, rotate: info.rotate,
      fx: intrinsics.fx, fy: intrinsics.fy, cx: intrinsics.cx, cy: intrinsics.cy,
      distortion: distortion?.length ? [...distortion] : [0, 0, 0, 0, 0],
    } : null;
    window.dispatchEvent(new CustomEvent('camera-metadata', {detail: camera}));
    if (!info || ![0, 90, 180, 270].includes(info.rotate)) return;
    video.className = info.rotate ? `turn${info.rotate}` : '';
  }

  function updateAspectRatio() {
    if (!video.videoWidth || !video.videoHeight) return;
    const sideways = video.classList.contains('turn90') || video.classList.contains('turn270');
    const aspect = sideways ? video.videoHeight / video.videoWidth : video.videoWidth / video.videoHeight;
    frame.style.setProperty('--video-aspect', String(aspect));
    schedulePanelFit();
  }

  let panelFit = null;
  function schedulePanelFit() {
    if (panelFit !== null || !cameraPanel || !workspace) return;
    panelFit = requestAnimationFrame(() => {
      panelFit = null;
      if (document.body.dataset.consolePage !== 'system'
        && matchMedia('(min-width: 1100px) and (min-height: 740px)').matches) {
        workspace.style.removeProperty('--camera-column-width');
        cameraPanel.style.removeProperty('--camera-panel-width');
        return;
      }
      const viewport = frame.parentElement;
      if (!viewport.clientHeight || !video.videoWidth || !video.videoHeight) return;
      const panelStyle = getComputedStyle(cameraPanel);
      const workspaceStyle = getComputedStyle(workspace);
      const frameStyle = getComputedStyle(frame);
      const horizontalChrome = parseFloat(panelStyle.paddingLeft) + parseFloat(panelStyle.paddingRight)
        + parseFloat(panelStyle.borderLeftWidth) + parseFloat(panelStyle.borderRightWidth);
      const frameBorder = parseFloat(frameStyle.borderTopWidth) + parseFloat(frameStyle.borderBottomWidth);
      const aspect = Number(frame.style.getPropertyValue('--video-aspect'));
      const imageWidth = Math.max(0, viewport.clientHeight - frameBorder) * aspect + frameBorder;
      const compact = matchMedia('(max-width: 760px), (max-height: 650px)').matches;
      const share = Number(workspaceStyle.getPropertyValue('--camera-share'));
      const gap = parseFloat(workspaceStyle.columnGap);
      const maxWidth = compact ? cameraPanel.parentElement.clientWidth
        : Math.min((workspace.clientWidth - gap) * share / (share + 1),
          workspace.clientWidth - gap - parseFloat(workspaceStyle.getPropertyValue('--control-min')));
      const target = compact ? cameraPanel : workspace;
      const property = compact ? '--camera-panel-width' : '--camera-column-width';
      const width = Math.min(maxWidth, imageWidth + horizontalChrome);
      const previous = parseFloat(target.style.getPropertyValue(property));
      if (!Number.isFinite(previous) || Math.abs(previous - width) > .5) {
        target.style.setProperty(property, `${width}px`);
      }
    });
  }

  if (cameraPanel && workspace) {
    const panelObserver = new ResizeObserver(schedulePanelFit);
    panelObserver.observe(workspace);
    panelObserver.observe(frame.parentElement);
  }

  video.addEventListener('loadedmetadata', updateAspectRatio);
  video.addEventListener('resize', updateAspectRatio);
  new MutationObserver(updateAspectRatio).observe(video, {attributes: true, attributeFilter: ['class']});

  function startPeer(session) {
    const peer = new RTCPeerConnection({ iceServers: [] });
    session.peer = peer;
    peer.ontrack = (event) => {
      if (current !== session || event.track.kind !== 'video') return;
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      event.track.onended = () => disconnect(session, '画面已断开，正在重连');
      video.play().catch((error) => {
        console.warn('Camera playback failed:', error);
        if (current === session) show('点击画面开始播放');
      });
    };
    peer.onicecandidate = (event) => {
      if (event.candidate) send(session, {
        type: 'peer', sessionId: session.id,
        ice: { candidate: event.candidate.candidate, sdpMLineIndex: event.candidate.sdpMLineIndex },
      });
    };
    peer.onconnectionstatechange = () => {
      if (current !== session) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        disconnect(session, '图传连接中断，正在重连');
      } else if (peer.connectionState === 'disconnected') {
        clearTimeout(session.disconnectedTimer);
        session.disconnectedTimer = setTimeout(() => disconnect(session, '图传连接中断，正在重连'), 5000);
      } else if (peer.connectionState === 'connected') {
        clearTimeout(session.disconnectedTimer);
      }
    };
    peer.ondatachannel = (event) => {
      const channel = event.channel;
      if (current !== session || channel.label !== 'control') return;
      if (session.controlChannel) window.dispatchEvent(new CustomEvent('camera-metadata', {detail: null}));
      session.controlChannel = channel;
      channel.onopen = () => {
        if (current === session && session.controlChannel === channel) channel.send(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'media.video', params: {},
        }));
      };
      channel.onmessage = (message) => {
        if (current !== session || session.controlChannel !== channel) return;
        try {
          const data = JSON.parse(message.data);
          if (data.method === 'media.video') applyVideoInfo(data.params);
          else if (data.id === 1 && data.result) applyVideoInfo(data.result);
        } catch (error) {
          window.dispatchEvent(new CustomEvent('camera-metadata', {detail: null}));
          console.warn('Invalid camera metadata:', error);
        }
      };
      channel.onclose = () => {
        if (current !== session || session.controlChannel !== channel) return;
        session.controlChannel = null;
        window.dispatchEvent(new CustomEvent('camera-metadata', {detail: null}));
      };
    };
  }

  async function onSignal(session, raw) {
    const message = JSON.parse(raw);
    if (message.type === 'welcome') {
      send(session, { type: 'list' });
    } else if (message.type === 'list' && !session.starting && !session.id) {
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
      if (!session.peer) throw new Error('media peer arrived before session');
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
    if (!wantsPreview() || current) return;
    show('正在连接图传');
    const session = {
      socket: new WebSocket(endpoint.href), peer: null, id: null, starting: false,
      pendingIce: [], queue: Promise.resolve(), timeout: null, listTimer: null, disconnectedTimer: null,
    };
    current = session;
    session.timeout = setTimeout(() => disconnect(session, '图传超时，正在重连'), 20000);
    session.socket.onmessage = (event) => {
      session.queue = session.queue.then(() => {
        if (current === session) return onSignal(session, event.data);
      }).catch((error) => {
        console.error('Camera signalling failed:', error);
        disconnect(session, '图传协商失败，正在重连');
      });
    };
    session.socket.onclose = () => disconnect(session, '图传未连接，正在重试');
    session.socket.onerror = () => session.socket.close();
  }

  video.addEventListener('playing', () => {
    countFrames();
    if (!current) return;
    clearTimeout(current.timeout);
    retryDelay = 1000;
    show('', true);
  });
  video.addEventListener('pause', stopCounting);
  video.addEventListener('emptied', stopCounting);
  document.querySelector('.camera-frame').addEventListener('click', () => {
    if (video.srcObject) video.play().catch((error) => console.warn('Camera playback failed:', error));
  });
  function updatePreview() {
    clearTimeout(retryTimer);
    if (wantsPreview()) {
      retryDelay = 1000;
      connect();
      return;
    }
    if (current) disconnect(current, '图传已暂停');
    stopCounting();
    show('');
  }
  window.addEventListener('console-page-changed', updatePreview);
  const enablePreview = () => { previewEnabled = true; updatePreview(); };
  const disablePreview = () => { previewEnabled = false; updatePreview(); };
  window.addEventListener('studio-preview', enablePreview);
  window.addEventListener('studio-enter', enablePreview);
  window.addEventListener('studio-leave', disablePreview);
  window.addEventListener('studio-disconnect', disablePreview);
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearInterval(fpsTimer);
    stopCounting();
    clearTimeout(retryTimer);
    if (current) disconnect(current, '图传已关闭');
  });
  updatePreview();
})();
