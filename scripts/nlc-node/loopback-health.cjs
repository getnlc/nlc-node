'use strict';

// Asks the running NLC Node for its health on 127.0.0.1, the way the installers' verify scripts do (checks I02, I04, C06).
// Usage: node loopback-health.cjs [--state-dir <dir>] [--expect ready|down] [--timeout-ms 15000]

const http = require('node:http');
const { readLocalEndpoint } = require('../../lib/nlc-node/local-endpoint.cjs');
const { resolveStateRoot } = require('../../lib/nlc-node/local-state.cjs');

function getHealth(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ port, state: JSON.parse(Buffer.concat(chunks).toString('utf8')).state }); }
        catch { resolve(null); }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

async function checkLoopbackHealth({ stateDir = resolveStateRoot(), expect = 'ready', timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const endpoint = readLocalEndpoint(stateDir);
    last = endpoint ? await getHealth(endpoint.port) : null;
    if (expect === 'down' && !last) return { ok: true, state: 'down' };
    if (expect === 'ready' && last && last.state === 'ready') return { ok: true, state: 'ready', port: last.port };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const message = expect === 'down'
    ? 'NLC Node is still answering after it was asked to stop.'
    : last ? `NLC Node did not become ready (it reports "${last.state}").` : 'NLC Node is not running.';
  return { ok: false, message };
}

if (require.main === module) {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  checkLoopbackHealth({
    stateDir: option('--state-dir', undefined),
    expect: option('--expect', 'ready') === 'down' ? 'down' : 'ready',
    timeoutMs: Number(option('--timeout-ms', 15000)) || 15000,
  }).then((result) => {
    if (result.ok) process.stdout.write(`${JSON.stringify(result)}\n`);
    else { process.stderr.write(`${result.message}\n`); process.exitCode = 1; }
  });
}

module.exports = { checkLoopbackHealth };
