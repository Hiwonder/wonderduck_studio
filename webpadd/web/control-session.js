export function createControlSession({ onMessage, onClose, onPulse }) {
  let socket = null;
  let reconnectTimer = null;
  let inputTimer = null;
  let active = false;

  function startInput() {
    if (active && inputTimer === null && socket?.readyState === WebSocket.OPEN) {
      inputTimer = setInterval(onPulse, 40);
    }
  }

  function stopInput() {
    clearInterval(inputTimer);
    inputTimer = null;
  }

  function connect() {
    if (!active || socket) return;
    const url = new URL('/control?client=web', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(url);
    socket = connection;

    connection.addEventListener('open', startInput);
    connection.addEventListener('message', event => {
      if (socket !== connection) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message && typeof message.type === 'string') onMessage(message);
    });
    connection.addEventListener('error', () => connection.close());
    connection.addEventListener('close', () => {
      if (socket !== connection) return;
      socket = null;
      stopInput();
      if (active) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 1000);
      }
      onClose();
    });
  }

  function pause() {
    active = false;
    stopInput();
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  return {
    get open() { return socket?.readyState === WebSocket.OPEN; },
    get backpressured() { return (socket?.bufferedAmount || 0) > 0; },
    start() {
      active = true;
      if (reconnectTimer === null) connect();
      startInput();
    },
    pause,
    close() {
      pause();
      socket?.close();
    },
    send(message) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
  };
}
