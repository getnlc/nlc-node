'use strict';
// HF-2026-11-21-19: B1 (a refused sign-in of the newest token must not wipe a pairing the NLC still holds)
// and B2 (after a request expires the Node asks again by itself). Real createConnection, fake NLC and socket.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnection } = require('../../lib/nlc-node/connection.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return; await sleep(5); } assert.fail('timed out waiting for ' + label); }
function memoryTokenStore(initial) { let v = initial ? { ...initial } : null; const calls = { clears: 0 }; return { async load() { return v; }, async save(x) { v = { ...x }; }, async clear() { calls.clears += 1; v = null; }, peek: () => v, calls }; }
// refuseFirst: how many sign-ins the NLC refuses with the (valid) token before accepting it again.
function fakeNlc({ refuseFirst, expireFirstRequest }) {
  const seen = { auth: 0, requests: 0, statusPolls: 0 };
  class FakeSocket {
    constructor() { setImmediate(() => { if (this.onopen) this.onopen(); this.push({ type: 'node-auth-challenge' }); }); }
    push(m) { setImmediate(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify(m) }); }); }
    send(raw) { const m = JSON.parse(raw); if (m.type !== 'node-auth') return; seen.auth += 1; this.push(seen.auth > refuseFirst ? { type: 'node-auth-ok' } : { type: 'node-auth-error', message: 'Not accepted' }); }
    close() {}
  }
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/node/pair/request')) { seen.requests += 1; return { ok: true, status: 200, json: async () => ({ requestId: 'req-' + seen.requests, secret: 's' }) }; }
    seen.statusPolls += 1;
    if (expireFirstRequest && seen.requests === 1) return { ok: true, status: 200, json: async () => ({ state: 'expired' }) };
    return { ok: true, status: 200, json: async () => ({ state: 'pending' }) };
  };
  return { FakeSocket, fetchImpl, seen };
}
const cred = (t) => ({ machineId: 'mach-1', token: t, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
const dispatcher = { handle: async () => ({ ok: true, result: {} }) };

test('B1: three refused sign-ins in a row with a token the NLC still holds do not wipe the pairing', async () => {
  const store = memoryTokenStore(cred('T_valid'));
  const nlc = fakeNlc({ refuseFirst: 3 });
  const c = createConnection({ origin: 'http://nlc.test', tokenStore: store, dispatcher, WebSocketImpl: nlc.FakeSocket, fetchImpl: nlc.fetchImpl, autoRequest: true, askEveryMs: 20, keepaliveMs: 60000, setTimer: (f, ms) => setTimeout(f, ms === 60000 ? 20 : ms) /* only the slow refused-pairing retry is sped up */ });
  await c.start();
  await sleep(300);
  assert.equal(store.calls.clears, 0, 'pairing must not be wiped by refusals while the NLC still holds the machine');
  assert.equal(c.status(), 'connected', 'status after the NLC accepts again; got ' + c.status());
  await c.stop();
});

test('B2: when the request expires the Node asks again by itself', async () => {
  const store = memoryTokenStore(null);
  const nlc = fakeNlc({ refuseFirst: 0, expireFirstRequest: true });
  const c = createConnection({ origin: 'http://nlc.test', tokenStore: store, dispatcher, WebSocketImpl: nlc.FakeSocket, fetchImpl: nlc.fetchImpl, autoRequest: true, askEveryMs: 10, askRetryMs: 20, keepaliveMs: 60000 });
  await c.start();
  await sleep(400);
  assert.ok(nlc.seen.requests >= 2, 'a second request after the first expired; requests=' + nlc.seen.requests);
  await c.stop();
});
