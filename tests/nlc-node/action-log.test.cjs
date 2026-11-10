'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODULE_API_VERSION } = require('../../lib/nlc-node/identity.cjs');
const { validateDescriptor } = require('../../lib/nlc-node/module-contract.cjs');
const actionLog = require('../../lib/nlc-node/modules/action-log.cjs');

function fresh(extra) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-actlog-'));
  const inst = actionLog.create({ stateDir, ...(extra || {}) });
  return { stateDir, inst };
}

test('descriptor is a valid module with id action-log', () => {
  const d = validateDescriptor(actionLog);
  assert.equal(d.manifest.id, 'action-log');
  assert.equal(d.manifest.apiVersion, MODULE_API_VERSION);
});

test('record then log_recent shows the delete with time, tool and path, newest first', async () => {
  const { inst } = fresh();
  inst.record({ ts: '2026-10-24T10:00:00.000Z', machineId: 'm1', tool: 'list', folder: 'Footage', path: '', ok: true });
  inst.record({ ts: '2026-10-24T10:01:00.000Z', machineId: 'm1', tool: 'delete', folder: 'Footage', path: 'Day 1/C0001.MP4', ok: true });
  const out = await inst.tools.log_recent({ limit: 10 }, { machineId: 'm1', requestId: 'r' });
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0].tool, 'delete');
  assert.equal(out.entries[0].path, 'Day 1/C0001.MP4');
  assert.equal(out.entries[0].ts, '2026-10-24T10:01:00.000Z');
  assert.equal(out.entries[1].tool, 'list');
});

test('failed call keeps its code; file contents and unknown fields never reach disk', async () => {
  const { inst, stateDir } = fresh();
  inst.record({ tool: 'write_text', folder: 'F', path: 'a.txt', ok: false, code: 'EXISTS', content: 'SECRET-BODY', result: { text: 'SECRET-BODY' }, args: { content: 'SECRET-BODY' } });
  const raw = fs.readFileSync(path.join(stateDir, 'actions.jsonl'), 'utf8');
  assert.ok(!raw.includes('SECRET-BODY'));
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.code, 'EXISTS');
  assert.equal(e.ok, false);
  assert.ok(e.ts, 'timestamp filled in');
  assert.deepEqual(Object.keys(e).sort(), ['code', 'folder', 'ok', 'path', 'tool', 'ts'].sort());
});

test('limit is clamped to 200 and defaults sensibly; bad values accepted', async () => {
  const { inst } = fresh();
  for (let i = 0; i < 250; i++) inst.record({ tool: 'list', folder: 'F', path: 'p' + i, ok: true });
  assert.equal((await inst.tools.log_recent({ limit: 9999 }, {})).entries.length, 200);
  assert.equal((await inst.tools.log_recent({}, {})).entries.length, 50);
  assert.equal((await inst.tools.log_recent({ limit: '7' }, {})).entries.length, 7);
  assert.equal((await inst.tools.log_recent({ limit: -3 }, {})).entries.length, 50);
});

test('rotation: file never exceeds the cap, at most 5 files kept, newest entries survive', async () => {
  const { inst, stateDir } = fresh({ maxBytes: 2000, maxFiles: 5 });
  for (let i = 0; i < 200; i++) inst.record({ tool: 'list', folder: 'F', path: 'file-number-' + i, ok: true });
  const files = fs.readdirSync(stateDir).filter((f) => f.startsWith('actions'));
  assert.ok(files.length <= 5, files.join());
  assert.ok(files.length > 1, 'rotated at least once');
  for (const f of files) assert.ok(fs.statSync(path.join(stateDir, f)).size <= 2000 + 400, f);
  const out = await inst.tools.log_recent({ limit: 3 }, {});
  assert.equal(out.entries[0].path, 'file-number-199');
});

test('survives a corrupt line and a new instance reads the old log', async () => {
  const { stateDir, inst } = fresh();
  inst.record({ tool: 'copy', folder: 'F', path: 'a', ok: true });
  fs.appendFileSync(path.join(stateDir, 'actions.jsonl'), 'not json\n');
  const again = actionLog.create({ stateDir });
  const out = await again.tools.log_recent({ limit: 10 }, {});
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].tool, 'copy');
});

test('empty log returns an empty list, no error', async () => {
  const { inst } = fresh();
  assert.deepEqual((await inst.tools.log_recent({}, {})).entries, []);
});

test('start/health/stop follow the module contract', async () => {
  const { inst } = fresh();
  await inst.start();
  const h = await inst.health();
  assert.equal(h.ok !== false, true);
  await inst.stop();
});
