import { createHash, randomBytes as systemRandomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// NLC Node, customer-VPS side. Holds the paired computers (one entry per machineId), the one-time
// pairing codes, the live socket per computer, and the command broker the gateway server calls.
// Shaped on extension-backend.js (pending map, timeouts, hold-for-reconnect), keyed by machine.

export const NODE_ERROR_CODES = Object.freeze([
  'NOT_GRANTED', 'OUTSIDE_GRANT', 'PAUSED', 'NOT_FOUND', 'EXISTS', 'TOO_LARGE', 'NOT_TEXT',
  'NO_MATCH', 'AMBIGUOUS', 'BUSY', 'FFMPEG_FAILED', 'FFMPEG_MISSING', 'BAD_ARGUMENT', 'OFFLINE',
]);

// Tools an agent may ask for through the agent routes. set_paused is deliberately absent:
// only the customer, from the dashboard or the Node window, changes the pause switch.
export const NODE_AGENT_TOOLS = Object.freeze([
  'list', 'stat', 'search', 'read_text', 'write_text', 'edit', 'make_folder', 'rename', 'move', 'copy',
  'delete', 'trash_list', 'trash_restore', 'log_recent',
  'media_info', 'video_trim', 'video_join', 'video_captions', 'video_proxy', 'video_frames', 'audio_mux', 'video_smooth', 'video_check',
  'captions_from_audio', 'captions_status', 'captions_cancel',
  'job_status', 'job_cancel',
]);

const VIDEO_TOOLS = new Set(['media_info', 'video_trim', 'video_join', 'video_captions', 'video_proxy', 'video_frames', 'audio_mux', 'video_smooth', 'video_check']);
export const DEFAULT_TIMEOUT_MS = 30_000;
export const VIDEO_TIMEOUT_MS = 10 * 60_000;
export const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const CODE_LIFETIME_MS = 10 * 60 * 1000;
export const REQUEST_LIFETIME_MS = 10 * 60 * 1000;
const REQUEST_KEEP_MS = 2 * 60 * 1000;
const MAX_PENDING_REQUESTS = 20;
export const OFFLINE_MESSAGE = 'That computer is not connected: NLC Node is not running on it. The pairing and shared folders are still saved. Lead the customer in plain words, no terminal. Windows: open the Start menu, type NLC Node and press Enter; if that finds nothing, open File Explorer, paste %LOCALAPPDATA%\\Programs\\NLC Node in the address bar, press Enter and double-click NLC Node (not NLC Node Host); signing out of Windows and back in also starts it. Mac: Finder, Applications, NLC Node. The NLC Node window says Connected within about 20 seconds. Then try again. If NLC Node cannot be found, call pairing_code and give them the link to install it again.';
export const BAD_CODE_MESSAGE = 'That code did not work. Ask your assistant for a new one.';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // A-Z0-9 without 0, O, 1, I (32 symbols)
const SUPPORTED_OS = new Set(['win32', 'darwin']);

export class NodeCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeCommandError';
    this.code = code;
  }
}

export class NodePairingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NodePairingError';
    this.code = 'BAD_CODE';
  }
}

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function normalizeNodeOs(value) {
  const text = String(value || '').trim().toLowerCase();
  if (/^(win|windows)/.test(text)) return 'win32';
  if (/^(darwin|mac|osx)/.test(text)) return 'darwin';
  return null;
}

