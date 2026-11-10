'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveStateRoot({ platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA } = {}) {
  if (platform === 'win32') return path.win32.join(localAppData || path.join(home, 'AppData', 'Local'), 'NLC Node');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'NLC Node');
  return path.posix.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'nlc-node');
}

function ensureStateRoot(stateRoot = resolveStateRoot()) {
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  return stateRoot;
}

function ensurePrivateToken(stateRoot) {
  const tokenPath = path.join(ensureStateRoot(stateRoot), 'token');
  if (fs.existsSync(tokenPath)) return fs.readFileSync(tokenPath, 'utf8').trim();
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return token;
}

function acquireInstanceLock(stateRoot) {
  const lockPath = path.join(ensureStateRoot(stateRoot), 'instance.lock');
  try {
    const descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
    return Object.freeze({
      acquired: true,
      release() {
        try { fs.closeSync(descriptor); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
      },
    });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      try {
        const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (!Number.isInteger(record.pid) || record.pid <= 0) throw new Error('invalid lock pid');
        process.kill(record.pid, 0);
        return Object.freeze({ acquired: false, release() {} });
      } catch (lockError) {
        if (lockError && lockError.code === 'EPERM') return Object.freeze({ acquired: false, release() {} });
        fs.unlinkSync(lockPath);
        return acquireInstanceLock(stateRoot);
      }
    }
    throw error;
  }
}

function readInstanceLock(stateRoot) {
  const lockPath = path.join(ensureStateRoot(stateRoot), 'instance.lock');
  try {
    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0) return null;
    return Object.freeze({ pid: record.pid, createdAt: typeof record.createdAt === 'string' ? record.createdAt : '' });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function stopRequestPath(stateRoot) {
  return path.join(ensureStateRoot(stateRoot), 'stop.request');
}

function requestStop(stateRoot) {
  fs.writeFileSync(stopRequestPath(stateRoot), `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 });
}

function consumeStopRequest(stateRoot) {
  const requestPath = stopRequestPath(stateRoot);
  try {
    fs.unlinkSync(requestPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

// A person's own Quit (the tray's Quit, or `--stop`) is remembered so the restart supervisor leaves the Node off until
// someone opens it again (any normal start clears it) or the computer signs in again (the sign-in entry starts it normally).
function userStoppedPath(stateRoot) {
  return path.join(ensureStateRoot(stateRoot), 'user-stopped.json');
}

function markUserStopped(stateRoot) {
  fs.writeFileSync(userStoppedPath(stateRoot), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600 });
}

function isUserStopped(stateRoot) {
  return fs.existsSync(userStoppedPath(stateRoot));
}

function clearUserStopped(stateRoot) {
  try { fs.unlinkSync(userStoppedPath(stateRoot)); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
}

module.exports = { acquireInstanceLock, clearUserStopped, consumeStopRequest, ensurePrivateToken, ensureStateRoot, isUserStopped, markUserStopped, readInstanceLock, requestStop, resolveStateRoot, stopRequestPath, userStoppedPath };
