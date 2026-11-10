'use strict';

const fs = require('node:fs');
const path = require('node:path');

function endpointPath(stateRoot) {
  return path.join(stateRoot, 'endpoint.json');
}

function writeLocalEndpoint(stateRoot, { port }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NLC Node local endpoint port is invalid.');
  const destination = endpointPath(stateRoot);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ host: '127.0.0.1', port })}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, destination);
  return Object.freeze({ host: '127.0.0.1', port });
}

function readLocalEndpoint(stateRoot) {
  try {
    const record = JSON.parse(fs.readFileSync(endpointPath(stateRoot), 'utf8'));
    if (record?.host !== '127.0.0.1' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) return null;
    return Object.freeze({ host: record.host, port: record.port });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function removeLocalEndpoint(stateRoot) {
  try { fs.unlinkSync(endpointPath(stateRoot)); }
  catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
}

module.exports = { endpointPath, readLocalEndpoint, removeLocalEndpoint, writeLocalEndpoint };
