'use strict';
// Piece G: runs one tool call from the customer's VPS against the Node's modules.
// Pause check, action logging and error conversion happen here, once (CONTRACT Addendum A).
const { NodeError, CODES } = require('./errors.cjs');

const REMEMBERED_IDS = 200;
const DEFAULT_TIMEOUT_MS = 30000;
const VIDEO_TIMEOUT_MS = 600000;
const PAUSED_MESSAGE = 'The customer has paused file access on this computer.';
const GENERIC_MESSAGE = 'Something went wrong on this computer. Try again.';
const TIMEOUT_MESSAGE = 'That took too long and was stopped. Try again.';

function isVideoTool(tool) {
  return /^(video_|audio_)/.test(tool) || tool === 'media_info';
}

function listModules(host) {
  if (!host) return [];
  if (Array.isArray(host)) return host;
  if (typeof host.modules === 'function') return host.modules() || [];
  if (typeof host.instances === 'function') return host.instances() || [];
  return [];
}

function toErrorBody(error) {
  if (error && (error instanceof NodeError || error.name === 'NodeError') && CODES.includes(error.code)) {
    return { code: error.code, message: String(error.message || error.code) };
  }
  if (error && error.code === 'ENOENT') return { code: 'NOT_FOUND', message: 'That file or folder was not found.' };
  return { code: 'BUSY', message: GENERIC_MESSAGE };
}

function createDispatcher({ host, grants, timeoutsMs = {}, setTimer = setTimeout, clearTimer = clearTimeout, now = () => new Date() } = {}) {
  function findTool(tool) {
    for (const mod of listModules(host)) {
      if (mod && mod.tools && Object.prototype.hasOwnProperty.call(mod.tools, tool) && typeof mod.tools[tool] === 'function') return mod;
    }
    return null;
  }
  function findRecorder() {
    for (const mod of listModules(host)) if (mod && typeof mod.record === 'function') return mod;
    return null;
  }
  async function record(call, tool, args, ok, code) {
    const recorder = findRecorder();
    if (!recorder) return;
    const a = args && typeof args === 'object' ? args : {};
    const entry = {
      ts: now().toISOString(),
      machineId: call && call.machineId,
      tool,
      folder: typeof a.folder === 'string' ? a.folder : undefined,
      path: typeof a.path === 'string' ? a.path : undefined,
      ok,
    };
    if (code) entry.code = code;
    try { await recorder.record(entry); } catch { /* logging must never break a call */ }
  }
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => reject(new NodeError('BUSY', TIMEOUT_MESSAGE)), ms);
      promise.then((v) => { clearTimer(timer); resolve(v); }, (e) => { clearTimer(timer); reject(e); });
    });
  }

  async function run(tool, args, call = {}) {
    const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    try {
      const paused = !!(grants && typeof grants.isPaused === 'function' && grants.isPaused());
      if (tool === 'set_paused') {
        // Only the customer pauses (the dashboard sends this); it must work while paused so it can resume.
        const wanted = safeArgs.paused;
        if (typeof wanted !== 'boolean' || !grants || typeof grants.setPaused !== 'function') {
          await record(call, tool, safeArgs, false, 'BAD_ARGUMENT');
          return { ok: false, error: { code: 'BAD_ARGUMENT', message: 'Say whether to pause: paused true or false.' } };
        }
        await grants.setPaused(wanted);
        await record(call, tool, safeArgs, true);
        return { ok: true, result: { paused: wanted } };
      }
      if (paused && tool !== 'computer_status') {
        await record(call, tool, safeArgs, false, 'PAUSED');
        return { ok: false, error: { code: 'PAUSED', message: PAUSED_MESSAGE } };
      }
      const mod = findTool(tool);
      let work;
      if (mod) {
        work = Promise.resolve().then(() => mod.tools[tool](safeArgs, { machineId: call.machineId, requestId: call.requestId }));
      } else if (tool === 'computer_status') {
        work = Promise.resolve({ paused, folders: grants && grants.list ? grants.list().map((g) => ({ label: g.label, path: g.path })) : [] });
      } else {
        await record(call, tool, safeArgs, false, 'BAD_ARGUMENT');
        return { ok: false, error: { code: 'BAD_ARGUMENT', message: `I do not know a tool called "${String(tool).slice(0, 60)}".` } };
      }
      const ms = timeoutsMs[tool] || (isVideoTool(tool) ? (timeoutsMs.video || VIDEO_TIMEOUT_MS) : (timeoutsMs.default || DEFAULT_TIMEOUT_MS));
      const result = await withTimeout(work, ms);
      await record(call, tool, safeArgs, true);
      return { ok: true, result: result === undefined ? null : result };
    } catch (error) {
      const body = toErrorBody(error);
      await record(call, tool, safeArgs, false, body.code);
      return { ok: false, error: body };
    }
  }
  // A command the server resent after a dropped line carries the same id: it never runs twice.
  // The answer (or the run still in flight) is remembered for the last REMEMBERED_IDS ids.
  const answers = new Map();
  function handle(tool, args, call = {}) {
    const id = call && call.requestId;
    if (id === undefined || id === null) return run(tool, args, call);
    const key = String(id);
    if (answers.has(key)) return answers.get(key);
    const promise = run(tool, args, call);
    answers.set(key, promise);
    while (answers.size > REMEMBERED_IDS) answers.delete(answers.keys().next().value);
    return promise;
  }
  return Object.freeze({ handle });
}

module.exports = { createDispatcher, DEFAULT_TIMEOUT_MS, VIDEO_TIMEOUT_MS };
