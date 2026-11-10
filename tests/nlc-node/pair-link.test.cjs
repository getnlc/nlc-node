'use strict';
// Piece Y, driven the way a customer meets it: the real Node app with no address written into it, the real
// customer-server side, and the window's own pairing box. A connection link carries the address; a dashboard
// disconnect is shown as "Disconnected"; the rate limit is said in its own words.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createNodeApp } = require('../../lib/nlc-node/app.cjs');

const root = path.resolve(__dirname, '../..');
const uiRequire = createRequire(path.join(root, 'ui', 'package.json'));
const WRONG = 'That code did not work. Ask your assistant for a new one.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await cond(); if (v) return v; await sleep(20); }
  assert.fail('timed out waiting for ' + label);
}

async function startCustomerServer(dir, { exchangeLimitPerMinute = 100 } = {}) {
  const { createNodeBackend } = await import(pathToFileURL(path.join(root, 'ui/lib/node-backend.js')).href);
  const { createNodeWebSocketHandler } = await import(pathToFileURL(path.join(root, 'ui/lib/node-websocket.js')).href);
  const { registerNodePairingRoutes } = await import(pathToFileURL(path.join(root, 'ui/lib/node-pairing-routes.js')).href);
  const { isLocalRequest } = await import(pathToFileURL(path.join(root, 'ui/lib/request-origin.js')).href);
  const express = uiRequire('express');
  const backend = createNodeBackend({ dataFile: path.join(dir, 'node-machines.json') });
  const app = express();
  app.use(express.json());
  const authenticateRequest = (req, res) => {
    if (req.headers['x-test-owner'] !== 'owner') { res.status(401).json({ error: 'Unauthorized' }); return false; }
    req.auth = { sub: 'owner' };
    return true;
  };
  registerNodePairingRoutes({ app, backend, authenticateRequest, isLocalRequest, exchangeLimitPerMinute });
  const server = http.createServer(app);
  const wsHandler = createNodeWebSocketHandler({ backend });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://x').pathname === '/node-ws') wsHandler.handleUpgrade(request, socket, head); else socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    backend, port, origin: `http://127.0.0.1:${port}`,
    async dashboard(method, route, body) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'x-test-owner': 'owner', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    async stop() { wsHandler.close(); backend.close(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
}

function makeNode(dir, extra = {}) {
  const stateRoot = path.join(dir, 'state');
  const protector = { protect: async (b) => Buffer.from(b), unprotect: async (b) => Buffer.from(b) };
  return createNodeApp({
    stateRoot, homeDir: path.join(dir, 'home'), env: {}, machineName: 'Jocelyn PC', reportedOs: 'win32', protector,
    addFolder: async () => ({ status: 'cancelled' }), resolveFfmpeg: () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: 'test' }),
    indicatorEveryMs: 200, ...extra,
  });
}

async function windowOf(app) {
  const port = app.localEndpoint().port;
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const key = /<meta name="nlc-key" content="([^"]+)"/.exec(html)[1];
  const call = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return res.text();
  };
  return {
    view: () => call('GET', '/v1/window/view'),
    pair: async (input) => JSON.parse(await call('POST', '/v1/window/pair', { code: input })),
  };
}
const visible = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('Y2/Y4 journey: a Node with no address pairs from the connection link, remembers it, shows Disconnected after the dashboard removed it, and pairs again with a bare code', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-link-'));
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  const vps = await startCustomerServer(dir);
  let app = null; let app2 = null;
  t.after(async () => { if (app2) await app2.stop(); if (app) await app.stop(); await vps.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  app = makeNode(dir);
  await app.start();
  const win = await windowOf(app);
  assert.match(visible(await win.view()), /Not connected yet/);

  // A code on its own cannot work: this copy was not told where the customer's NLC is.
  const code1 = (await vps.dashboard('POST', '/api/node/pair/code')).json.code;
  const noAddress = await win.pair(code1);
  assert.equal(noAddress.ok, false);
  assert.match(noAddress.message, /connection link/);

  // Wrong links are refused in plain words and use up nothing.
  for (const bad of [`${vps.origin}/n/ZZZZ9999`, `${vps.origin}/wrong/${code1}`, 'https://nlc.invalid/n/']) {
    assert.deepEqual(await win.pair(bad), { ok: false, message: WRONG }, bad);
  }
  assert.equal(fs.existsSync(path.join(dir, 'state', 'origin.txt')), false, 'a failed try leaves nothing behind');

  // The link the dashboard shows carries the address and the code.
  const shown = (await vps.dashboard('GET', '/api/node/machines')).json.pairing;
  assert.equal(shown.code, code1);
  assert.equal(shown.link, `${vps.origin}/n/${code1}`);
  const ok = await win.pair(shown.link);
  assert.deepEqual(ok, { ok: true, message: 'Connected.' });
  await until(() => vps.backend.listMachines('owner')[0]?.connected, 'computer connected');
  assert.match(visible(await win.view()), /Connected/);
  assert.equal(fs.readFileSync(path.join(dir, 'state', 'origin.txt'), 'utf8').trim(), vps.origin, 'the address is remembered');

  // Restart: the Node comes back by itself, no address typed again.
  await app.stop(); app = null;
  app2 = makeNode(dir);
  await app2.start();
  await until(() => vps.backend.listMachines('owner')[0]?.connected, 'computer back after restart');

  // The customer removes the computer on the dashboard: the window says Disconnected, with the new-code box.
  const machine = vps.backend.listMachines('owner')[0];
  assert.equal((await vps.dashboard('DELETE', `/api/node/machines/${machine.machineId}`)).status, 200);
  const win2 = await windowOf(app2);
  const html = await until(async () => { const v = await win2.view(); return /Disconnected/.test(v) ? v : ''; }, 'window shows Disconnected');
  assert.match(visible(html), /This computer was disconnected from your assistant\. Enter a new code to connect again\./);
  assert.doesNotMatch(visible(html), /Not connected yet/);
  assert.match(html, /class="card pair"/);

  // A bare code is enough now: the address was remembered.
  const code2 = (await vps.dashboard('POST', '/api/node/pair/code')).json.code;
  assert.deepEqual(await win2.pair(code2), { ok: true, message: 'Connected.' });
  await until(() => vps.backend.listMachines('owner')[0]?.connected, 'paired again');
  assert.match(visible(await win2.view()), /Connected/);
});

test('Y4: after too many tries the window says so, not that the code is wrong', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-link-'));
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  const vps = await startCustomerServer(dir, { exchangeLimitPerMinute: 2 });
  const app = makeNode(dir, { origin: vps.origin });
  t.after(async () => { await app.stop(); await vps.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await app.start();
  const win = await windowOf(app);
  assert.deepEqual(await win.pair('AAAA1111'), { ok: false, message: WRONG });
  assert.deepEqual(await win.pair('BBBB2222'), { ok: false, message: WRONG });
  assert.deepEqual(await win.pair('CCCC3333'), { ok: false, message: 'Too many tries. Wait a minute and try again.' });
});
