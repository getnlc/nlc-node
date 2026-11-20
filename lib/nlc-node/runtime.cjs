'use strict';

const os = require('node:os');
const { runDiagnostics } = require('./diagnostics.cjs');
const { createNodeApp } = require('./app.cjs');
const { consumeStopRequest, markUserStopped, readInstanceLock, requestStop, resolveStateRoot, resolveStoppedState } = require('./local-state.cjs');
const { readReadyState } = require('./ready-state.cjs');
const { selectPlatformAdapter } = require('./platform-adapters.cjs');

function argumentValue(argumentsList, name) {
  const index = argumentsList.indexOf(name);
  return index === -1 ? '' : argumentsList[index + 1] || '';
}

function launchIdFromArguments(argumentsList = process.argv.slice(2)) {
  return argumentValue(argumentsList, '--launch-id');
}

function hasStopArgument(argumentsList = process.argv.slice(2)) {
  return argumentsList.includes('--stop');
}

function hasDiagnosticsArgument(argumentsList = process.argv.slice(2)) {
  return argumentsList.includes('--diagnose');
}

function supervisionManagementArguments(argumentsList = process.argv.slice(2)) {
  return Object.freeze({
    install: argumentsList.includes('--install-supervision'),
    remove: argumentsList.includes('--remove-supervision'),
  });
}

function invocationShouldExit(argumentsList = process.argv.slice(2)) {
  const supervision = supervisionManagementArguments(argumentsList);
  return Boolean(
    supervision.install
    || supervision.remove
    || hasDiagnosticsArgument(argumentsList)
    || hasStopArgument(argumentsList)
    || ['--central-event', '--central-bridge', '--attach-central', '--run-central-installer'].some(flag => argumentsList.includes(flag))
  );
}

// Whether the restart-supervisor task is registered (Windows only; elsewhere 'n/a'). Never throws.
function windowsTaskState() {
  if (process.platform !== 'win32') return 'n/a';
  try {
    require('node:child_process').execFileSync('schtasks.exe', ['/Query', '/TN', 'NLC Node'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    return 'registered';
  } catch { return 'missing'; }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestStopAndWait({ stateRoot = resolveStateRoot(), timeoutMs = 10_000, pollIntervalMs = 100 } = {}) {
  const readiness = readReadyState(stateRoot);
  const lock = readInstanceLock(stateRoot);
  const expectedPid = readiness ? readiness.pid : lock && lock.pid;
  const expectedLaunchId = readiness ? readiness.launchId : '';
  if (!expectedPid || !processIsAlive(expectedPid)) return Object.freeze({ stopped: true, wasRunning: false });
  requestStop(stateRoot);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const updated = readReadyState(stateRoot);
    if (updated && updated.state === 'stopped' && updated.pid === expectedPid && (!expectedLaunchId || updated.launchId === expectedLaunchId)) {
      return Object.freeze({ stopped: true, wasRunning: true });
    }
    if (!processIsAlive(expectedPid)) return Object.freeze({ stopped: true, wasRunning: true });
    await wait(pollIntervalMs);
  }
  throw new Error('NLC Node did not stop safely.');
}

async function run({
  argumentsList = process.argv.slice(2),
  version = process.env.NLC_NODE_VERSION || globalThis.__NLC_NODE_VERSION__ || '0.1.0',
  launchId = launchIdFromArguments(argumentsList),
  stateRoot = argumentValue(argumentsList, '--state-dir') || resolveStateRoot(),
  appOptions = {},
  diagnosticsOptions = {},
  platformAdapter = selectPlatformAdapter(),
  executablePath = process.execPath,
  taskProbe = windowsTaskState,
} = {}) {
  if (await require('./central-adapter.cjs').runAdapterMode(argumentsList, { stateRoot })) return;
  const supervisionManagement = supervisionManagementArguments(argumentsList);
  if (supervisionManagement.install || supervisionManagement.remove) {
    if (supervisionManagement.install && supervisionManagement.remove) throw new Error('supervision_management_arguments_invalid');
    if (!platformAdapter.supervision) throw new Error('platform_supervision_unavailable');
    return supervisionManagement.install
      ? platformAdapter.supervision.install({ executablePath, stateRoot })
      : platformAdapter.supervision.remove({ executablePath, stateRoot });
  }
  if (hasDiagnosticsArgument(argumentsList)) {
    return runDiagnostics({ ...diagnosticsOptions, version, stateRoot });
  }
  if (hasStopArgument(argumentsList)) {
    markUserStopped(stateRoot);
    return requestStopAndWait({ stateRoot });
  }
  // The restart supervisor passes --supervised. It keeps a Quit made since this boot; every other start (and any Quit from before this boot) clears it.
  const supervised = argumentsList.includes('--supervised');
  const stopped = resolveStoppedState(stateRoot, { supervised });
  if (stopped.hold) return null;
  const startupReport = Object.freeze({
    how: supervised ? 'supervised' : (launchId ? 'launcher' : 'direct'),
    userStoppedWas: stopped.was, userStoppedCleared: stopped.cleared,
    task: taskProbe(), at: new Date().toISOString(), bootAt: new Date(Date.now() - os.uptime() * 1000).toISOString(),
  });
  const controller = createNodeApp({
    version, launchId: launchId || undefined, stateRoot, startupReport, origin: argumentValue(argumentsList, '--origin'),
    ...(argumentValue(argumentsList, '--platform') ? { platform: argumentValue(argumentsList, '--platform') } : {}),
    ...appOptions,
  });
  const started = await controller.start();
  // Another Host already runs on this state folder (the supervisor and the tray both started one): this one just ends.
  // It must not stay alive, or a supervisor would think its task is still running while the real Host is gone.
  if (started && started.reused) return controller;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(stopWatcher);
    await controller.stop().catch(() => {});
    process.exitCode = 0;
  };
  const stopWatcher = setInterval(() => {
    if (consumeStopRequest(stateRoot)) stop().catch(() => {});
  }, 250);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller;
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write('NLC Node could not start.\n');
    process.exitCode = 1;
  });
}

module.exports = { argumentValue, hasDiagnosticsArgument, hasStopArgument, invocationShouldExit, launchIdFromArguments, processIsAlive, supervisionManagementArguments, requestStopAndWait, run };
