'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

function constantTimeMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual || '');
  const expectedBuffer = Buffer.from(expected || '');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendRaw(response, status, type, text) {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'" });
  response.end(text);
}

function hostIsLoopback(request) {
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(request.headers.host || '');
}

function authorize(request, token) {
  const header = request.headers.authorization || '';
  return header.startsWith('Bearer ') && constantTimeMatch(header.slice('Bearer '.length), token);
}

function readJsonBody(request, maximumBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        const error = new Error('request_too_large');
        error.status = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const error = new Error('invalid_json');
        error.status = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

async function startLoopbackServer({
  host = '127.0.0.1',
  port = 0,
  token,
  getIdentity,
  getModules,
  getReadiness,
  getHealth = null,
  handleMcp = null,
  handleLifecycle = null,
  windowPage = null,
  windowApi = null,
}) {
  if (host !== '127.0.0.1') throw new Error('NLC Node accepts only the 127.0.0.1 loopback host.');
  if (typeof token !== 'string' || token.length < 32) throw new Error('NLC Node requires a private local token.');
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') return sendJson(response, 200, { state: getReadiness().state });
      if (request.method === 'GET' && typeof windowPage === 'function') {
        const page = hostIsLoopback(request) ? windowPage(request.url) : null;
        if (page) return sendRaw(response, 200, page.type, page.body);
      }
      if (!authorize(request, token)) return sendJson(response, 401, { error: 'unauthorized' });
      if (request.method === 'GET' && request.url === '/v1/health' && getHealth) return sendJson(response, 200, await getHealth());
      if (request.method === 'GET' && request.url === '/v1/identity') return sendJson(response, 200, getIdentity());
      if (request.method === 'GET' && request.url === '/v1/modules') return sendJson(response, 200, { modules: getModules() });
      if (request.method === 'POST' && request.url === '/mcp' && typeof handleMcp === 'function') {
        return sendJson(response, 200, await handleMcp(await readJsonBody(request)));
      }
      if (request.method === 'POST' && request.url === '/v1/lifecycle' && typeof handleLifecycle === 'function') {
        return sendJson(response, 200, await handleLifecycle(await readJsonBody(request)));
      }
      if (typeof windowApi === 'function' && request.url.startsWith('/v1/window/') && hostIsLoopback(request)) {
        const body = request.method === 'POST' ? await readJsonBody(request) : {};
        const result = await windowApi(request.method, request.url, body);
        if (result) {
          if (typeof result.text === 'string') return sendRaw(response, result.status || 200, result.type || 'text/html; charset=utf-8', result.text);
          return sendJson(response, result.status || 200, result.json || {});
        }
      }
      if (!['GET', 'POST'].includes(request.method)) return sendJson(response, 405, { error: 'method_not_allowed' });
      return sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      return sendJson(response, Number(error?.status || 500), { error: error?.message || 'request_failed' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return Object.freeze({
    host,
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  });
}

module.exports = { startLoopbackServer };
