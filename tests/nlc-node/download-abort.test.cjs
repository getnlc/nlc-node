'use strict';
// A computer that drops the payload download part-way must not leave the payload file held open on the server:
// on Windows a held file cannot be replaced by the next published build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('DOWNLOAD ABORT: after a client drops the payload download, the served file can be replaced by a newer build', async () => {
  const { registerNodeDownloadRoutes } = await import('../../ui/lib/node-download-routes.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-download-abort-'));
  const file = 'payload-win-x64.zip';
  fs.writeFileSync(path.join(dir, file), Buffer.alloc(48 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(dir, `${file}.sha256`), `${'a'.repeat(64)}  ${file}\n`);
  const table = new Map();
  const app = { get: (route, handler) => table.set(route, handler), use() {} };
  registerNodeDownloadRoutes({ app, artifactDir: dir, publicOrigin: 'http://127.0.0.1', env: {} });
  const handler = table.get('/downloads/nlc-node/payload/:name');
  assert.equal(typeof handler, 'function');
  const server = http.createServer((request, response) => {
    response.status = (code) => { response.statusCode = code; return response; };
    response.set = (headers) => { for (const [name, value] of Object.entries(headers)) response.setHeader(name, value); return response; };
    handler({ params: { name: 'win-x64.zip' }, query: {}, headers: request.headers }, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/x.zip' }, (response) => {
        let got = 0;
        response.on('data', (chunk) => { got += chunk.length; if (got > 256 * 1024) { request.destroy(); resolve(); } });
        response.on('error', () => {});
      });
      request.on('error', () => resolve());
      setTimeout(() => reject(new Error('the download never started')), 15000).unref();
    });
    await sleep(500);
    // The newer build is published the way the proof publishes it: written beside, then renamed over.
    fs.copyFileSync(path.join(dir, file), path.join(dir, `${file}.part`));
    fs.renameSync(path.join(dir, `${file}.part`), path.join(dir, file));
  } finally {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  }
});
