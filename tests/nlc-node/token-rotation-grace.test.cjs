'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// HF-2026-11-11-16: a sign-in that carries the token a refresh just replaced must still be accepted for a short grace.
test('previous token still signs in for the grace, then not', async () => {
  const { createNodeBackend } = await import('../../ui/lib/node-backend.js');
  let t = 1_000_000;
  const dataFile = path.join(os.tmpdir(), `node-grace-${process.pid}-${Date.now()}.json`);
  const backend = createNodeBackend({ dataFile, now: () => t });
  const { code } = backend.createPairingCode('owner');
  const paired = backend.exchangeCode({ code, machineName: 'Mac', os: 'darwin', version: '1' });
  const refreshed = backend.refreshToken(paired.token);
  assert.ok(refreshed.token && refreshed.token !== paired.token);
  assert.ok(backend.authenticate(paired.machineId, paired.token), 'old token inside grace');
  assert.ok(backend.authenticate(paired.machineId, refreshed.token), 'new token');
  t += 11 * 60 * 1000;
  assert.equal(backend.authenticate(paired.machineId, paired.token), null, 'old token after grace');
  assert.ok(backend.authenticate(paired.machineId, refreshed.token));
});
