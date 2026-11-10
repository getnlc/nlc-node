'use strict';
// A shared folder the person moves or renames keeps working (HF-2026-11-10-19).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGrants } = require('../../lib/nlc-node/grants.cjs');
const { createPathGuard } = require('../../lib/nlc-node/path-guard.cjs');
const { createDispatcher } = require('../../lib/nlc-node/dispatcher.cjs');

function setup() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hf19-')));
  const home = path.join(root, 'home', 'nika');
  for (const d of ['Desktop', 'Documents']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const stateDir = path.join(root, 'state');
  const grants = createGrants({ stateDir, homeDir: home });
  const guard = createPathGuard({ grants });
  return { root, home, grants, guard, stateDir };
}

test('a renamed and moved folder is found again, keeps its files and its label follows the new name', async () => {
  const { home, grants, guard } = setup();
  const old = path.join(home, 'Documents', 'Agent Office NLC');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'clip.txt'), 'hello');
  await grants.add(old);
  assert.ok(grants.list()[0].id, 'identity recorded');
  fs.renameSync(old, path.join(home, 'Desktop', 'Video NLC'));
  const hit = await guard.resolve('Agent Office NLC', 'clip.txt');
  assert.equal(fs.readFileSync(hit.realPath, 'utf8'), 'hello');
  assert.equal(grants.list()[0].label, 'Video NLC');
  assert.equal(grants.list()[0].path, path.join(home, 'Desktop', 'Video NLC'));
  const again = await guard.resolve('Video NLC', 'clip.txt');
  assert.equal(again.realPath, hit.realPath);
  const saved = JSON.parse(fs.readFileSync(grants.file, 'utf8'));
  assert.equal(saved.grants[0].path, path.join(home, 'Desktop', 'Video NLC'));
});

test('a folder renamed in place is found again', async () => {
  const { home, grants, guard } = setup();
  const old = path.join(home, 'Desktop', 'Footage');
  fs.mkdirSync(old);
  await grants.add(old);
  fs.renameSync(old, path.join(home, 'Desktop', 'Footage 2026'));
  const hit = await guard.resolve('Footage', '');
  assert.equal(hit.realPath, path.join(home, 'Desktop', 'Footage 2026'));
});

test('a grant saved before identities existed gets one when its folder is next opened, then follows a move', async () => {
  const { home, grants, stateDir } = setup();
  const old = path.join(home, 'Documents', 'Old');
  fs.mkdirSync(old);
  await grants.add(old);
  const saved = JSON.parse(fs.readFileSync(grants.file, 'utf8'));
  delete saved.grants[0].id;
  fs.writeFileSync(grants.file, JSON.stringify(saved));
  const reloaded = createGrants({ stateDir, homeDir: home });
  const guard2 = createPathGuard({ grants: reloaded });
  assert.equal(reloaded.list()[0].id, '');
  await guard2.resolve('Old', '');
  assert.ok(reloaded.list()[0].id);
  fs.renameSync(old, path.join(home, 'Desktop', 'Old'));
  const hit = await guard2.resolve('Old', '');
  assert.equal(hit.realPath, path.join(home, 'Desktop', 'Old'));
});

test('a folder that is really gone tells the agent to ask for it', async () => {
  const { home, grants, guard } = setup();
  const old = path.join(home, 'Documents', 'Gone');
  fs.mkdirSync(old);
  await grants.add(old);
  fs.rmSync(old, { recursive: true });
  await assert.rejects(() => guard.resolve('Gone', ''), (error) => error.code === 'NOT_FOUND' && /ask_for_folder/.test(error.message));
});

test('ask_for_folder opens the chooser through the dispatcher and answers with what was shared', async () => {
  const dispatcher = createDispatcher({ host: [], grants: { isPaused: () => false, list: () => [] }, askForFolder: async () => ({ shared: true, folder: 'Videos' }) });
  assert.deepEqual(await dispatcher.handle('ask_for_folder', {}, {}), { ok: true, result: { shared: true, folder: 'Videos' } });
});

test('ask_for_folder is refused while the customer has paused file access', async () => {
  const dispatcher = createDispatcher({ host: [], grants: { isPaused: () => true, list: () => [] }, askForFolder: async () => ({ shared: true }) });
  const out = await dispatcher.handle('ask_for_folder', {}, {});
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'PAUSED');
});
