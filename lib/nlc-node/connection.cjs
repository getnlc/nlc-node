'use strict';
// Piece G: the Node's outbound connection to the customer's NLC server (CONTRACT 1.1).
// Pair with a one-time code, keep one authenticated WebSocket alive, run commands through the dispatcher.
// No inbound ports. The machine token is only ever kept in the OS user store and never logged.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureStateRoot } = require('./local-state.cjs');

const BAD_CODE_MESSAGE = 'That code did not work. Ask your assistant for a new one.';
const NETWORK_MESSAGE = 'Could not reach NLC. Check your internet connection and try again.';
const BUSY_MESSAGE = 'Something went wrong on this computer. Try again.';
const AUTH_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 15000;
const WAKE_GAP_MS = 15000;
const KEEPALIVE_MS = 20000;
const ACK_TIMEOUT_MS = 12000;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 5000;
const JITTER_MS = 250;
const HOLD_MS = 15000;
const REFRESH_BEFORE_MS = 24 * 3600 * 1000;
const REFRESH_RETRY_MS = 5 * 60 * 1000;
const MAX_TIMER_MS = 2147483647;
const TOKEN_FILENAME = 'node-token.bin';

// Sealed machine-token file in the Node state folder (DPAPI / Keychain protector from platform-adapters).
function createTokenStore({ stateRoot, protector } = {}) {
  if (!protector || typeof protector.protect !== 'function' || typeof protector.unprotect !== 'function') {
    throw new TypeError('credential protector is required');
  }
  const destination = path.join(ensureStateRoot(stateRoot), TOKEN_FILENAME);
  return Object.freeze({
    path: destination,
    async save(value) {
      const record = { machineId: String(value.machineId), token: String(value.token), expiresAt: String(value.expiresAt) };
      const sealed = Buffer.from(await protector.protect(Buffer.from(JSON.stringify(record), 'utf8')));
      if (!sealed.length) throw new Error('credential_protection_failed');
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, sealed, { mode: 0o600 });
      fs.renameSync(temporary, destination);
    },
    async load() {
      let sealed;
      try { sealed = fs.readFileSync(destination); } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
      try {
        const record = JSON.parse(Buffer.from(await protector.unprotect(sealed)).toString('utf8'));
        return record && record.token && record.machineId ? record : null;
      } catch { return null; }
    },
    async clear() {
      try { fs.unlinkSync(destination); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      if (typeof protector.clear === 'function') await protector.clear();
    },
  });
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function createConnection({
  origin, tokenStore, dispatcher, machineName = os.hostname(), os: osName = process.platform, version = '0.0.0',
  setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(), random = Math.random,
  WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch, events = null, keepaliveMs = KEEPALIVE_MS, onStatus = () => {}, log = () => {},
  stateProvider = null, autoRequest = false, askEveryMs = 3000, askRetryMs = 15000,
  arch = process.arch, buildProvider = () => '', onUpdateNotice = null,
} = {}) {
  if (!origin) throw new TypeError('origin is required');
  if (!tokenStore) throw new TypeError('tokenStore is required');
  if (!dispatcher || typeof dispatcher.handle !== 'function') throw new TypeError('dispatcher is required');
  const base = String(origin).replace(/\/+$/, '');
  const wsUrl = base.replace(/^http/i, 'ws') + '/node-ws';

  let status = 'unpaired';
  let cred = null;
  let ws = null;
  let gen = 0;
  let stopped = true;
  let attempt = 0;
  let authed = false;
  const timers = { reconnect: null, auth: null, keepalive: null, ack: null, refresh: null, ask: null };
  let lastKeepaliveAt = 0;
  let asking = null; // { requestId, secret } while this computer waits for the owner's Allow
  const held = new Map();

  const clearT = (name) => { if (timers[name] != null) { clearTimer(timers[name]); timers[name] = null; } };
  const setStatus = (next) => {
    if (status === next) return;
    status = next;
    log('status: ' + next);
    try { onStatus(next); } catch { /* a UI listener must not break the link */ }
  };

  async function post(route, body, bearer) {
    const headers = { 'content-type': 'application/json' };
    if (bearer) headers.authorization = 'Bearer ' + bearer;
    return fetchImpl(base + route, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  }

  function send(obj) {
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function dropSocket() {
    gen += 1;
    authed = false;
    clearT('auth'); clearT('keepalive'); clearT('ack');
    const old = ws; ws = null;
    if (old) { old.onopen = old.onmessage = old.onclose = old.onerror = null; try { old.close(); } catch { /* already closed */ } }
  }

  function goOffline() {
    dropSocket();
    if (stopped || status === 'disconnected') return;
    setStatus('offline');
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (stopped || !cred) return;
    clearT('reconnect');
    const delay = Math.min(BACKOFF_START_MS * (2 ** attempt), BACKOFF_CAP_MS) + Math.floor(random() * JITTER_MS);
    attempt += 1;
    timers.reconnect = setTimer(() => { timers.reconnect = null; connect(); }, delay);
  }

  // Tell the server which folders are shared and whether file access is paused (the dashboard shows it).
  function publishState() {
    if (!authed || !ws || typeof stateProvider !== 'function') return false;
    let snapshot;
    try { snapshot = stateProvider() || {}; } catch { return false; }
    const folders = Array.isArray(snapshot.folders) ? snapshot.folders.map((f) => ({ label: String(f.label), path: String(f.path) })) : [];
    return send({ type: 'node-state', paused: !!snapshot.paused, folders });
  }

  // Another copy of NLC Node signed in with the same pairing and took the line: stand down, do not fight for it.
  function replaced() {
    dropSocket();
    clearT('reconnect');
    stopped = true;
    setStatus('replaced');
  }

  function revoked() {
    dropSocket();
    clearT('reconnect'); clearT('refresh');
    cred = null;
    tokenStore.clear().catch(() => {});
    setStatus('disconnected');
    // The NLC refused this computer (or its record is gone): ask again by itself, so the owner's Allow is the only step.
    if (autoRequest) requestLink().catch(() => {});
  }

  function scheduleKeepalive() {
    clearT('keepalive');
    lastKeepaliveAt = now();
    timers.keepalive = setTimer(() => { timers.keepalive = null; keepaliveTick(); }, keepaliveMs);
  }
  // Sleep is invisible to a running program except as a jump in the clock: a keepalive that fires far later than it was
  // due means the computer slept. The old socket is dead even if it does not know it, so drop it and connect again now
  // instead of waiting for the next keepalive to fail.
  function keepaliveTick() {
    if (!authed || !ws) return;
    if (now() - lastKeepaliveAt >= keepaliveMs + WAKE_GAP_MS) { log('computer woke up'); attempt = 0; connect(); return; }
    sendKeepalive();
    scheduleKeepalive();
  }
  function sendKeepalive() {
    if (!authed || !ws) return;
    send({ type: 'keepalive' });
    if (timers.ack == null) timers.ack = setTimer(() => { timers.ack = null; log('link stopped answering'); goOffline(); }, ACK_TIMEOUT_MS);
  }

  function connect() {
    if (stopped || !cred) return;
    clearT('reconnect');
    dropSocket();
    const myGen = gen;
    let socket;
    try { socket = new WebSocketImpl(wsUrl); } catch { goOffline(); return; }
    ws = socket;
    // A connect that never answers (a network that changed under us, a half-open link after sleep) must not wait forever.
    timers.auth = setTimer(() => { timers.auth = null; if (gen === myGen && !authed) { log('connect did not finish'); goOffline(); } }, CONNECT_TIMEOUT_MS);
    socket.onopen = () => {
      if (gen !== myGen) return;
      clearT('auth');
      timers.auth = setTimer(() => { timers.auth = null; if (gen === myGen && !authed) { log('server did not finish the handshake'); goOffline(); } }, AUTH_TIMEOUT_MS);
    };
    socket.onmessage = (event) => { if (gen === myGen) onMessage(event.data); };
    // Node's built-in WebSocket reports a refused or dropped handshake as an error only (no close event).
    socket.onerror = () => { if (gen === myGen) goOffline(); };
    socket.onclose = () => { if (gen === myGen) goOffline(); };
  }

  let sentToken = '';
  function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'node-auth-challenge':
        if (cred) sentToken = cred.token;
        if (cred) send({ type: 'node-auth', token: cred.token, machineId: cred.machineId, version, platform: osName, arch, build: buildProvider() });
        break;
      case 'node-auth-ok':
        authed = true; attempt = 0;
        clearT('auth');
        setStatus('connected');
        publishState();
        scheduleKeepalive();
        flushHeld();
        break;
      case 'node-auth-error':
        log('server did not accept this computer');
        // The token rotates every few minutes. A handshake that carried the previous token (wake from sleep, a second copy)
        // is not a revocation: take the newest saved token and sign in again. Only a refused newest token ends the pairing.
        tokenStore.load().then((saved) => {
          if (saved && saved.token !== sentToken) { cred = saved; attempt = 0; connect(); } else revoked();
        }).catch(() => revoked());
        break;
      case 'node-replaced':
        log('another copy of NLC Node took over');
        replaced();
        break;
      case 'keepalive':
        send({ type: 'keepalive-ack' });
        break;
      case 'keepalive-ack':
        clearT('ack');
        break;
      case 'cmd':
        runCommand(msg);
        break;
      case 'node-update-notice':
        // The server says a different published build of this computer's payload exists; the updater decides what to do.
        if (typeof onUpdateNotice === 'function') { try { onUpdateNotice(msg.notice); } catch { /* an updater fault must not break the link */ } }
        break;
      default:
        break; // anything newer is ignored
    }
  }

  function runCommand(msg) {
    const id = msg.id;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    if (typeof msg.tool !== 'string') {
      reply({ type: 'res', id, ok: false, error: { code: 'BAD_ARGUMENT', message: 'That request had no tool name.' } });
      return;
    }
    const machineId = cred && cred.machineId;
    Promise.resolve()
      .then(() => dispatcher.handle(msg.tool, msg.args || {}, { machineId, requestId: id }))
      .catch(() => ({ ok: false, error: { code: 'BUSY', message: BUSY_MESSAGE } }))
      .then((out) => {
        if (out && out.ok) reply({ type: 'res', id, ok: true, result: out.result });
        else reply({ type: 'res', id, ok: false, error: (out && out.error) || { code: 'BUSY', message: BUSY_MESSAGE } });
      });
  }

  function reply(message) {
    if (authed && ws && send(message)) return;
    const key = String(message.id);
    const timer = setTimer(() => held.delete(key), HOLD_MS);
    const previous = held.get(key);
    if (previous) clearTimer(previous.timer);
    held.set(key, { message, timer });
  }
  function flushHeld() {
    for (const [key, entry] of [...held]) {
      clearTimer(entry.timer);
      held.delete(key);
      if (!(authed && ws && send(entry.message))) { reply(entry.message); break; }
    }
  }

  function scheduleRefresh() {
    clearT('refresh');
    if (!cred || stopped) return;
    const wait = Math.min(Math.max(0, Date.parse(cred.expiresAt) - REFRESH_BEFORE_MS - now()), MAX_TIMER_MS);
    timers.refresh = setTimer(() => { timers.refresh = null; refreshNow(); }, Number.isFinite(wait) ? wait : REFRESH_RETRY_MS);
  }
  async function refreshNow() {
    if (!cred) return;
    const mine = cred;
    try {
      const res = await post('/api/node/refresh', { machineId: mine.machineId, token: mine.token }, mine.token);
      if (res.status >= 500) throw new Error('server');
      if (!res.ok) return; // refused: the next login will say so and the customer pairs again
      const data = await res.json();
      if (!data || !data.token || cred !== mine) return;
      cred = { machineId: mine.machineId, token: data.token, expiresAt: data.expiresAt };
      await tokenStore.save(cred);
      scheduleRefresh();
    } catch {
      if (!stopped && cred === mine) timers.refresh = setTimer(() => { timers.refresh = null; refreshNow(); }, REFRESH_RETRY_MS);
    }
  }

  async function pair(code) {
    const clean = normalizeCode(code);
    let res;
    try {
      res = await post('/api/node/pair/exchange', { code: clean, machineName, os: osName, version });
    } catch { throw Object.assign(new Error(NETWORK_MESSAGE), { code: 'OFFLINE' }); }
    if (res.status === 429) throw Object.assign(new Error('Too many tries. Wait a minute and try again.'), { code: 'RATE_LIMIT' });
    if (res.status >= 500) throw Object.assign(new Error(NETWORK_MESSAGE), { code: 'OFFLINE' });
    let data = null;
    try { data = await res.json(); } catch { /* handled below */ }
    if (!res.ok || !data || !data.token || !data.machineId) throw new Error(BAD_CODE_MESSAGE);
    dropSocket();
    cred = { machineId: data.machineId, token: data.token, expiresAt: data.expiresAt };
    await tokenStore.save(cred);
    stopped = false; attempt = 0;
    setStatus('connecting');
    scheduleRefresh();
    connect();
    return { machineId: cred.machineId };
  }

  // No code: ask the NLC named in the download to link this computer. The NLC keeps the request as a pending
  // computer; the owner presses Allow in NLC Central; the answer (credentials, once) comes back here.
  async function requestLink() {
    if (cred || asking) return { state: asking ? 'asking' : 'linked' };
    clearT('ask');
    stopped = false;
    // After a refusal the window already says Disconnected (with its Allow hint): ask in the background, show nothing new.
    const quiet = status === 'disconnected';
    let res;
    try { res = await post('/api/node/pair/request', { machineName, os: osName, version }); } catch { if (!quiet) setStatus('unpaired'); retryAsk(); return { state: 'offline' }; }
    let data = null;
    try { data = await res.json(); } catch { /* handled below */ }
    if (!res.ok || !data || !data.requestId || !data.secret) { if (!quiet) setStatus('unpaired'); retryAsk(); return { state: 'refused' }; }
    asking = { requestId: data.requestId, secret: data.secret };
    if (!quiet) setStatus('asking');
    scheduleAsk();
    return { state: 'asking' };
  }
  // An NLC that did not answer is asked again on its own, so a computer opened while its NLC was briefly unreachable still links.
  function retryAsk() {
    if (!autoRequest || stopped || cred || asking) return;
    clearT('ask');
    timers.ask = setTimer(() => { timers.ask = null; if (!stopped && !cred && !asking) requestLink().catch(() => {}); }, askRetryMs);
  }
  function scheduleAsk() {
    clearT('ask');
    if (!asking || stopped) return;
    timers.ask = setTimer(() => { timers.ask = null; pollAsk(); }, askEveryMs);
  }
  async function pollAsk() {
    const mine = asking;
    if (!mine) return;
    let data = null;
    try {
      const res = await post('/api/node/pair/request/status', mine);
      if (res.status >= 500 || res.status === 429) throw new Error('server');
      data = await res.json();
    } catch { if (asking === mine) scheduleAsk(); return; }
    if (asking !== mine) return;
    const state = data && data.state;
    if (state === 'pending') { scheduleAsk(); return; }
    asking = null;
    if (state === 'allowed' && data.token && data.machineId) {
      dropSocket();
      cred = { machineId: data.machineId, token: data.token, expiresAt: data.expiresAt };
      await tokenStore.save(cred);
      stopped = false; attempt = 0;
      setStatus('connecting');
      scheduleRefresh();
      connect();
      return;
    }
    setStatus(state === 'denied' ? 'denied' : 'expired');
  }

  async function start() {
    stopped = false;
    if (!cred) cred = await tokenStore.load();
    if (!cred) { setStatus('unpaired'); if (autoRequest) await requestLink(); return; }
    attempt = 0;
    if (status === 'unpaired' || status === 'disconnected') setStatus('connecting');
    scheduleRefresh();
    connect();
  }

  async function stop() {
    stopped = true;
    asking = null;
    for (const name of Object.keys(timers)) clearT(name);
    for (const entry of held.values()) clearTimer(entry.timer);
    held.clear();
    dropSocket();
    if (status !== 'disconnected' && status !== 'unpaired') setStatus('offline');
  }

  async function disconnect() {
    const mine = cred || await tokenStore.load();
    if (mine) { try { await post('/api/node/disconnect', { machineId: mine.machineId, token: mine.token }, mine.token); } catch { /* the server also drops it when the token expires */ } }
    stopped = true;
    for (const name of Object.keys(timers)) clearT(name);
    dropSocket();
    cred = null;
    await tokenStore.clear();
    setStatus('disconnected');
  }

  function nudge() {
    if (stopped || !cred) return;
    if (status === 'offline' || status === 'connecting') { attempt = 0; connect(); } else if (authed) sendKeepalive();
  }
  if (events && typeof events.on === 'function') { events.on('online', nudge); events.on('wake', nudge); }

  return Object.freeze({
    pair, requestLink, start, stop, disconnect, publishState,
    status: () => status,
    diagnostics: () => ({ status, machineId: cred ? cred.machineId : null, origin: base, heldAnswers: held.size }),
  });
}

module.exports = { createConnection, createTokenStore, BAD_CODE_MESSAGE, NETWORK_MESSAGE };
