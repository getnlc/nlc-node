'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher } = require('../../lib/nlc-node/dispatcher.cjs');
const { NodeError } = require('../../lib/nlc-node/errors.cjs');

function setup(tools = {}, { paused = false, extra = {} } = {}) {
  const log = [];
  const files = { tools };
  const actionLog = { tools: { log_recent: async () => ({ lines: log.length }) }, record: async (e) => { log.push(e); } };
  const state = { paused };
  const grants = { isPaused: () => state.paused, list: () => [{ label: 'Footage', path: '/x' }] };
  const d = createDispatcher({ host: [files, actionLog], grants, ...extra });
  return { d, log, state };
}

test('a normal call returns the module result and is logged without contents', async () => {
  const { d, log } = setup({ list: async (a) => ({ entries: [a.path] }) });
  const r = await d.handle('list', { folder: 'Footage', path: 'a', content: 'SECRET BODY' }, { machineId: 'm1', requestId: '1' });
  assert.deepEqual(r, { ok: true, result: { entries: ['a'] } });
  assert.equal(log.length, 1);
  assert.equal(log[0].tool, 'list');
  assert.equal(log[0].folder, 'Footage');
  assert.equal(log[0].path, 'a');
  assert.equal(log[0].machineId, 'm1');
  assert.equal(log[0].ok, true);
  assert.ok(!JSON.stringify(log).includes('SECRET BODY'));
});

test('paused returns PAUSED for file tools but still answers computer_status, and resumes', async () => {
  const { d, state, log } = setup({ list: async () => ({}) }, { paused: true });
  const r = await d.handle('list', {}, {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PAUSED');
  assert.equal(r.error.message, 'The customer has paused file access on this computer.');
  assert.equal(log[0].code, 'PAUSED');
  const s = await d.handle('computer_status', {}, {});
  assert.equal(s.ok, true);
  assert.equal(s.result.paused, true);
  state.paused = false;
  assert.equal((await d.handle('list', {}, {})).ok, true);
});

test('a NodeError becomes a plain error body and is logged with its code', async () => {
  const { d, log } = setup({ read_text: async () => { throw new NodeError('NOT_FOUND', 'notes.txt was not found.'); } });
  const r = await d.handle('read_text', { folder: 'Footage', path: 'notes.txt' }, {});
  assert.deepEqual(r, { ok: false, error: { code: 'NOT_FOUND', message: 'notes.txt was not found.' } });
  assert.equal(log[0].ok, false);
  assert.equal(log[0].code, 'NOT_FOUND');
});

test('an unknown error gives a generic message with no stack or internals', async () => {
  const { d } = setup({ list: async () => { throw new Error('boom at C:\\Users\\bob\\secret.js:12'); } });
  const r = await d.handle('list', {}, {});
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'Something went wrong on this computer. Try again.');
  assert.ok(!JSON.stringify(r).includes('boom'));
  assert.ok(!JSON.stringify(r).includes('at '));
});

test('a synchronous throw and a non-object error never escape', async () => {
  const { d } = setup({ a: () => { throw 'plain string'; }, b: () => { throw null; } });
  assert.equal((await d.handle('a', {}, {})).ok, false);
  assert.equal((await d.handle('b', {}, {})).ok, false);
});

test('an unknown tool is a plain refusal', async () => {
  const { d } = setup({});
  const r = await d.handle('format_disk', {}, {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_ARGUMENT');
});

test('a call that never finishes is stopped at the timeout (injected timers, no real wait)', async () => {
  const timers = [];
  const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; };
  const { d, log } = setup({ list: () => new Promise(() => {}), video_trim: () => new Promise(() => {}) }, { extra: { setTimer, clearTimer: () => {} } });
  const p = d.handle('list', {}, {});
  await new Promise((r) => setImmediate(r));
  assert.equal(timers[0].ms, 30000);
  timers[0].fn();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'That took too long and was stopped. Try again.');
  assert.equal(log[0].ok, false);
  const p2 = d.handle('video_trim', {}, {});
  await new Promise((r2) => setImmediate(r2));
  assert.equal(timers[1].ms, 600000);
  timers[1].fn();
  assert.equal((await p2).ok, false);
});

test('a failing action log never breaks the call', async () => {
  const bad = { tools: {}, record: async () => { throw new Error('disk full'); } };
  const d = createDispatcher({ host: [{ tools: { list: async () => 5 } }, bad], grants: { isPaused: () => false } });
  assert.deepEqual(await d.handle('list', {}, {}), { ok: true, result: 5 });
});

test('a command resent with the same id runs once and the first answer is replayed', async () => {
  let runs = 0;
  const { d, log } = setup({ move: async () => { runs += 1; await new Promise((r) => setTimeout(r, 20)); return { moved: runs }; } });
  const first = d.handle('move', { folder: 'Footage', path: 'a' }, { machineId: 'm1', requestId: 'cmd-1' });
  const resent = d.handle('move', { folder: 'Footage', path: 'a' }, { machineId: 'm1', requestId: 'cmd-1' });
  assert.deepEqual(await resent, await first);
  const later = await d.handle('move', { folder: 'Footage', path: 'a' }, { machineId: 'm1', requestId: 'cmd-1' });
  assert.deepEqual(later, { ok: true, result: { moved: 1 } });
  assert.equal(runs, 1);
  assert.equal(log.length, 1, 'the action log shows the call once');
  await d.handle('move', {}, { machineId: 'm1', requestId: 'cmd-2' });
  assert.equal(runs, 2, 'a different id runs again');
});

test('only the last 200 command ids are remembered', async () => {
  let runs = 0;
  const { d } = setup({ list: async () => { runs += 1; return {}; } });
  for (let i = 0; i < 205; i += 1) await d.handle('list', {}, { requestId: 'id-' + i });
  assert.equal(runs, 205);
  await d.handle('list', {}, { requestId: 'id-204' });
  assert.equal(runs, 205, 'a recent id is replayed');
  await d.handle('list', {}, { requestId: 'id-0' });
  assert.equal(runs, 206, 'an id older than 200 calls runs again');
});

test('set_paused pauses and resumes the Node even while it is paused, and computer_status shows it', async () => {
  const state = { paused: false };
  const grants = { isPaused: () => state.paused, setPaused: (v) => { state.paused = !!v; }, list: () => [{ label: 'Footage', path: '/x' }] };
  const d = createDispatcher({ host: [{ tools: { list: async () => ({ entries: [] }) } }], grants });
  assert.deepEqual(await d.handle('set_paused', { paused: true }, { requestId: 'a' }), { ok: true, result: { paused: true } });
  assert.equal((await d.handle('list', { folder: 'Footage' }, { requestId: 'b' })).error.code, 'PAUSED');
  const status = await d.handle('computer_status', {}, { requestId: 'c' });
  assert.equal(status.result.paused, true);
  assert.deepEqual(status.result.folders, [{ label: 'Footage', path: '/x' }]);
  assert.deepEqual(await d.handle('set_paused', { paused: false }, { requestId: 'd' }), { ok: true, result: { paused: false } });
  assert.equal((await d.handle('list', { folder: 'Footage' }, { requestId: 'e' })).ok, true);
  assert.equal((await d.handle('set_paused', { paused: 'maybe' }, { requestId: 'f' })).error.code, 'BAD_ARGUMENT');
});
