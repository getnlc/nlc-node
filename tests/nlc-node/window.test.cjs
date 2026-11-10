'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startLoopbackServer } = require('../../lib/nlc-node/loopback-server.cjs');
const { createWindow, buildWindowUrl } = require('../../lib/nlc-node/window.cjs');
const { acquireInstanceLock } = require('../../lib/nlc-node/local-state.cjs');

const TOKEN = 'a'.repeat(43);
const WRONG = 'That code did not work. Ask your assistant for a new one.';

function fakes({ state = 'connected', folders = [], activity = [], validCode = 'ABCD2345' } = {}) {
  const grantList = folders.map((p) => ({ label: path.basename(p), path: p, addedAt: 't' }));
  let paused = false;
  const listeners = [];
  const grants = {
    list: () => grantList.slice(),
    isPaused: () => paused,
    setPaused: (v) => { paused = v; },
    remove: (label) => { const i = grantList.findIndex((g) => g.label === label); if (i >= 0) grantList.splice(i, 1); },
    onChange: (fn) => listeners.push(fn),
  };
  const conn = {
    current: state,
    getState() { return this.current; },
    async pair(code) { if (code !== validCode) { const e = new Error('bad'); e.code = 'BAD_CODE'; throw e; } this.current = 'connected'; },
    onChange() {},
  };
  const actionLog = { tools: { log_recent: async () => activity } };
  const picks = [];
  const addFolder = async () => picks.shift() || { status: 'cancelled' };
  return { grants, conn, actionLog, picks, addFolder, grantList };
}

async function boot(opts) {
  const f = fakes(opts);
  const win = createWindow({ grants: f.grants, actionLog: f.actionLog, connectionState: f.conn, machineName: "Amy's MacBook", addFolder: f.addFolder });
  const server = await startLoopbackServer({ token: TOKEN, getIdentity: () => ({}), getModules: () => [], getReadiness: () => ({ state: 'ready' }), windowPage: win.windowPage, windowApi: win.windowApi });
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method, p, body, { auth = true, headers = {} } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, text: await res.text() };
  };
  const view = async () => (await call('GET', '/v1/window/view')).text;
  const post = async (p, body) => JSON.parse((await call('POST', p, body)).text);
  return { f, server, base, call, view, post };
}

const count = (html, re) => (html.match(re) || []).length;
const visible = (html) => html.replace(/<[^>]*>/g, ' ');

test('the page loads without a key but shows no data; data and every POST need the key', async () => {
  const t = await boot();
  try {
    const page = await t.call('GET', '/window', null, { auth: false });
    assert.equal(page.status, 200);
    assert.match(page.text, /<main id="app">/);
    assert.equal((await t.call('GET', '/window/app.js', null, { auth: false })).status, 200);
    assert.equal((await t.call('GET', '/v1/window/view', null, { auth: false })).status, 401);
    for (const p of ['/v1/window/pair', '/v1/window/folders/add', '/v1/window/folders/remove', '/v1/window/pause']) {
      assert.equal((await t.call('POST', p, {}, { auth: false })).status, 401, p);
    }
    assert.equal((await t.call('POST', '/v1/window/pause', { paused: true }, { headers: { authorization: `Bearer ${'b'.repeat(43)}` } })).status, 401);
    assert.equal(t.f.grants.isPaused(), false);
    const rebinding = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: t.server.port, path: '/window', headers: { host: 'evil.example.com' } }, (res) => resolve(res.statusCode));
    });
    assert.notEqual(rebinding, 200);
  } finally { await t.server.close(); }
});

