'use strict';

// HF-2026-11-14-07: leftover records from before a restart must never stop NLC Node from starting at sign-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireInstanceLock, predatesBoot, resolveStoppedState, userStoppedPath } = require('../../lib/nlc-node/local-state.cjs');

const BEFORE_ANY_BOOT = '2020-01-01T00:00:00.000Z';
function folder() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-stale-')); }

test('a record written before this boot is stale', () => {
  assert.equal(predatesBoot(BEFORE_ANY_BOOT), true);
  assert.equal(predatesBoot(new Date().toISOString()), false);
  assert.equal(predatesBoot('nonsense'), true);
});

test('a leftover instance lock from before the boot is replaced even when its process id is alive', () => {
  const root = folder();
  fs.writeFileSync(path.join(root, 'instance.lock'), JSON.stringify({ pid: process.pid, createdAt: BEFORE_ANY_BOOT }));
  const lock = acquireInstanceLock(root);
  assert.equal(lock.acquired, true);
  lock.release();
});

test('a live lock written since boot still blocks a second start', () => {
  const root = folder();
  const first = acquireInstanceLock(root);
  assert.equal(first.acquired, true);
  assert.equal(acquireInstanceLock(root).acquired, false);
  first.release();
});

test('the supervisor keeps a Quit made this session and clears one from before the boot; a normal start always clears it', () => {
  const root = folder();
  const mark = (at) => fs.writeFileSync(userStoppedPath(root), JSON.stringify({ at }));
  mark(new Date().toISOString());
  assert.deepEqual({ ...resolveStoppedState(root, { supervised: true }) }, { was: true, cleared: false, hold: true });
  mark(BEFORE_ANY_BOOT);
  assert.deepEqual({ ...resolveStoppedState(root, { supervised: true }) }, { was: true, cleared: true, hold: false });
  assert.equal(fs.existsSync(userStoppedPath(root)), false);
  mark(new Date().toISOString());
  assert.equal(resolveStoppedState(root, { supervised: false }).cleared, true);
  assert.deepEqual({ ...resolveStoppedState(root, { supervised: false }) }, { was: false, cleared: false, hold: false });
});
