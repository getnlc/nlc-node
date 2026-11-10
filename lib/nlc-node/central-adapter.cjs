'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { resolveStateRoot } = require('./local-state.cjs');
const { executeLegacy } = require('./transport-runner.cjs');
const { HOST_FIELDS, RUNTIMES } = require('./central.cjs');
const MODE_FILE = 'central-bridge.json';
const MODES = Object.freeze(['node', 'legacy']);

function bridgeMode(stateRoot = resolveStateRoot()) {
  try { const mode = JSON.parse(fs.readFileSync(path.join(stateRoot, MODE_FILE), 'utf8')).mode; return MODES.includes(mode) ? mode : 'legacy'; } catch { return 'legacy'; }
}
function setBridgeMode(mode, stateRoot = resolveStateRoot()) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (!MODES.includes(normalized)) return { ok: false, message: 'Choose node or legacy.' };
  fs.mkdirSync(stateRoot, { recursive: true });
  const destination = path.join(stateRoot, MODE_FILE), temporary = destination + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, mode: normalized }) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, destination);
  return { ok: true, mode: normalized };
}
async function deliverEvent(event, {
  stateRoot = resolveStateRoot(), legacy = executeLegacy, fetchImpl = globalThis.fetch, timeoutMs = 3000,
} = {}) {
  if (!RUNTIMES.includes(event?.runtime)) throw Error('Choose runtime claude or codex.');
  if (bridgeMode(stateRoot) === 'node') {
    try {
      const endpoint = JSON.parse(fs.readFileSync(path.join(stateRoot, 'endpoint.json'), 'utf8'));
      if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw Error('endpoint_invalid');
      const token = fs.readFileSync(path.join(stateRoot, 'token'), 'utf8').trim();
      const response = await fetchImpl(`http://127.0.0.1:${endpoint.port}/v1/lifecycle`, {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(event), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw Error('node_unavailable');
      const result = await response.json();
      if (result.exitCode !== 0 || typeof result.stdout !== 'string') throw Error('node_output_invalid');
      const packet = JSON.parse(result.stdout);
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw Error('node_output_invalid');
      return { ...result, route: 'node' };
    } catch { /* The existing bridge remains the recovery path, with the same host identity and event. */ }
  }
  return { ...await legacy(event), route: 'legacy' };
}
async function runAdapterMode(argumentsList = process.argv.slice(2), { stateRoot = resolveStateRoot(), env = process.env } = {}) {
  if (argumentsList.includes('--attach-central')) {
    let result;
    try {
      const endpoint = JSON.parse(fs.readFileSync(path.join(stateRoot, 'endpoint.json'), 'utf8'));
      const token = fs.readFileSync(path.join(stateRoot, 'token'), 'utf8').trim();
      if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw Error('Node is not ready.');
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/health`, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error('Node health is unavailable.');
      const health = await response.json();
      const central = health.modules?.find(module => module.id === 'central');
      if (!central?.health?.ok || !RUNTIMES.every(runtime => central.health.transport?.[runtime]?.available)) throw Error('The Central module transport is not ready.');
      result = require('./central-host.cjs').configureCentralClients({ stateRoot });
      if (result.ok) result.mode = setBridgeMode('node', stateRoot).mode;
    } catch (error) { result = { ok: false, message: error.message + ' The existing bridge remains selected.' }; }
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
    return true;
  }
  const switchAt = argumentsList.indexOf('--central-bridge');
  if (switchAt >= 0) {
    const result = setBridgeMode(argumentsList[switchAt + 1], stateRoot);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
    return true;
  }
  if (!argumentsList.includes('--central-event')) return false;
  const runtimeAt = argumentsList.indexOf('--runtime'), runtime = argumentsList[runtimeAt + 1];
  if (!RUNTIMES.includes(runtime)) throw Error('Choose runtime claude or codex.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 1024 * 1024) throw Error('Host event is too large.'); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
  const host = {};
  for (const key of HOST_FIELDS) if (env[key]) host[key] = env[key];
  const result = await deliverEvent({ runtime, input, host }, { stateRoot });
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode || 0;
  return true;
}
module.exports = { bridgeMode, setBridgeMode, deliverEvent, runAdapterMode, MODES };
