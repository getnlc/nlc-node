'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MODULE_API_VERSION, ModuleHost, startLoopbackServer } = require('../../lib/nlc-node/index.cjs');

function fixture(id, events, options = {}) {
  return {
    manifest: { apiVersion: MODULE_API_VERSION, id, version: '1.0.0', dependsOn: options.dependsOn || [] },
    create() {
      return {
        async start() {
          events.push(`start:${id}`);
          if (options.failStart) throw new Error(`${id} failed`);
        },
        health() { return { id, healthy: true }; },
        async stop() { events.push(`stop:${id}`); },
      };
    },
  };
}

test('NLC Node validates modules and starts dependencies before dependants', async () => {
  const events = [];
  const host = new ModuleHost({ version: '1.0.0' });
  await host.register(fixture('core-module', events));
  await host.register(fixture('dependent-module', events, { dependsOn: ['core-module'] }));
  await host.start();

  assert.equal(host.identity().id, 'nlc-node');
  assert.deepEqual(events, ['start:core-module', 'start:dependent-module']);
  assert.deepEqual(host.snapshot().modules.map((module) => module.lifecycle), ['ready', 'ready']);
  await host.stop();
  assert.deepEqual(events, ['start:core-module', 'start:dependent-module', 'stop:dependent-module', 'stop:core-module']);
});

test('NLC Node rejects malformed, duplicate, and cyclic module descriptors', async () => {
  const host = new ModuleHost({ version: '1.0.0' });
  await assert.rejects(host.register({ manifest: { id: 'wrong' }, create() {} }), /apiVersion/);
  await host.register(fixture('first-module', []));
  await assert.rejects(host.register(fixture('first-module', [])), /already registered/);
  await host.register(fixture('second-module', [], { dependsOn: ['third-module'] }));
  await host.register(fixture('third-module', [], { dependsOn: ['second-module'] }));
  await assert.rejects(host.start(), /dependency cycle/);
});

test('NLC Node exposes direct failure state and rolls started modules back in reverse order', async () => {
  const events = [];
  const host = new ModuleHost({ version: '1.0.0' });
  await host.register(fixture('first-module', events));
  await host.register(fixture('broken-module', events, { dependsOn: ['first-module'], failStart: true }));
  await assert.rejects(host.start(), /broken-module failed/);

  const snapshot = host.snapshot();
  assert.equal(snapshot.lifecycle, 'failed');
  assert.equal(snapshot.modules.find((module) => module.id === 'broken-module').lifecycle, 'failed');
  assert.deepEqual(events, ['start:first-module', 'start:broken-module', 'stop:first-module']);
  await assert.rejects(host.start(), /cannot start while failed/);
});

test('NLC Node evaluates module health and marks a host failed when a ready module becomes unhealthy', async () => {
  const host = new ModuleHost({ version: '1.0.0' });
  await host.register({
    manifest: { apiVersion: MODULE_API_VERSION, id: 'unhealthy-module', version: '1.0.0', dependsOn: [] },
    create: () => ({ start: () => {}, health: () => { throw new Error('health failed'); }, stop: () => {} }),
  });
  await host.start();
  const health = await host.health();
  assert.equal(health.lifecycle, 'failed');
  assert.equal(health.modules[0].lifecycle, 'failed');
  assert.equal(health.modules[0].error, 'health failed');
});

test('NLC Node starts a newly registered module while already running', async () => {
  const events = [];
  const host = new ModuleHost({ version: '1.0.0' });
  await host.register(fixture('first-module', events));
  await host.start();
  await host.register(fixture('second-module', events, { dependsOn: ['first-module'] }));
  assert.deepEqual(events, ['start:first-module', 'start:second-module']);
  assert.equal(host.snapshot().modules.find((module) => module.id === 'second-module').lifecycle, 'ready');
  await host.stop();
});

test('NLC Node loopback API keeps module data behind a private token', async () => {
  const server = await startLoopbackServer({
    token: 'a'.repeat(32),
    getIdentity: () => ({ id: 'nlc-node', version: '1.0.0' }),
    getModules: () => [{ id: 'private-module' }],
    getReadiness: () => ({ state: 'ready' }),
  });
  try {
    const health = await fetch(`http://${server.host}:${server.port}/health`);
    assert.deepEqual(await health.json(), { state: 'ready' });

    const unauthorized = await fetch(`http://${server.host}:${server.port}/v1/modules`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' });

    const authorized = await fetch(`http://${server.host}:${server.port}/v1/modules`, {
      headers: { authorization: `Bearer ${'a'.repeat(32)}` },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { modules: [{ id: 'private-module' }] });
  } finally {
    await server.close();
  }
});

test('NLC Node refuses non-loopback hosts', async () => {
  await assert.rejects(startLoopbackServer({
    host: '0.0.0.0', token: 'a'.repeat(32), getIdentity: () => ({}), getModules: () => [], getReadiness: () => ({ state: 'ready' }),
  }), /127\.0\.0\.1/);
});

test('the host hands out its running module instances, in start order, and none after stop', async () => {
  const host = new ModuleHost({ version: '1.0.0' });
  assert.deepEqual(host.instances(), []);
  const marked = (id) => ({ ...fixture(id, []), create() { return { id, tools: {}, async start() {}, health() { return {}; }, async stop() {} }; } });
  await host.register(marked('core-module'));
  await host.register({ ...marked('dependent-module'), manifest: { apiVersion: MODULE_API_VERSION, id: 'dependent-module', version: '1.0.0', dependsOn: ['core-module'] } });
  await host.start();
  assert.deepEqual(host.instances().map((instance) => instance.id), ['core-module', 'dependent-module']);
  await host.stop();
  assert.deepEqual(host.instances(), []);
});
