import { WebSocketServer } from 'ws';

// The /node-ws line: a customer's NLC Node dials out to this server. Copied in shape from
// browser-control-websocket.js (challenge, sign-in within 10 s, one live socket per computer,
// send guard, keepalive ack, close handling) and keyed by machine id.

const NODE_FRAME_TYPES = /^\{"type":"(keepalive-ack|node-update-notice|node-auth-challenge|node-auth-ok|node-auth-error|node-replaced|cmd)"/;

// server.js-style broadcast frames must never reach a Node; after sign-in only the Node's own
// protocol frames pass through ws.send.
function installNodeSendGuard(ws) {
  if (typeof ws.sendCommandFrame === 'function') return;
  const rawSend = ws.send.bind(ws);
  ws.sendCommandFrame = rawSend;
  ws.send = (data, ...rest) => {
    if (typeof data === 'string' && NODE_FRAME_TYPES.test(data)) return rawSend(data, ...rest);
    const done = rest.find((item) => typeof item === 'function');
    if (done) done();
    return undefined;
  };
}

const AUTH_FAILED_MESSAGE = 'This computer is not paired any more. Ask your assistant for a new code.';

export function createNodeWebSocketHandler({
  backend,
  authTimeoutMs = 10_000,
  idleMs = 60_000,
  maxPayload = 16 * 1024 * 1024,
  updateNotice = null,
} = {}) {
  if (!backend) throw new Error('The Node connection handler needs its backend.');
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const idleTimers = new Set();

  function refuse(ws, message) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'node-auth-error', message })); } catch { /* closing */ }
    try { ws.close(4002, 'sign-in refused'); } catch { /* closing */ }
  }

  function onConnection(ws) {
    const authTimer = setTimeout(() => refuse(ws, 'Sign-in took too long. Try again.'), authTimeoutMs);
    ws.once('close', () => clearTimeout(authTimer));
    ws.on('error', () => {});

    ws.once('message', (raw) => {
      clearTimeout(authTimer);
      let data;
      try { data = JSON.parse(String(raw)); } catch { return refuse(ws, AUTH_FAILED_MESSAGE); }
      if (data?.type !== 'node-auth' || !data.token || !data.machineId) return refuse(ws, AUTH_FAILED_MESSAGE);
      const machine = backend.authenticate(data.machineId, data.token);
      if (!machine) return refuse(ws, AUTH_FAILED_MESSAGE);

      const machineId = machine.machineId;
      let lastInbound = Date.now();
      const idle = setInterval(() => {
        if (Date.now() - lastInbound > idleMs) ws.terminate();
      }, Math.max(50, Math.min(15_000, Math.floor(idleMs / 4))));
      idle.unref?.();
      idleTimers.add(idle);

      ws.send(JSON.stringify({ type: 'node-auth-ok', machineId }));
      installNodeSendGuard(ws);
      backend.attach(machineId, ws, { version: data.version, tools: data.tools });
      // A computer that signed in is told when a different published build of its own payload is on offer.
      if (typeof updateNotice === 'function') {
        Promise.resolve(updateNotice({ platform: data.platform, arch: data.arch, build: data.build, version: data.version }))
          .then((notice) => { if (notice && ws.readyState === 1) ws.send(JSON.stringify({ type: 'node-update-notice', notice })); })
          .catch(() => {});
      }

      ws.on('message', (frame) => {
        lastInbound = Date.now();
        backend.touch(machineId);
        let message;
        try { message = JSON.parse(String(frame)); } catch { return; }
        if (message?.type === 'keepalive') {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'keepalive-ack', sentAt: message.sentAt || null }));
        } else if (message?.type === 'res') {
          backend.handleResponse(machineId, message);
        } else if (message?.type === 'node-state') {
          backend.applyState(machineId, message);
        }
      });

      ws.on('close', () => {
        clearInterval(idle);
        idleTimers.delete(idle);
        backend.detach(machineId, ws);
      });
    });

    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'node-auth-challenge' }));
  }

  return {
    handleUpgrade(request, socket, head) {
      wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws));
    },
    close() {
      for (const t of idleTimers) clearInterval(t);
      idleTimers.clear();
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
