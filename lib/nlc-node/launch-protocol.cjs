'use strict';

const crypto = require('node:crypto');
const { ModuleHost } = require('./module-host.cjs');
const { acquireInstanceLock, ensurePrivateToken, ensureStateRoot, resolveStateRoot } = require('./local-state.cjs');
const { removeLocalEndpoint, writeLocalEndpoint } = require('./local-endpoint.cjs');
const { readReadyState, writeReadyState } = require('./ready-state.cjs');
const { startLoopbackServer } = require('./loopback-server.cjs');

function createLaunchController({ version, modules = [], connector = null, stateRoot = resolveStateRoot(), launchId = crypto.randomUUID(), healthCheckIntervalMs = 5_000, showDialog = async () => {}, host: providedHost = null, windowPage = null, windowApi = null }) {
  let lock = null;
  let host = null;
  let server = null;
  let healthTimer = null;
  let healthCheckRunning = false;

  async function monitorHealth() {
    if (healthCheckRunning || !host || host.lifecycle !== 'running') return;
    healthCheckRunning = true;
    try {
      const health = await host.health();
      if (health.lifecycle !== 'running') {
        writeReadyState(stateRoot, { state: 'not-ready', version, error: 'NLC_NODE_HEALTH_FAILED', launchId });
      }
    } finally {
      healthCheckRunning = false;
    }
  }

  return Object.freeze({
    async start() {
      ensureStateRoot(stateRoot);
      lock = acquireInstanceLock(stateRoot);
      if (!lock.acquired) return Object.freeze({ reused: true, readiness: readReadyState(stateRoot) });
      writeReadyState(stateRoot, { state: 'starting', version, launchId });
      try {
        const token = ensurePrivateToken(stateRoot);
        host = providedHost || new ModuleHost({ version });
        for (const descriptor of [...(connector ? [connector.descriptor] : []), ...modules]) await host.register(descriptor);
        await host.start();
        server = await startLoopbackServer({
          token,
          getIdentity: () => host.identity(),
          getHealth: () => host.health(),
          getModules: () => host.snapshot().modules,
          getReadiness: () => ({ state: host.lifecycle === 'running' ? 'ready' : 'not-ready' }),
          handleMcp: connector ? connector.service.handleMcp : null,
          handleLifecycle: connector ? connector.service.handleLifecycle : null,
          windowPage,
          windowApi,
        });
        writeLocalEndpoint(stateRoot, { port: server.port });
        const readiness = writeReadyState(stateRoot, { state: 'ready', version, launchId });
        healthTimer = setInterval(() => { monitorHealth().catch(() => {}); }, healthCheckIntervalMs);
        await Promise.resolve(showDialog(Object.freeze({ title: 'NLC Node', state: 'ready', message: 'NLC Node is ready.' })));
        return Object.freeze({ reused: false, readiness, endpoint: Object.freeze({ host: server.host }) });
      } catch (error) {
        if (server) await server.close().catch(() => {});
        removeLocalEndpoint(stateRoot);
        if (host) await host.stop().catch(() => {});
        if (healthTimer) clearInterval(healthTimer);
        healthTimer = null;
        if (lock) lock.release();
        lock = null;
        host = null;
        server = null;
        const readiness = writeReadyState(stateRoot, { state: 'not-ready', version, error: 'NLC_NODE_START_FAILED', launchId });
        await Promise.resolve(showDialog(Object.freeze({ title: 'NLC Node', state: 'not-ready', message: 'NLC Node is not ready.' })));
        throw Object.assign(error, { readiness });
      }
    },
    async stop() {
      try {
        if (healthTimer) clearInterval(healthTimer);
        healthTimer = null;
        if (server) await server.close();
        removeLocalEndpoint(stateRoot);
        if (host) await host.stop();
        return writeReadyState(stateRoot, { state: 'stopped', version, launchId });
      } finally {
        if (lock) lock.release();
        lock = null;
        host = null;
        server = null;
      }
    },
    localEndpoint: () => server ? Object.freeze({ host: server.host, port: server.port }) : null,
    readyState: () => readReadyState(stateRoot),
  });
}

module.exports = { createLaunchController };
