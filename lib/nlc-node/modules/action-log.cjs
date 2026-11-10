'use strict';
// Action log module (CONTRACT 1.3): one JSON line per tool call in <stateDir>/actions.jsonl.
// Never records file contents: only a fixed whitelist of fields is written.
const fs = require('node:fs');
const path = require('node:path');
const { MODULE_API_VERSION } = require('../identity.cjs');

const FIELDS = ['ts', 'machineId', 'tool', 'folder', 'path', 'ok', 'code'];
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5; // current file plus 4 rotated
const MAX_FIELD = 1000;

function clean(entry) {
  const src = entry && typeof entry === 'object' ? entry : {};
  const out = {};
  for (const key of FIELDS) {
    let v = src[key];
    if (v === undefined || v === null) continue;
    if (key === 'ok') v = Boolean(v);
    else { v = String(v); if (v.length > MAX_FIELD) v = v.slice(0, MAX_FIELD); }
    out[key] = v;
  }
  if (!out.ts) out.ts = new Date().toISOString();
  if (out.ok === undefined) out.ok = true;
  return out;
}

function clampLimit(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function createActionLog(context) {
  const ctx = context || {};
  const stateDir = ctx.stateDir || (ctx.options && ctx.options.stateDir);
  if (!stateDir) throw new Error('action-log needs a stateDir');
  const maxBytes = ctx.maxBytes || DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(2, ctx.maxFiles || DEFAULT_MAX_FILES);
  const current = path.join(stateDir, 'actions.jsonl');
  const rotated = (n) => path.join(stateDir, `actions.${n}.jsonl`);

  function rotate() {
    // actions.(maxFiles-1) is dropped; shift the rest up; current becomes actions.1
    const last = rotated(maxFiles - 1);
    try { fs.unlinkSync(last); } catch (_) { /* absent */ }
    for (let n = maxFiles - 2; n >= 1; n--) {
      try { fs.renameSync(rotated(n), rotated(n + 1)); } catch (_) { /* absent */ }
    }
    try { fs.renameSync(current, rotated(1)); } catch (_) { /* absent */ }
  }

  function record(entry) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const line = JSON.stringify(clean(entry)) + '\n';
      let size = 0;
      try { size = fs.statSync(current).size; } catch (_) { /* new */ }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate();
      fs.appendFileSync(current, line);
    } catch (_) {
      // logging must never break a customer call
    }
  }

  function readEntries(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e); } catch (_) { /* skip corrupt line */ }
    }
    return out;
  }

  async function log_recent(args) {
    const limit = clampLimit(args && args.limit);
    const entries = [];
    const files = [current];
    for (let n = 1; n < maxFiles; n++) files.push(rotated(n));
    for (const file of files) {
      const list = readEntries(file);
      for (let i = list.length - 1; i >= 0 && entries.length < limit; i--) entries.push(list[i]);
      if (entries.length >= limit) break;
    }
    return { entries };
  }

  return {
    record,
    tools: { log_recent },
    async start() {},
    async health() { return { ok: true }; },
    async stop() {},
  };
}

module.exports = {
  manifest: { apiVersion: MODULE_API_VERSION, id: 'action-log', version: '1.0.0', dependsOn: [] },
  create: createActionLog,
};
