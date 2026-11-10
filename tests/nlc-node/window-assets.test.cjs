'use strict';
// The Node window page must open from the built single-file program, where there is no ui folder on disk next to the code.
// (Found by the one-line install check: the built app answered the window address with "ENOENT ... ui/index.html".)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderBundle, uiAssets } = require('../../scripts/nlc-node/bundle-core.cjs');

const SRC = path.resolve(__dirname, '../../lib/nlc-node');
const KEY = require('node:crypto').generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

test('the built program carries the window page files inside itself', () => {
  const bundle = renderBundle({ updatePublicKey: KEY });
  assert.match(bundle, /globalThis\.__NLC_NODE_UI__ = /);
  const assets = uiAssets(path.join(SRC));
  assert.deepEqual(Object.keys(assets).sort(), ['app.js', 'index.html', 'tokens.css', 'window.css']);
  for (const [name, text] of Object.entries(assets)) assert.equal(text, fs.readFileSync(path.join(SRC, 'ui', name), 'utf8'));
});

test('the window page is served with no ui folder on disk, from the carried files', () => {
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-window-lonely-'));
  fs.copyFileSync(path.join(SRC, 'window.cjs'), path.join(lonely, 'window.cjs'));
  globalThis.__NLC_NODE_UI__ = uiAssets(SRC);
  try {
    const { createWindow } = require(path.join(lonely, 'window.cjs'));
    const win = createWindow({ grants: { list: () => [], isPaused: () => false }, actionLog: { tools: {} }, connectionState: { getState: () => 'unpaired' } });
    for (const route of ['/window', '/window/tokens.css', '/window/window.css', '/window/app.js']) {
      const page = win.windowPage(route);
      assert.ok(page && page.body.length > 50, `${route} is served`);
    }
  } finally { delete globalThis.__NLC_NODE_UI__; }
});
