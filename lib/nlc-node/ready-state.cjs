'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_STATES = new Set(['starting', 'ready', 'not-ready', 'stopped']);

function readyPath(stateRoot) {
  return path.join(stateRoot, 'ready.json');
}

function writeReadyState(stateRoot, { state, version, error = '', pid = process.pid, launchId = '' }) {
  if (!ALLOWED_STATES.has(state)) throw new Error(`NLC Node readiness state is invalid: ${state}`);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('NLC Node readiness pid is invalid.');
  if (typeof launchId !== 'string' || !/^[A-Za-z0-9_-]{0,128}$/.test(launchId)) throw new Error('NLC Node launch id is invalid.');
  const record = { state, version, error: error ? String(error) : '', pid, launchId, updatedAt: new Date().toISOString() };
  const destination = readyPath(stateRoot);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, destination);
  return Object.freeze(record);
}

function readReadyState(stateRoot) {
  try {
    const record = JSON.parse(fs.readFileSync(readyPath(stateRoot), 'utf8'));
    if (!record || !ALLOWED_STATES.has(record.state) || typeof record.version !== 'string') return null;
    if (!Number.isInteger(record.pid) || record.pid <= 0 || typeof record.launchId !== 'string') return null;
    return Object.freeze({ state: record.state, version: record.version, error: record.error || '', pid: record.pid, launchId: record.launchId, updatedAt: record.updatedAt || '' });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

module.exports = { readReadyState, writeReadyState };
