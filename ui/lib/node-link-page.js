import { createRequire } from 'node:module';
import { configuredOrigin, requestOrigin } from './node-origin.js';

// GET /node, /node/llms.txt, /node/install.json, /node/install.schema.json: the one link a customer pastes into the
// assistant on their computer. Every NLC server answers with its own address inside, so the commands on the page are
// the customer's own. The words come from lib/nlc-node/link-page-render.cjs, the same file the static generator uses.
// No sign-in is needed: the page holds nothing private, only the (optional) one-time connection link the visitor brought.

const require = createRequire(import.meta.url);
const { buildLinkFiles, readPayloads } = require('../../lib/nlc-node/link-page-render.cjs');

const TYPES = Object.freeze({
  'index.html': 'text/html; charset=utf-8',
  'llms.txt': 'text/plain; charset=utf-8',
  'install.json': 'application/json; charset=utf-8',
  'install.schema.json': 'application/json; charset=utf-8',
});
const ROUTES = Object.freeze({
  '/node': 'index.html',
  '/node/': 'index.html',
  '/node/llms.txt': 'llms.txt',
  '/node/install.json': 'install.json',
  '/node/install.schema.json': 'install.schema.json',
});

export function registerNodeLinkPageRoutes({ app, folder, publicOrigin, env = process.env, cleanLink }) {
  if (!app) throw new Error('The Node link page needs its app.');
  const version = () => env.NLC_NODE_VERSION || '0.1.0';
  const commit = () => String(env.NLC_NODE_BUILD || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  for (const [route, name] of Object.entries(ROUTES)) {
    app.get(route, (request, response) => {
      const origin = configuredOrigin(publicOrigin, env) || requestOrigin(request);
      const send = (status, type, body) => response.status(status).set({ 'Content-Type': type, 'Cache-Control': 'no-store' }).send(body);
      if (!origin) return send(400, 'text/plain; charset=utf-8', 'NLC could not work out its own address. Open this link from your NLC dashboard.\n');
      let files;
      try {
        files = buildLinkFiles({ mode: 'vps', origin, link: cleanLink ? cleanLink(request.query.link) : '', version: version(), commit: commit(), sha256: readPayloads(folder()) });
      } catch {
        return send(400, 'text/plain; charset=utf-8', 'NLC could not work out its own address. Open this link from your NLC dashboard.\n');
      }
      return send(200, TYPES[name], files[name]);
    });
  }
}

