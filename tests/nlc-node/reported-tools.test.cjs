'use strict';
// A new Node tool must never need an NLC release: the NLC calls the tools the connected Node reported at sign-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { createDispatcher } = require('../../lib/nlc-node/dispatcher.cjs');

async function setup() {
  const { createNodeBackend } = await import('../../ui/lib/node-backend.js');
  const { registerNodePairingRoutes } = await import('../../ui/lib/node-pairing-routes.js');
  const backend = createNodeBackend({ dataFile: path.join(os.tmpdir(), `node-tools-${process.pid}-${Date.now()}-${Math.random()}.json`) });
  const { code } = backend.createPairingCode('owner');
  const paired = backend.exchangeCode({ code, machineName: 'Mac', os: 'darwin', version: '1' });
  const routes = new Map();
  registerNodePairingRoutes({
    app: { post: (p, ...h) => routes.set(`POST ${p}`, h[h.length - 1]), get: (p, ...h) => routes.set(`GET ${p}`, h[h.length - 1]), delete: (p, ...h) => routes.set(`DELETE ${p}`, h[h.length - 1]) },
    backend, authenticateRequest: () => true, isLocalRequest: () => true,
  });
  const sent = [];
  const ws = { readyState: 1, send: (frame) => sent.push(JSON.parse(frame)), close() {} };
  const call = async (body) => {
    let out;
    const response = { status(code) { this.code = code; return this; }, json(v) { out = { status: this.code || 200, body: v }; } };
    const p = routes.get('POST /api/node/agent/command')({ body, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, response);
    return { p, get: () => out };
  };
  return { backend, paired, ws, sent, call };
}

test('a tool the connected Node reported is callable, with the timeout it reported', async () => {
  const { backend, paired, ws, sent, call } = await setup();
  backend.attach(paired.machineId, ws, { version: '1', tools: [{ name: 'video_cut_silence', timeoutMs: 600000 }, { name: 'reel_setup', timeoutMs: 30000 }] });
  assert.equal(backend.reportedTools(paired.machineId).get('video_cut_silence'), 600000);
  const r = await call({ tool: 'video_cut_silence', args: { folder: 'F', path: 'a.mp4', output_name: 'b.mp4' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1, 'the command went to the computer');
  assert.equal(sent[0].tool, 'video_cut_silence');
  backend.handleResponse(paired.machineId, { id: sent[0].id, ok: true, result: { jobId: 'job-1' } });
  await r.p;
  assert.deepEqual(r.get().body, { ok: true, result: { jobId: 'job-1' } });
});

test('a tool nobody reported is still refused, and the answer names the tools that can be called', async () => {
  const { backend, paired, ws, sent, call } = await setup();
  backend.attach(paired.machineId, ws, { version: '1', tools: [{ name: 'reel_setup' }] });
  const r = await call({ tool: 'format_disk', args: {} });
  await r.p;
  assert.equal(r.get().status, 400);
  assert.equal(r.get().body.error.code, 'NOT_FOUND');
  assert.match(r.get().body.error.message, /Available tools: .*list.*reel_setup/);
  assert.equal(sent.length, 0);
});

test('the pause switch and the folder chooser can never be called through a reported name', async () => {
  const { backend, paired, ws, sent, call } = await setup();
  backend.attach(paired.machineId, ws, { version: '1', tools: [{ name: 'set_paused' }, { name: 'ask_for_folder' }, { name: 'Bad Name!' }, { name: 'ok_tool', timeoutMs: 5 }] });
  const names = [...backend.reportedTools(paired.machineId).keys()];
  assert.deepEqual(names, ['ok_tool']);
  assert.equal(backend.reportedTools(paired.machineId).get('ok_tool'), 1000, 'a silly timeout is held to the floor');
  const r = await call({ tool: 'set_paused', args: { paused: true } });
  await r.p;
  assert.equal(r.get().status, 400);
  assert.equal(sent.length, 0);
});

test('an older Node that reports nothing keeps working with the fixed list; a computer that did not report a tool cannot be asked for it', async () => {
  const { backend, paired, ws, sent, call } = await setup();
  backend.attach(paired.machineId, ws, { version: '1' });
  assert.equal(backend.reportedTools(paired.machineId).size, 0);
  const ok = await call({ tool: 'list', args: { folder: 'F' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].tool, 'list');
  backend.handleResponse(paired.machineId, { id: sent[0].id, ok: true, result: [] });
  await ok.p;
  const no = await call({ tool: 'reel_setup', args: {} });
  await no.p;
  assert.equal(no.get().status, 400);
});

test('the Node says which tools it has and how long each may take', () => {
  const dispatcher = createDispatcher({ host: [{ tools: { list: async () => [], video_cut_silence: async () => ({}), raea_run: async () => ({}), reel_setup: async () => ({}) } }] });
  const tools = Object.fromEntries(dispatcher.describeTools().map((t) => [t.name, t.timeoutMs]));
  assert.deepEqual(tools, { list: 30000, video_cut_silence: 600000, raea_run: 600000, reel_setup: 30000 });
});
