'use strict';
// An assistant on the customer's computer shares a folder by naming it (no dialog), through the same guarded grants.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGrants } = require('../../lib/nlc-node/grants.cjs');
const { createWindow } = require('../../lib/nlc-node/window.cjs');
const { buildLinkFiles } = require('../../lib/nlc-node/link-page-render.cjs');

function boot(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-agentfolder-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const work = path.join(home, 'Documents', 'Projects');
  fs.mkdirSync(work, { recursive: true });
  const grants = createGrants({ stateDir: path.join(base, 'state'), homeDir: home, platform: process.platform, env: { ...process.env, HOME: home, USERPROFILE: home } });
  const connectionState = { getState: () => 'connected', pair: async () => {}, onChange() {} };
  const win = createWindow({ grants, actionLog: { tools: { log_recent: async () => [] } }, connectionState, addFolder: async () => { throw new Error('the dialog must not open'); } });
  return { grants, win, work, home };
}

test('AF1: a named folder is shared with no dialog, and naming it again changes nothing', async (t) => {
  const { grants, win, work } = boot(t);
  const first = await win.windowApi('POST', '/v1/window/folders/add', { path: work });
  assert.equal(first.json.ok, true);
  assert.equal(first.json.label, 'Projects');
  const second = await win.windowApi('POST', '/v1/window/folders/add', { path: work });
  assert.equal(second.json.ok, true);
  assert.equal(grants.list().length, 1);
});

test('AF2: the home folder, a missing folder and a file are refused in plain words and nothing is shared', async (t) => {
  const { grants, win, home, work } = boot(t);
  const file = path.join(work, 'a.txt'); fs.writeFileSync(file, 'x');
  for (const p of [home, path.join(home, 'nope'), file]) {
    const out = await win.windowApi('POST', '/v1/window/folders/add', { path: p });
    assert.equal(out.json.ok, false, p);
    assert.ok(out.json.message && !/\n\s+at /.test(out.json.message));
  }
  assert.equal(grants.list().length, 0);
});

test('AF3: the assistant page tells an assistant to ask which folders and gives a share step for Mac and Windows', () => {
  const files = buildLinkFiles({ mode: 'vps', origin: 'https://nlc.example.com', version: '0.1.0', commit: '', sha256: {} });
  const doc = JSON.parse(files['install.json']);
  for (const osName of ['macos', 'windows']) {
    const step = doc.steps.find((s) => s.os === osName && s.id === 'share-folder');
    assert.ok(step && step.command.includes('/v1/window/folders/add') && step.command.includes('<ABSOLUTE-FOLDER-PATH>'));
  }
  assert.ok(doc.ask_user_first.some((q) => /Which folders/.test(q)));
  assert.match(files['llms.txt'], /## Share the folders the user named/);
});
