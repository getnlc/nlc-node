'use strict';
const { executeTransport, transportHealth } = require('./transport-runner.cjs');
const { MODULE_API_VERSION } = require('./identity.cjs');
const HOST_FIELDS = Object.freeze(['NLC_RUNTIME_ID', 'RUNTIME_ID', 'NLC_AGENT_ID', 'NLC_CODEX_AGENT_ID', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'NLC_SESSION_ID', 'NLC_RUNTIME_SESSION_ID']);
const RUNTIMES = Object.freeze(['claude', 'codex']);
function bad(message) { return Object.assign(new Error(message), { status: 400 }); }

function createCentralConnector(options = {}) {
  let running = false;
  let completed = 0;
  let failed = 0;
  let lastEvent = null;
  const execute = options.execute || (event => executeTransport(event, options));
  const service = Object.freeze({
    async handleLifecycle(body) {
      if (!body || !RUNTIMES.includes(body.runtime)) throw bad('Choose runtime claude or codex.');
      if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) throw bad('Send the existing host event as input, a JSON object.');
      if (!running) throw Object.assign(new Error('central_unavailable'), { status: 503 });
      const host = {};
      for (const key of HOST_FIELDS) if (typeof body.host?.[key] === 'string') host[key] = body.host[key];
      host.NLC_RUNTIME_ID = body.runtime;
      const event = { runtime: body.runtime, input: body.input, host };
      lastEvent = { runtime: body.runtime, event: String(body.input.hook_event_name || ''), at: new Date().toISOString() };
      try {
        const result = await execute(event);
        if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string') throw Error('transport_failed');
        // Only a complete host packet is successful; partial output must invoke the adapter's legacy fallback.
        const packet = JSON.parse(result.stdout);
        if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw Error('transport_invalid');
        completed++;
        return { stdout: result.stdout, exitCode: 0 };
      } catch {
        failed++;
        throw Object.assign(new Error('central_unavailable'), { status: 503 });
      }
    },
  });
  const descriptor = {
    manifest: { apiVersion: MODULE_API_VERSION, id: 'central', version: '1.0.0', dependsOn: [] },
    create: () => ({
      async start() { running = true; },
      health() { return { ok: running, transport: transportHealth(options), completed, failed, lastEvent }; },
      async stop() { running = false; },
    }),
  };
  return Object.freeze({ descriptor, service });
}
module.exports = { createCentralConnector, HOST_FIELDS, RUNTIMES };
