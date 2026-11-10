'use strict';
// GET /downloads/nlc-node/install.sh.sha256 (and .ps1) is the SHA-256 of exactly the script the same request returns.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function routes() {
  const { registerNodeDownloadRoutes } = await import('../../ui/lib/node-download-routes.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-script-sha-'));
  for (const f of ['payload-macos-arm64.tar.gz', 'payload-macos-x64.tar.gz', 'payload-win-x64.zip']) {
    fs.writeFileSync(path.join(dir, f), 'x'); fs.writeFileSync(path.join(dir, `${f}.sha256`), `${'a'.repeat(64)}  ${f}\n`);
  }
  const table = new Map();
  const app = { get: (route, handler) => table.set(route, handler), use() {} };
  registerNodeDownloadRoutes({ app, artifactDir: dir, publicOrigin: 'https://nlc.example.com', env: {} });
  const call = async (route, query = {}) => {
    const out = { status: 0, headers: {}, body: '' };
    const response = { status(code) { out.status = code; return this; }, set(h) { Object.assign(out.headers, h); return this; }, send(b) { out.body = b; return this; } };
    await table.get(route)({ query, headers: {}, protocol: 'https', get: () => 'nlc.example.com' }, response);
    return out;
  };
  return call;
}

test('SCRIPT CHECKSUM: the published hash is the hash of the script served for the same link, for Mac and Windows', async () => {
  const call = await routes();
  const link = 'https://nlc.example.com/n/ABC-123';
  for (const [name, route] of [['install.sh', '/downloads/nlc-node/install.sh'], ['install.ps1', '/downloads/nlc-node/install.ps1']]) {
    for (const query of [{}, { link }]) {
      const script = await call(route, query);
      const sum = await call(`${route}.sha256`, query);
      assert.equal(script.status, 200); assert.equal(sum.status, 200);
      assert.equal(sum.body, `${crypto.createHash('sha256').update(script.body).digest('hex')}  ${name}\n`);
      assert.ok(script.body.includes('https://nlc.example.com'));
    }
    const a = (await call(`${route}.sha256`, {})).body; const b = (await call(`${route}.sha256`, { link })).body;
    assert.notEqual(a, b, 'a script with a connection link inside has its own checksum');
  }
});