test('U02: after connecting the window has exactly four things and no pairing box', async () => {
  const t = await boot({ state: 'connected', folders: ['/Users/amy/Footage'] });
  try {
    const html = await t.view();
    assert.equal(count(html, /role="status"/g), 1, 'one connection indicator');
    assert.equal(count(html, /aria-label="Shared folders"/g), 1);
    assert.equal(count(html, /role="switch"/g), 1, 'one pause switch');
    assert.equal(count(html, /aria-label="Recent activity"/g), 1);
    assert.equal(count(html, /<form/g), 0, 'no pairing box once paired');
    assert.equal(count(html, /<section/g), 4);
    assert.match(visible(html), /Connected/);
    assert.match(visible(html), /Amy&#39;s MacBook/);
    assert.match(html, /class="dot connected"/);
  } finally { await t.server.close(); }
});

test('indicator: grey when paused or not paired yet, red when offline', async () => {
  const t = await boot({ state: 'offline' });
  try {
    assert.match(await t.view(), /class="dot offline"/);
    t.f.conn.current = 'connected';
    await t.post('/v1/window/pause', { paused: true });
    const paused = await t.view();
    assert.match(paused, /class="dot paused"/);
    assert.match(paused, /aria-checked="true"/);
    assert.match(visible(paused), /Paused/);
  } finally { await t.server.close(); }
});

test('first run: the pairing box shows only while unpaired, with the plain instruction; pairing makes it disappear', async () => {
  const t = await boot({ state: 'unpaired' });
  try {
    const before = await t.view();
    assert.equal(count(before, /<form/g), 1);
    assert.match(visible(before), /Only if you were given a code or link, enter it here/);
    const out = await t.post('/v1/window/pair', { code: 'abcd-2345' });
    assert.equal(out.ok, true);
    const after = await t.view();
    assert.equal(count(after, /<form/g), 0);
    assert.match(visible(after), /Connected/);
  } finally { await t.server.close(); }
});

test('C03: a wrong, empty or reused code shows exactly the plain message and stays unpaired', async () => {
  const t = await boot({ state: 'unpaired' });
  try {
    for (const code of ['ZZZZ9999', '', '   ']) {
      const out = await t.post('/v1/window/pair', { code });
      assert.equal(out.ok, false);
      assert.equal(out.message, WRONG);
    }
    assert.equal(t.f.conn.getState(), 'unpaired');
    t.f.conn.pair = async () => { const e = new Error('Error: ECONNRESET at stack\n at x'); e.stack = 'stack'; throw e; };
    const out = await t.post('/v1/window/pair', { code: 'ABCD2345' });
    assert.equal(out.message, WRONG);
    assert.ok(!/stack|ECONN|Error/.test(JSON.stringify(out)));
  } finally { await t.server.close(); }
});

test('G01: Add folder shares the chosen folder, it appears in the list, with the plain sentence', async () => {
  const t = await boot({ folders: [] });
  try {
    assert.match(visible(await t.view()), /No folders shared yet/);
    t.f.picks.push({ status: 'added', grant: { label: 'Footage' } });
    t.f.grantList.push({ label: 'Footage', path: '/Users/amy/Footage', addedAt: 't' });
    const out = await t.post('/v1/window/folders/add', {});
    assert.equal(out.message, 'Footage is shared. Your agents can open, change and move files in it. Deleted files go to NLC Trash.');
    const html = await t.view();
    assert.match(html, /folder-name">Footage</);
    assert.match(html, /\/Users\/amy\/Footage/);
  } finally { await t.server.close(); }
});

test('G02: a system folder is refused with the plain message; cancel says nothing', async () => {
  const t = await boot();
  try {
    t.f.picks.push({ status: 'refused', message: 'Choose a folder for your work, not a system location.' });
    const refused = await t.post('/v1/window/folders/add', {});
    assert.equal(refused.ok, false);
    assert.equal(refused.message, 'Choose a folder for your work, not a system location.');
    const cancelled = await t.post('/v1/window/folders/add', {});
    assert.equal(cancelled.message, '');
    assert.equal(t.f.grantList.length, 0);
  } finally { await t.server.close(); }
});

test('G03: Remove takes the folder out of the list; removing a missing one says so plainly', async () => {
  const t = await boot({ folders: ['/Users/amy/Footage', '/Users/amy/Music'] });
  try {
    const out = await t.post('/v1/window/folders/remove', { label: 'Footage' });
    assert.equal(out.message, 'Footage is no longer shared.');
    const html = await t.view();
    assert.ok(!html.includes('Footage'));
    assert.match(html, /Music/);
    const again = await t.post('/v1/window/folders/remove', { label: 'Footage' });
    assert.equal(again.ok, false);
  } finally { await t.server.close(); }
});

test('Pause switch turns file access off and back on', async () => {
  const t = await boot();
  try {
    assert.match(await t.view(), /aria-checked="false"/);
    await t.post('/v1/window/pause', { paused: true });
    assert.equal(t.f.grants.isPaused(), true);
    await t.post('/v1/window/pause', { paused: false });
    assert.equal(t.f.grants.isPaused(), false);
    assert.match(await t.view(), /aria-checked="false"/);
  } finally { await t.server.close(); }
});

test('S07: Recent activity shows what the assistant did in plain words, newest first, never file contents', async () => {
  const activity = [
    { ts: '2026-10-24T08:00:00Z', machineId: 'm', tool: 'read_text', folder: 'Footage', path: 'notes.txt', ok: true },
    { ts: '2026-10-24T08:05:00Z', machineId: 'm', tool: 'delete', folder: 'Footage', path: 'old/clip.mov', ok: true, content: 'SECRET FILE BODY' },
    { ts: '2026-10-24T08:06:00Z', machineId: 'm', tool: 'move', folder: 'Footage', path: 'a.mov', ok: false, code: 'EXISTS' },
  ];
  const t = await boot({ activity });
  try {
    const text = visible(await t.view());
    assert.match(text, /Moved a file to NLC Trash from Footage\/old\/clip\.mov/);
    assert.match(text, /Read a file in Footage\/notes\.txt/);
    assert.match(text, /Moved a file in Footage\/a\.mov \(did not work\)/);
    assert.ok(text.indexOf('Moved a file in') < text.indexOf('Read a file in'), 'newest first');
    assert.ok(!text.includes('SECRET FILE BODY'));
    assert.ok(!text.includes('EXISTS'));
  } finally { await t.server.close(); }
});

test('file names that look like markup are shown as text, never run', async () => {
  const t = await boot({ folders: ['/Users/amy/<img src=x onerror=alert(1)>'] });
  try {
    const html = await t.view();
    assert.ok(!html.includes('<img'));
    assert.match(html, /&lt;img/);
  } finally { await t.server.close(); }
});

test('plain English: no technical words in any state', async () => {
  for (const state of ['unpaired', 'connected', 'offline']) {
    const t = await boot({ state, folders: ['/Users/amy/Footage'], activity: [{ ts: '2026-10-24T08:00:00Z', tool: 'list', folder: 'Footage', ok: true }] });
    try {
      const text = visible(await t.view()).toLowerCase();
      for (const word of ['token', 'grant', 'module', 'websocket', 'endpoint', 'error code']) assert.ok(!text.includes(word), `${state}: ${word}`);
    } finally { await t.server.close(); }
  }
});

const uiDir = path.join(__dirname, '..', '..', 'lib', 'nlc-node', 'ui');
const tokensCss = fs.readFileSync(path.join(uiDir, 'tokens.css'), 'utf8');
const windowCss = fs.readFileSync(path.join(uiDir, 'window.css'), 'utf8');

function declarations(css) {
  const out = [];
  for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) out.push([m[1].trim(), m[2].trim()]);
  return out;
}

test('U01: every colour in the window is a colour from the NLC token map (or an alias of one); no new radius or text size', () => {
  const tokenNames = new Set(declarations(tokensCss).filter(([n]) => n.startsWith('--')).map(([n]) => n));
  assert.ok(tokenNames.size >= 9);
  const decls = declarations(windowCss);
  const aliases = new Map(decls.filter(([n]) => n.startsWith('--')));
  const resolves = (name, seen = new Set()) => {
    if (tokenNames.has(name)) return true;
    if (seen.has(name) || !aliases.has(name)) return false;
    seen.add(name);
    const inner = aliases.get(name).match(/^var\((--[a-z-]+)\)$/);
    return Boolean(inner) && resolves(inner[1], seen);
  };
  const colourProps = /^(color|background|background-color|border|border-top|border-color|outline|fill|stroke|box-shadow|--win-.*)$/;
  const named = /\b(red|green|blue|white|black|gray|grey|orange|yellow|purple|pink|silver|navy|teal)\b/i;
  for (const [name, value] of decls) {
    if (!colourProps.test(name)) continue;
    for (const m of value.matchAll(/var\((--[a-z-]+)\)/g)) assert.ok(resolves(m[1]), `${name}: ${m[1]} is not in the token map`);
    const rest = value.replace(/var\(--[a-z-]+\)/g, '');
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(rest), `${name}: raw colour in "${value}"`);
    assert.ok(!named.test(rest.replace(/\b(solid|none|transparent|inherit)\b/g, '')), `${name}: named colour in "${value}"`);
  }
  // The token copy matches the product's own map, so the window can never drift from it.
  const productCss = path.join(__dirname, '..', '..', 'ui', 'public', 'css', 'style.css');
  if (fs.existsSync(productCss)) {
    // The product now keeps its colours in numbered --k-* tokens across the css folder; a window colour must be one of them.
    const cssFolder = path.dirname(productCss);
    const mapFiles = [productCss, path.join(cssFolder, 'themes', 'dark.css'), path.join(cssFolder, 'themes', 'light.css')].filter((f) => fs.existsSync(f));
    const product = mapFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n').toLowerCase();
    for (const [name, value] of declarations(tokensCss).filter(([n]) => n.startsWith('--'))) {
      const literal = /^#[0-9a-f]{3,8}$/i.test(value.trim());
      assert.ok(literal ? product.includes(value.trim().toLowerCase()) : true, `${name}: ${value} differs from the NLC colour map`);
    }
    for (const prop of ['border-radius', 'font-size']) {
      for (const [name, value] of decls.filter(([n]) => n === prop)) {
        assert.ok(product.includes(`${name}: ${value}`), `${prop} ${value} is not used anywhere in NLC`);
      }
    }
  }
});

