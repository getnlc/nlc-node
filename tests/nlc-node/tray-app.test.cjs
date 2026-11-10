'use strict';
// PC-2026-11-10-03: NLC Node is a real menu-bar / tray app. Light and dark follow the system, plain words,
// one NLC folder on the Desktop shared automatically, per-folder Stop sharing / Choose a different folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const visible = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const scratch = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `nlc-tray-${name}-`));

test('light and dark: the window follows the system, light by default and dark when the system is dark', () => {
  const tokens = read('lib/nlc-node/ui/tokens.css');
  assert.match(tokens, /color-scheme:\s*light dark/);
  assert.match(tokens, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  const light = /:root\s*\{([^}]*)\}/.exec(tokens)[1];
  assert.match(light, /--bg:\s*#f/i, 'the first (default) colour set is light');
  const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(tokens);
  assert.ok(dark, 'a dark set sits inside the dark media block');
  assert.match(dark[1], /--bg:\s*#0d1117/i);
  assert.doesNotMatch(read('lib/nlc-node/ui/window.css'), /#[0-9a-f]{3,8}\b/i, 'window.css takes every colour from the tokens');
});

test('Mac: the menu-bar app shows the window itself (a web view in a popover), not a browser tab', () => {
  const swift = read('installer/nlc-node/macos/Launcher.swift');
  assert.match(swift, /import WebKit/);
  assert.match(swift, /WKWebView/);
  assert.match(swift, /NSPopover/);
  assert.doesNotMatch(swift, /NSWorkspace\.shared\.open\(url\)/);
  assert.match(read('installer/nlc-node/macos/build.sh'), /-framework WebKit/);
  assert.match(read('installer/nlc-node/macos/Info.plist'), /NSAllowsLocalNetworking/);
});

test('Windows: the tray icon opens the window as an app window, never a browser tab', () => {
  const cpp = read('installer/nlc-node/windows/launcher.cpp');
  assert.match(cpp, /Shell_NotifyIconW/);
  assert.match(cpp, /--app=/);
});

test('grants.replace: points a shared folder at a different folder, keeps its name, deletes nothing', async () => {
  const { createGrants } = require('../../lib/nlc-node/grants.cjs');
  const home = scratch('home'); const state = scratch('state');
  const first = path.join(home, 'Videos'); const second = path.join(home, 'Projects');
  fs.mkdirSync(first); fs.mkdirSync(second); fs.writeFileSync(path.join(first, 'keep.txt'), 'x');
  const grants = createGrants({ stateDir: state, homeDir: home });
  const added = await grants.add(first);
  const replaced = await grants.replace(added.label, second);
  assert.equal(replaced.label, added.label);
  assert.equal(fs.realpathSync(replaced.path), fs.realpathSync(second));
  assert.equal(grants.list().length, 1);
  assert.ok(fs.existsSync(path.join(first, 'keep.txt')), 'the old folder and its files are untouched');
  await assert.rejects(() => grants.replace(added.label, home), /Choose a folder for your work/);
  await assert.rejects(() => grants.replace('Nope', second), /not shared/);
});

test('Your NLC folder: made on the Desktop and shared once; Stop sharing is respected afterwards', async () => {
  const { createGrants } = require('../../lib/nlc-node/grants.cjs');
  const { ensureNlcFolder } = require('../../lib/nlc-node/nlc-folder.cjs');
  const home = scratch('home'); const state = scratch('state');
  const grants = createGrants({ stateDir: state, homeDir: home });
  const out = await ensureNlcFolder({ grants, homeDir: home, stateDir: state });
  assert.equal(out.path, path.join(home, 'Desktop', 'NLC'));
  assert.ok(fs.statSync(out.path).isDirectory());
  assert.equal(grants.list().length, 1);
  assert.equal(grants.list()[0].label, 'NLC');
  await ensureNlcFolder({ grants, homeDir: home, stateDir: state });
  assert.equal(grants.list().length, 1, 'asking twice shares it once');
  grants.remove('NLC');
  await ensureNlcFolder({ grants, homeDir: home, stateDir: state });
  assert.equal(grants.list().length, 0, 'a person who stopped sharing it is not overruled');
  assert.ok(fs.existsSync(out.path), 'stopping the share deletes nothing');
});

test('opening a folder or NLC Central uses the computer\'s own opener, and only a secure address', () => {
  const { openFolder, openAddress } = require('../../lib/nlc-node/os-open.cjs');
  const runs = [];
  const run = (file, args) => { runs.push([file, args]); return { on() {}, unref() {} }; };
  openFolder('/Users/amy/Desktop/NLC', 'darwin', run);
  openFolder('C:\\Users\\amy\\Desktop\\NLC', 'win32', run);
  openAddress('https://central.example.test/installations', 'darwin', run);
  assert.deepEqual(runs[0], ['open', ['/Users/amy/Desktop/NLC']]);
  assert.deepEqual(runs[1], ['explorer.exe', ['C:\\Users\\amy\\Desktop\\NLC']]);
  assert.deepEqual(runs[2], ['open', ['https://central.example.test/installations']]);
  assert.throws(() => openAddress('file:///etc/passwd', 'darwin', run), /secure web address/);
});

function windowWith({ state, folders, nlcFolder, calls = [] }) {
  const { createWindow } = require('../../lib/nlc-node/window.cjs');
  const list = folders.map((p) => ({ label: path.basename(p), path: p, addedAt: 't' }));
  let paused = false;
  const grants = {
    list: () => list.slice(), isPaused: () => paused, setPaused: (v) => { paused = v; },
    remove: (label) => { const i = list.findIndex((g) => g.label === label); if (i >= 0) list.splice(i, 1); },
    replace: async (label, to) => { const g = list.find((x) => x.label === label); g.path = to; return { ...g }; },
    onChange() {},
  };
  const connectionState = { getState: () => state, async pair() {}, async requestLink() {}, onChange() {} };
  return createWindow({
    grants, actionLog: { tools: { log_recent: async () => [] } }, connectionState, machineName: "Amy's MacBook",
    nlcFolder, openFolder: async (p) => { calls.push(['open-folder', p]); }, openCentral: async () => { calls.push(['open-central']); },
    pickFolderPath: async () => '/Users/amy/Elsewhere',
  });
}

test('window, connected: Your NLC folder, each folder with Stop sharing / Choose a different folder, Share another folder', async () => {
  const nlc = '/Users/amy/Desktop/NLC';
  const calls = [];
  const win = windowWith({ state: 'connected', folders: [nlc, '/Users/amy/Footage'], nlcFolder: nlc, calls });
  const html = await win.renderView();
  const text = visible(html);
  assert.match(text, /Your NLC folder/);
  assert.match(text, /Put files here and your agents can use them/);
  assert.equal((html.match(/data-action="open-folder"/g) || []).length, 2);
  assert.equal((html.match(/data-action="remove"/g) || []).length, 2);
  assert.equal((html.match(/data-action="replace"/g) || []).length, 2);
  assert.match(text, /Stop sharing/);
  assert.match(text, /Choose a different folder/);
  assert.match(text, /Share another folder/);
  assert.match(text, /Footage/);
  assert.doesNotMatch(text, /Remove|Add folder|loopback|127\.0\.0\.1|token/i);
  assert.doesNotMatch(html, /data-action="open-central"/, 'no Central button once connected');
  const out = await win.windowApi('POST', '/v1/window/folders/open', { label: 'NLC' });
  assert.equal(out.json.ok, true);
  assert.deepEqual(calls[0], ['open-folder', nlc]);
});

test('window: Choose a different folder points the shared folder at the new place', async () => {
  const win = windowWith({ state: 'connected', folders: ['/Users/amy/Footage'], nlcFolder: '/Users/amy/Desktop/NLC' });
  const out = await win.windowApi('POST', '/v1/window/folders/replace', { label: 'Footage' });
  assert.equal(out.json.ok, true);
  assert.match(await win.renderView(), /\/Users\/amy\/Elsewhere/);
});

test('window, waiting for approval: one button opens NLC Central at the Allow step', async () => {
  const calls = [];
  const win = windowWith({ state: 'asking', folders: [], nlcFolder: '/Users/amy/Desktop/NLC', calls });
  const html = await win.renderView();
  assert.match(visible(html), /Open NLC Central/);
  assert.equal((html.match(/data-action="open-central"/g) || []).length, 1);
  const out = await win.windowApi('POST', '/v1/window/open-central', {});
  assert.equal(out.json.ok, true);
  assert.deepEqual(calls[0], ['open-central']);
});

test('the app makes the NLC folder when it starts and opens things through the computer\'s own opener', () => {
  const app = read('lib/nlc-node/app.cjs');
  assert.match(app, /ensureNlcFolder/);
  assert.match(app, /HOSTED_ORIGIN[^;]*\/installations/);
});
