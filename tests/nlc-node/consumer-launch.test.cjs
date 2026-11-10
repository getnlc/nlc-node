'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLaunchController, resolveStateRoot } = require('../../lib/nlc-node/index.cjs');
const { requestStopAndWait, run } = require('../../lib/nlc-node/runtime.cjs');

test('NLC Node resolves ordinary per-user state locations without repository paths', () => {
  assert.equal(resolveStateRoot({ platform: 'win32', home: 'C:\\Users\\Ada', localAppData: 'C:\\Users\\Ada\\AppData\\Local' }), 'C:\\Users\\Ada\\AppData\\Local\\NLC Node');
  assert.equal(resolveStateRoot({ platform: 'darwin', home: '/Users/ada' }), '/Users/ada/Library/Application Support/NLC Node');
});

test('consumer launch records generic readiness and shows no local secret or port', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-launch-'));
  const dialogs = [];
  const controller = createLaunchController({
    version: '1.0.0',
    stateRoot,
    showDialog: async (dialog) => dialogs.push(dialog),
  });
  t.after(async () => {
    await controller.stop().catch(() => {});
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  const result = await controller.start();
  assert.deepEqual(result.endpoint, { host: '127.0.0.1' });
  assert.deepEqual(controller.readyState().state, 'ready');
  assert.deepEqual(dialogs, [{ title: 'NLC Node', state: 'ready', message: 'NLC Node is ready.' }]);
  const readyFile = fs.readFileSync(path.join(stateRoot, 'ready.json'), 'utf8');
  assert.doesNotMatch(readyFile, /token|port|Bearer/i);
  assert.match(readyFile, /"pid":\d+/);
  assert.match(readyFile, /"launchId":"[A-Za-z0-9_-]+"/);
  assert.equal(fs.existsSync(path.join(stateRoot, 'token')), true);
});

test('second launch reuses a running NLC Node instead of creating another instance', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-single-instance-'));
  const first = createLaunchController({ version: '1.0.0', stateRoot });
  const second = createLaunchController({ version: '1.0.0', stateRoot });
  t.after(async () => {
    await first.stop().catch(() => {});
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  await first.start();
  const result = await second.start();
  assert.equal(result.reused, true);
  assert.equal(result.readiness.state, 'ready');
});

test('a stale instance lock is recovered and a failed launch releases its lock', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-recovery-'));
  fs.writeFileSync(path.join(stateRoot, 'instance.lock'), JSON.stringify({ pid: 99999999 }), 'utf8');
  const brokenModule = {
    manifest: { apiVersion: 'nlc-node.module/v1', id: 'broken-module', version: '1.0.0', dependsOn: [] },
    create: () => ({ start: () => { throw new Error('broken launch'); }, health: () => ({}), stop: () => {} }),
  };
  const failed = createLaunchController({ version: '1.0.0', stateRoot, modules: [brokenModule] });
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  await assert.rejects(failed.start(), /broken launch/);
  assert.equal(fs.existsSync(path.join(stateRoot, 'instance.lock')), false);
  assert.equal(failed.readyState().state, 'not-ready');
  assert.equal(failed.readyState().error, 'NLC_NODE_START_FAILED');
});

test('consumer readiness becomes not-ready when a running module becomes unhealthy', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-health-monitor-'));
  let healthy = true;
  const controller = createLaunchController({
    version: '1.0.0',
    stateRoot,
    healthCheckIntervalMs: 5,
    modules: [{
      manifest: { apiVersion: 'nlc-node.module/v1', id: 'health-module', version: '1.0.0', dependsOn: [] },
      create: () => ({ start: () => {}, health: () => { if (!healthy) throw new Error('unhealthy'); return { healthy: true }; }, stop: () => {} }),
    }],
  });
  t.after(async () => {
    await controller.stop().catch(() => {});
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  await controller.start();
  healthy = false;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(controller.readyState().state, 'not-ready');
  assert.equal(controller.readyState().error, 'NLC_NODE_HEALTH_FAILED');
});

test('controlled stop waits for the running host to write stopped state', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-controlled-stop-'));
  const controller = await run({ version: '1.0.0', stateRoot, argumentsList: [] });
  t.after(async () => {
    await controller.stop().catch(() => {});
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  const result = await requestStopAndWait({ stateRoot, timeoutMs: 2_000, pollIntervalMs: 10 });
  assert.deepEqual(result, { stopped: true, wasRunning: true });
  assert.equal(controller.readyState().state, 'stopped');
});