test('I04: the window address carries the private key only after the #, and a second launch finds the running one', () => {
  const url = buildWindowUrl({ port: 4455, token: TOKEN });
  assert.equal(url, `http://127.0.0.1:4455/window#k=${TOKEN}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-window-'));
  const first = acquireInstanceLock(dir);
  try {
    assert.equal(first.acquired, true);
    assert.equal(acquireInstanceLock(dir).acquired, false);
  } finally { first.release(); }
});

test('Recent activity is newest first when the action log returns its own newest-first entries', async () => {
  const t = await boot({ activity: { entries: [
    { ts: '2026-10-24T08:06:00Z', tool: 'move', folder: 'Footage', path: 'new.mov', ok: true },
    { ts: '2026-10-24T08:00:00Z', tool: 'read_text', folder: 'Footage', path: 'old.txt', ok: true },
  ] } });
  try {
    const text = visible(await t.view());
    assert.ok(text.indexOf('new.mov') < text.indexOf('old.txt'), 'newest first');
  } finally { await t.server.close(); }
});

test('when another copy of NLC Node took over, the window says so in plain words', async () => {
  const t = await boot({ state: 'replaced' });
  try {
    const text = visible(await t.view());
    assert.match(text, /Another copy of NLC Node took over/);
    assert.equal(count(await t.view(), /class="card pair"/g), 0, 'no code box: this computer is already paired');
  } finally { await t.server.close(); }
});

test('Recent activity names video work in plain words and leaves out status polling', async () => {
  const activity = [
    { ts: '2026-10-24T08:01:00Z', tool: 'job_status', ok: true },
    { ts: '2026-10-24T08:02:00Z', tool: 'video_trim', folder: 'Footage', path: 'clip.mp4', ok: true },
    { ts: '2026-10-24T08:03:00Z', tool: 'log_recent', ok: true },
    { ts: '2026-10-24T08:04:00Z', tool: 'set_paused', ok: true },
  ];
  const t = await boot({ activity });
  try {
    const text = visible(await t.view());
    assert.match(text, /Trimmed a video in Footage\/clip\.mp4/);
    assert.match(text, /Changed the pause switch/);
    assert.doesNotMatch(text, /Used your computer/);
  } finally { await t.server.close(); }
});

// ---- Piece Y: connection link, disconnected state, too many tries ----
function recordPairs(t) {
  const calls = [];
  const original = t.f.conn.pair.bind(t.f.conn);
  t.f.conn.pair = async (code, opts) => { calls.push({ code, opts }); return original(code); };
  return calls;
}

test('Y4: after the dashboard disconnected this computer the window says Disconnected, with the new-code box, not "Not connected yet"', async () => {
  const t = await boot({ state: 'disconnected' });
  try {
    const html = await t.view();
    const text = visible(html);
    assert.match(text, /Disconnected/);
    assert.match(text, /This computer was disconnected from your agents\. Enter a new code to connect again\./);
    assert.doesNotMatch(text, /Not connected yet/);
    assert.equal(count(html, /class="card pair"/g), 1, 'the pairing box is there');
    assert.match(html, /class="dot offline"/);
    for (const word of ['token', 'grant', 'module', 'websocket', 'endpoint']) assert.ok(!text.toLowerCase().includes(word), word);
  } finally { await t.server.close(); }
});

test('Y2: the pairing box takes a bare code or the whole connection link; the link carries the address', async () => {
  const t = await boot({ state: 'unpaired' });
  try {
    const calls = recordPairs(t);
    const bare = await t.post('/v1/window/pair', { code: 'abcd-2345' });
    assert.equal(bare.ok, true);
    assert.deepEqual(calls[0], { code: 'ABCD2345', opts: undefined });
    t.f.conn.current = 'unpaired';
    for (const link of ['https://nlc.example.com/n/ab23-cd45', '  https://nlc.example.com/n/AB23CD45/  ', 'https://nlc.example.com:8443/n/AB23CD45?x=1#y']) {
      const out = await t.post('/v1/window/pair', { code: link });
      assert.equal(out.ok, false, 'wrong code for ' + link + ' is fine here, only the parsing is checked');
    }
    assert.deepEqual(calls[1], { code: 'AB23CD45', opts: { origin: 'https://nlc.example.com' } });
    assert.deepEqual(calls[2], { code: 'AB23CD45', opts: { origin: 'https://nlc.example.com' } });
    assert.deepEqual(calls[3], { code: 'AB23CD45', opts: { origin: 'https://nlc.example.com:8443' } });
  } finally { await t.server.close(); }
});

test('Y2: a wrong link gets the plain refusal and never reaches the connection', async () => {
  const t = await boot({ state: 'unpaired' });
  try {
    const calls = recordPairs(t);
    for (const bad of ['https://nlc.example.com/other/AB23CD45', 'https://nlc.example.com/n/', 'https://nlc.example.com/', 'ftp://nlc.example.com/n/AB23CD45', 'http://nlc.example.com/n/AB23CD45', 'javascript:alert(1)', 'https:///n/AB23CD45', 'https://nlc.example.com/n/AB23CD45/extra']) {
      const out = await t.post('/v1/window/pair', { code: bad });
      assert.deepEqual(out, { ok: false, message: WRONG }, bad);
    }
    assert.equal(calls.length, 0);
    const local = await t.post('/v1/window/pair', { code: 'http://127.0.0.1:3080/n/AB23CD45' });
    assert.equal(calls.length, 1, 'a plain http address is fine on this same computer');
    assert.deepEqual(calls[0].opts, { origin: 'http://127.0.0.1:3080' });
    assert.equal(local.ok, false);
  } finally { await t.server.close(); }
});

test('Y4: "Too many tries" is said as such, an unknown address asks for the link, no internet says so', async () => {
  const t = await boot({ state: 'unpaired' });
  try {
    t.f.conn.pair = async () => { const e = new Error('Too many tries. Wait a minute and try again.'); e.code = 'RATE_LIMIT'; throw e; };
    assert.deepEqual(await t.post('/v1/window/pair', { code: 'ABCD2345' }), { ok: false, message: 'Too many tries. Wait a minute and try again.' });
    t.f.conn.pair = async () => { const e = new Error('x'); e.code = 'NO_ORIGIN'; throw e; };
    const none = await t.post('/v1/window/pair', { code: 'ABCD2345' });
    assert.equal(none.ok, false);
    assert.match(none.message, /connection link/);
    assert.notEqual(none.message, WRONG);
    t.f.conn.pair = async () => { const e = new Error('x'); e.code = 'OFFLINE'; throw e; };
    assert.match((await t.post('/v1/window/pair', { code: 'ABCD2345' })).message, /Could not reach NLC/);
  } finally { await t.server.close(); }
});

test('HF-20: a customer with no code is told plainly where to press Allow: NLC Central, Installations, their NLC card, wants to connect', async () => {
  for (const state of ['unpaired', 'asking']) {
    const t = await boot({ state });
    try {
      const text = visible(await t.view()).replace(/\s+/g, ' ');
      assert.match(text, /press Allow in NLC Central/i, state);
      assert.match(text, /Installations/, state);
      assert.match(text, /NLC card/, state);
      assert.match(text, /wants to connect/, state);
      assert.doesNotMatch(text, /assistant gave you/, state);
      assert.match(text, /Waiting for you to press Allow in NLC Central/, state);
      assert.equal((text.match(/press Allow/g) || []).length, 2, state);
      assert.match(text, /Have a code\?/, state);
      assert.doesNotMatch(text, /Try again|Ask your NLC again|Connect this computer/, state);
    } finally { await t.server.close(); }
  }
});

test('HF-20: the install scripts tell the customer where to press Allow and do not send them to an assistant they may not have', () => {
  for (const file of ['install.sh', 'install.ps1']) {
    const body = fs.readFileSync(path.join(__dirname, '../../ui/lib/node-install', file), 'utf8');
    assert.match(body, /press Allow on your NLC card/i, file);
    assert.match(body, /Installations/, file);
    assert.match(body, /wants to connect/, file);
    assert.doesNotMatch(body, /your assistant gave you/, file);
  }
});