export function normalizePairingCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function createNodeBackend({
  dataFile,
  now = Date.now,
  randomBytes = systemRandomBytes,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  videoTimeoutMs = VIDEO_TIMEOUT_MS,
  holdMs = 15_000,
} = {}) {
  if (!dataFile) throw new Error('NLC Node needs a file to keep paired computers in.');

  const machines = new Map();      // machineId -> stored record
  const codes = new Map();         // code -> { ownerId, expiresAt }
  const requests = new Map();      // requestId -> a computer asking to link, waiting for the owner's Allow
  const connections = new Map();   // machineId -> { ws, version }
  const liveInfo = new Map();      // machineId -> { lastSeen }
  const droppedAt = new Map();     // machineId -> wall-clock ms of last disconnect (or server start)
  const pending = new Map();       // requestId -> pending command
  const bootAt = Date.now();

  function load() {
    try {
      if (!existsSync(dataFile)) return;
      const parsed = JSON.parse(readFileSync(dataFile, 'utf8'));
      for (const [id, rec] of Object.entries(parsed?.machines || {})) {
        if (rec && rec.tokenHash && rec.expiresAt > now()) machines.set(id, rec);
      }
      for (const [id, rec] of Object.entries(parsed?.requests || {})) {
        if (rec && rec.secretHash && rec.expiresAt > now()) requests.set(id, rec);
      }
    } catch {
      // A damaged file must not stop pairing; computers simply pair again.
    }
  }

  function persist() {
    const body = JSON.stringify({ version: 1, machines: Object.fromEntries(machines), requests: Object.fromEntries(requests) });
    mkdirSync(dirname(dataFile), { recursive: true });
    const tmp = `${dataFile}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, dataFile);
    try { chmodSync(dataFile, 0o600); } catch { /* not supported on this OS */ }
  }

  load();
  for (const id of machines.keys()) droppedAt.set(id, bootAt);

  function purgeCodes() {
    for (const [code, entry] of codes) if (entry.expiresAt <= now()) codes.delete(code);
  }

  // The signed-in customer most recently seen on the dashboard. One customer per VPS: a code the agent asks for
  // belongs to whoever opens the dashboard, so it is listed for them and the computer it pairs becomes theirs.
  let knownOwner = null;

  // `shared` codes are the ones the agent asks for (nobody signed in at that moment).
  function createPairingCode(ownerId, { shared = false } = {}) {
    purgeCodes();
    if (!shared && ownerId) knownOwner = ownerId;
    const holder = shared ? '*' : ownerId;
    let ownerCodes = [...codes.entries()].filter(([, e]) => e.ownerId === holder);
    while (ownerCodes.length >= 20) { codes.delete(ownerCodes.shift()[0]); }
    let code;
    do {
      const bytes = randomBytes(8);
      code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    } while (codes.has(code));
    const expiresAt = now() + CODE_LIFETIME_MS;
    codes.set(code, { ownerId: holder || 'owner', expiresAt });
    return { code, expiresAt };
  }

  // The newest unused, unexpired code this customer asked for (the dashboard shows it), or null.
  function activePairing(ownerId) {
    purgeCodes();
    if (ownerId) knownOwner = ownerId;
    let best = null;
    for (const [code, entry] of codes) {
      if (entry.ownerId !== (ownerId || 'owner') && entry.ownerId !== '*') continue;
      if (!best || entry.expiresAt > best.expiresAt) best = { active: true, code, expiresAt: entry.expiresAt };
    }
    return best;
  }

  function issueToken() {
    return randomBytes(32).toString('hex');
  }

  function exchangeCode({ code, machineName, os, version } = {}) {
    purgeCodes();
    const key = normalizePairingCode(code);
    const entry = key.length === 8 ? codes.get(key) : null;
    if (!entry) throw new NodePairingError(BAD_CODE_MESSAGE);
    const normalizedOs = normalizeNodeOs(os);
    if (!normalizedOs || !SUPPORTED_OS.has(normalizedOs)) {
      throw new NodePairingError('NLC Node works on Windows and Mac computers.');
    }
    codes.delete(key); // single use
    const machineId = randomUUID();
    const token = issueToken();
    const expiresAt = now() + TOKEN_LIFETIME_MS;
    machines.set(machineId, {
      machineId,
      ownerId: entry.ownerId === '*' ? (knownOwner || 'owner') : entry.ownerId,
      name: String(machineName || '').trim().slice(0, 80) || 'My computer',
      os: normalizedOs,
      version: String(version || '').slice(0, 40),
      tokenHash: sha256(token),
      createdAt: now(),
      expiresAt,
      paused: false,
      folders: [],
    });
    persist();
    return { machineId, token, expiresAt };
  }

  function authenticate(machineId, token) {
    const rec = machines.get(String(machineId || ''));
    if (!rec || !token || rec.expiresAt <= now()) return null;
    return sameHash(rec.tokenHash, sha256(token)) ? rec : null;
  }

  function authenticateToken(token) {
    if (!token) return null;
    const hash = sha256(token);
    for (const rec of machines.values()) {
      if (rec.expiresAt > now() && sameHash(rec.tokenHash, hash)) return rec;
    }
    return null;
  }

  function refreshToken(oldToken) {
    const rec = authenticateToken(oldToken);
    if (!rec) return null;
    const token = issueToken();
    rec.tokenHash = sha256(token);
    rec.expiresAt = now() + TOKEN_LIFETIME_MS;
    persist();
    return { machineId: rec.machineId, token, expiresAt: rec.expiresAt };
  }

  function failPending(machineId, error) {
    for (const [id, p] of pending) {
      if (p.machineId !== machineId) continue;
      clearTimeout(p.timer); clearTimeout(p.heldTimer);
      pending.delete(id);
      p.reject(error);
    }
  }

  function removeMachine(machineId) {
    const rec = machines.get(machineId);
    if (!rec) return false;
    machines.delete(machineId);
    persist();
    const conn = connections.get(machineId);
    connections.delete(machineId);
    droppedAt.delete(machineId);
    failPending(machineId, new NodeCommandError('OFFLINE', OFFLINE_MESSAGE));
    if (conn?.ws && conn.ws.readyState <= 1) conn.ws.close(4001, 'removed');
    return true;
  }

  function sendFrame(p) {
    const conn = connections.get(p.machineId);
    if (!conn || conn.ws.readyState !== 1) return false;
    clearTimeout(p.heldTimer); p.heldTimer = null;
    try { conn.ws.send(p.frame); p.sent = true; return true; } catch { return false; }
  }

  function holdPending(p) {
    p.sent = false;
    clearTimeout(p.heldTimer);
    p.heldTimer = setTimeout(() => {
      if (!pending.delete(p.id)) return;
      clearTimeout(p.timer);
      p.reject(new NodeCommandError('OFFLINE', OFFLINE_MESSAGE));
    }, holdMs);
  }

  // A new authenticated socket for a machine replaces the old one; commands that were waiting or
  // in flight are sent again on the new line (the Node de-duplicates by command id).
  function attach(machineId, ws, { version } = {}) {
    const rec = machines.get(machineId);
    if (!rec) return false;
    const previous = connections.get(machineId);
    connections.set(machineId, { ws, version });
    liveInfo.set(machineId, { lastSeen: Date.now() });
    rec.lastSeen = Date.now();
    if (version) rec.version = String(version).slice(0, 40);
    if (previous && previous.ws !== ws && previous.ws.readyState <= 1) {
      // Tell the old copy why, so it stands down instead of fighting for the line.
      try { previous.ws.send(JSON.stringify({ type: 'node-replaced' })); } catch { /* already closing */ }
      previous.ws.close(4000, 'replaced');
    }
    for (const p of pending.values()) if (p.machineId === machineId) sendFrame(p);
    return true;
  }

  function detach(machineId, ws) {
    const conn = connections.get(machineId);
    if (!conn || conn.ws !== ws) return; // a replaced socket closing is not a disconnect
    connections.delete(machineId);
    droppedAt.set(machineId, Date.now());
    { const rec = machines.get(machineId); if (rec) { rec.lastSeen = Date.now(); persist(); } }
    for (const p of pending.values()) if (p.machineId === machineId) holdPending(p);
  }

  function touch(machineId) {
    const info = liveInfo.get(machineId);
    if (info) info.lastSeen = Date.now();
  }

  function applyState(machineId, state = {}) {
    const rec = machines.get(machineId);
    if (!rec) return;
    if (typeof state.paused === 'boolean') rec.paused = state.paused;
    if (Array.isArray(state.folders)) {
      rec.folders = state.folders
        .filter((f) => f && typeof f.label === 'string')
        .slice(0, 50)
        .map((f) => ({ label: f.label.slice(0, 120), path: String(f.path || '').slice(0, 1000) }));
    }
    persist();
  }

  function mapNodeError(error) {
    if (error && NODE_ERROR_CODES.includes(error.code) && typeof error.message === 'string' && error.message) {
      return new NodeCommandError(error.code, error.message.slice(0, 4000));
    }
    return new NodeCommandError('BUSY', 'The computer could not finish that. Try again in a moment.');
  }

  function handleResponse(machineId, message) {
    const p = pending.get(message?.id);
    if (!p || p.machineId !== machineId) return;
    pending.delete(p.id);
    clearTimeout(p.timer); clearTimeout(p.heldTimer);
    if (message.ok === true) p.resolve(message.result);
    else p.reject(mapNodeError(message.error));
  }

  function sendCommand(machineId, tool, args = {}, { timeoutMs } = {}) {
    const rec = machines.get(machineId);
    const offline = () => new NodeCommandError('OFFLINE', OFFLINE_MESSAGE);
    if (!rec) return Promise.reject(offline());
    const connected = connections.has(machineId);
    const recentlyDropped = Date.now() - (droppedAt.get(machineId) ?? 0) < holdMs;
    if (!connected && !recentlyDropped) return Promise.reject(offline());
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : (VIDEO_TOOLS.has(tool) ? videoTimeoutMs : defaultTimeoutMs);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const p = {
        id, machineId, resolve, reject, sent: false, heldTimer: null,
        frame: JSON.stringify({ type: 'cmd', id, tool, args: args ?? {} }),
        timer: setTimeout(() => {
          if (!pending.delete(id)) return;
          clearTimeout(p.heldTimer);
          reject(new NodeCommandError('BUSY', 'The computer did not answer in time. Try again in a moment.'));
        }, limit),
      };
      pending.set(id, p);
      if (!sendFrame(p)) holdPending(p);
    });
  }

  async function setPaused(machineId, paused) {
    const result = await sendCommand(machineId, 'set_paused', { paused: !!paused }, { timeoutMs: 10_000 });
    applyState(machineId, { paused: typeof result?.paused === 'boolean' ? result.paused : !!paused });
    return { paused: machines.get(machineId)?.paused ?? !!paused };
  }

  function view(rec) {
    return {
      machineId: rec.machineId,
      name: rec.name,
      os: rec.os,
      version: rec.version || '',
      connected: connections.has(rec.machineId),
      paused: !!rec.paused,
      folders: (rec.folders || []).map((f) => ({ label: f.label, path: f.path })),
      lastSeen: liveInfo.get(rec.machineId)?.lastSeen || rec.lastSeen || null,
    };
  }

  function listMachines(ownerId) {
    return [...machines.values()]
      .filter((rec) => ownerId === undefined || ownerId === null || rec.ownerId === ownerId)
      .map(view);
  }


  // ---- A computer asks to link; the owner presses Allow in NLC Central (no code is typed or pasted) ----
  // The request lives here, on the server, so every page that lists it shows the same truth.
  function purgeRequests() {
    let changed = false;
    for (const [id, rec] of requests) {
      if (rec.state === 'pending' && rec.expiresAt <= now()) { rec.state = 'expired'; rec.expiresAt = now() + REQUEST_KEEP_MS; changed = true; }
      else if (rec.state !== 'pending' && rec.expiresAt <= now()) { requests.delete(id); changed = true; }
    }
    return changed;
  }

  function requestLink({ machineName, os, version } = {}) {
    const normalizedOs = normalizeNodeOs(os);
    if (!normalizedOs || !SUPPORTED_OS.has(normalizedOs)) throw new NodePairingError('NLC Node works on Windows and Mac computers.');
    purgeRequests();
    const name = String(machineName || '').trim().slice(0, 80) || 'My computer';
    for (const [id, rec] of requests) if (rec.state === 'pending' && rec.name === name && rec.os === normalizedOs) requests.delete(id);
    const open = [...requests.entries()].filter(([, rec]) => rec.state === 'pending');
    while (open.length >= MAX_PENDING_REQUESTS) requests.delete(open.shift()[0]);
    const requestId = randomUUID();
    const secret = randomBytes(24).toString('hex');
    const expiresAt = now() + REQUEST_LIFETIME_MS;
    requests.set(requestId, {
      id: requestId, secretHash: sha256(secret), name, os: normalizedOs, version: String(version || '').slice(0, 40),
      requestedAt: now(), expiresAt, state: 'pending',
    });
    persist();
    return { requestId, secret, expiresAt };
  }

  function listPending() {
    if (purgeRequests()) persist();
    return [...requests.values()].filter((rec) => rec.state === 'pending')
      .map((rec) => ({ id: rec.id, name: rec.name, os: rec.os, version: rec.version, requestedAt: rec.requestedAt, expiresAt: rec.expiresAt }));
  }

  // The owner's answer. Allow makes the linked computer now; the computer collects its credentials once.
  function decideRequest(id, decision) {
    purgeRequests();
    const rec = requests.get(String(id || ''));
    if (!rec || rec.state !== 'pending') throw new NodePairingError('That computer is no longer asking to connect.');
    if (decision === 'deny') { rec.state = 'denied'; rec.expiresAt = now() + REQUEST_KEEP_MS; persist(); return { state: 'denied' }; }
    if (decision !== 'allow') throw new NodePairingError('Choose allow or deny.');
    const machineId = randomUUID();
    const token = issueToken();
    const expiresAt = now() + TOKEN_LIFETIME_MS;
    machines.set(machineId, {
      machineId, ownerId: knownOwner || 'owner', name: rec.name, os: rec.os, version: rec.version,
      tokenHash: sha256(token), createdAt: now(), expiresAt, paused: false, folders: [],
    });
    rec.state = 'allowed'; rec.grant = { machineId, token, expiresAt }; rec.expiresAt = now() + REQUEST_KEEP_MS;
    persist();
    return { state: 'allowed', machineId };
  }

  // The computer asks how its request is going. Credentials are handed over once, then the request is gone.
  function requestStatus(requestId, secret) {
    purgeRequests();
    const rec = requests.get(String(requestId || ''));
    if (!rec || !secret || !sameHash(rec.secretHash, sha256(secret))) return { state: 'expired' };
    if (rec.state === 'allowed') { requests.delete(rec.id); persist(); return { state: 'allowed', ...rec.grant }; }
    if (rec.state === 'denied' || rec.state === 'expired') { requests.delete(rec.id); persist(); return { state: rec.state }; }
    return { state: 'pending' };
  }

  function listAllMachines() { return listMachines(null); }

  function getMachine(machineId) {
    const rec = machines.get(machineId);
    return rec ? { ...view(rec), ownerId: rec.ownerId } : null;
  }

  function close() {
    for (const [, p] of pending) { clearTimeout(p.timer); clearTimeout(p.heldTimer); }
    pending.clear();
  }

  return {
    sendCommand, listMachines, getMachine, setPaused,
    createPairingCode, activePairing, exchangeCode, requestLink, listPending, decideRequest, requestStatus, listAllMachines, authenticate, authenticateToken, refreshToken, removeMachine,
    attach, detach, touch, applyState, handleResponse, close,
  };
}
