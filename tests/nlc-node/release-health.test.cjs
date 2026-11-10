'use strict';

// Drives the real loopback server and the real health command the installers' verify scripts call (checks I02, I04, C06).
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startLoopbackServer } = require('../../lib/nlc-node/loopback-server.cjs');
const { writeLocalEndpoint } = require('../../lib/nlc-node/local-endpoint.cjs');

const script = path.resolve(__dirname, '..', '..', 'scripts', 'nlc-node', 'loopback-health.cjs');

function runHealth(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

async function fakeHost(t, initialState) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-health-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const readiness = { state: initialState };
  const server = await startLoopbackServer({
    token: 'x'.repeat(43),
    getIdentity: () => ({}),
    getModules: () => [],
    getReadiness: () => readiness,
  });
  t.after(() => server.close());
  writeLocalEndpoint(stateDir, { port: server.port });
  return { stateDir, readiness, port: server.port };
}

test('health command succeeds when the running Node answers ready on loopback', async (t) => {
  const host = await fakeHost(t, 'ready');
  const result = await runHealth(['--state-dir', host.stateDir]);
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.state, 'ready');
  assert.equal(body.port, host.port);
});

test('health command waits for a Node that is still starting and then passes', async (t) => {
  const host = await fakeHost(t, 'starting');
  setTimeout(() => { host.readiness.state = 'ready'; }, 400);
  const result = await runHealth(['--state-dir', host.stateDir, '--timeout-ms', '5000']);
  assert.equal(result.code, 0, result.stderr);
});

test('health command fails in plain words when the Node never becomes ready', async (t) => {
  const host = await fakeHost(t, 'starting');
  const result = await runHealth(['--state-dir', host.stateDir, '--timeout-ms', '700']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /NLC Node did not become ready/);
  assert.doesNotMatch(result.stderr, /at .*\.cjs:\d+/);
});

test('health command fails in plain words when the Node is not running at all', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-health-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const result = await runHealth(['--state-dir', stateDir, '--timeout-ms', '500']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /NLC Node is not running/);
});

test('health command can prove the Node is gone after a stop', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-health-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const result = await runHealth(['--state-dir', stateDir, '--expect', 'down', '--timeout-ms', '500']);
  assert.equal(result.code, 0, result.stderr);
});
