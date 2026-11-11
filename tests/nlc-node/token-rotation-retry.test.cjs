'use strict';
// HF-2026-11-11-16: the token rotates every few minutes. A sign-in refused with an older token than the saved one must
// reload the newest saved token and retry without wiping the pairing; only a refused newest token ends the pairing,
// and then the Node asks its NLC again by itself so the owner's Allow is the only step.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnection } = require('../../lib/nlc-node/connection.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(5); }
  assert.fail('timed out waiting for ' + label);
}

function memoryTokenStore(initial) {
  let value = initial ? { ...initial } : null;
  const calls = { clears: 0 };
  return { async load() { return value; }, async save(v) { value = { ...v }; }, async clear() { calls.clears += 1; value = null; }, peek: () => value, calls };
}

// A fake NLC that accepts only the tokens in `good`, and answers a link request like the real route.
function fakeNlc(good) {
  const seen = { authTokens: [], requests: 0, allow: false };
  class FakeSocket {
    constructor() {
      setImmediate(() => { if (this.onopen) this.onopen(); this.push({ type: 'node-auth-challenge' }); });
    }
    push(msg) { setImmediate(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }); }
    send(raw) {
      const msg = JSON.parse(raw);
      if (msg.type !== 'node-auth') return;
      seen.authTokens.push(msg.token);
      this.push(good.has(msg.token) ? { type: 'node-auth-ok' } : { type: 'node-auth-error', message: 'Not accepted' });
    }
    close() {}
  }
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/node/pair/request')) { seen.requests += 1; return { ok: true, status: 200, json: async () => ({ requestId: 'req-1', secret: 'sec-1' }) }; }
    if (seen.allow) return { ok: true, status: 200, json: async () => ({ state: 'allowed', token: 'T_allowed', machineId: 'mach-1', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }) };
    return { ok: true, status: 200, json: async () => ({ state: 'pending' }) };
  };
  return { FakeSocket, fetchImpl, seen };
}

const cred = (token) => ({ machineId: 'mach-1', token, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
const dispatcher = { handle: async () => ({ ok: true, result: {} }) };

test('refused with an older token: reloads the newest saved token, retries, stays paired', async () => {
  const store = memoryTokenStore(cred('T_old'));
  const nlc = fakeNlc(new Set(['T_new']));
  const c = createConnection({ origin: 'http://nlc.test', tokenStore: store, dispatcher, WebSocketImpl: nlc.FakeSocket, fetchImpl: nlc.fetchImpl, autoRequest: true, keepaliveMs: 60000 });
  // The renewal saved T_new while the sign-in carrying T_old was already on its way.
  const realLoad = store.load.bind(store);
  let first = true;
  store.load = async () => { if (first) { first = false; return realLoad(); } return cred('T_new'); };
  await c.start();
  await until(() => c.status() === 'connected', 'connected with the newest token');
  assert.deepEqual(nlc.seen.authTokens.slice(0, 2), ['T_old', 'T_new']);
  assert.equal(store.calls.clears, 0, 'pairing not wiped');
  assert.equal(nlc.seen.requests, 0, 'no new link request needed');
  await c.stop();
});

test('refused with the newest token: pairing ends and the Node asks its NLC again by itself', async () => {
  const store = memoryTokenStore(cred('T_bad'));
  const nlc = fakeNlc(new Set(['T_allowed']));
  const c = createConnection({ origin: 'http://nlc.test', tokenStore: store, dispatcher, WebSocketImpl: nlc.FakeSocket, fetchImpl: nlc.fetchImpl, autoRequest: true, askEveryMs: 20, keepaliveMs: 60000 });
  await c.start();
  await until(() => nlc.seen.requests >= 1, 'a link request after the refusal');
  assert.equal(c.status(), 'disconnected', 'the window keeps saying Disconnected while it asks in the background');
  assert.equal(store.calls.clears, 1, 'a refused newest token is cleared');
  nlc.seen.allow = true; // the owner presses Allow
  await until(() => c.status() === 'connected', 'connected after Allow');
  assert.equal(store.peek().token, 'T_allowed');
  await c.stop();
});

test('refused newest token without autoRequest: ends the pairing and does not ask', async () => {
  const store = memoryTokenStore(cred('T_bad'));
  const nlc = fakeNlc(new Set());
  const c = createConnection({ origin: 'http://nlc.test', tokenStore: store, dispatcher, WebSocketImpl: nlc.FakeSocket, fetchImpl: nlc.fetchImpl, autoRequest: false, keepaliveMs: 60000 });
  await c.start();
  await until(() => c.status() === 'disconnected', 'disconnected');
  await sleep(50);
  assert.equal(nlc.seen.requests, 0);
  await c.stop();
});
