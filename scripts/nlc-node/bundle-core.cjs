'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const defaultEntry = path.join(projectRoot, 'lib', 'nlc-node', 'runtime.cjs');
const releasePath = path.join(projectRoot, 'installer', 'nlc-node', 'release.json');
const localRequirePattern = /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g;

function moduleId(filePath, sourceRoot) {
  return path.relative(sourceRoot, filePath).split(path.sep).join('/');
}

function resolveLocalRequire(fromPath, request) {
  const target = path.resolve(path.dirname(fromPath), request);
  for (const candidate of [target, `${target}.cjs`, `${target}.js`, path.join(target, 'index.cjs')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`NLC Node bundler cannot resolve ${request} from ${fromPath}.`);
}

function collectModules(entryPath, sourceRoot, modules = new Map()) {
  const absolute = path.resolve(entryPath);
  const id = moduleId(absolute, sourceRoot);
  if (modules.has(id)) return modules;
  const original = fs.readFileSync(absolute, 'utf8');
  let source = original.replace(localRequirePattern, (_match, _quote, request) => {
    const dependency = resolveLocalRequire(absolute, request);
    collectModules(dependency, sourceRoot, modules);
    return `__nlcRequire(${JSON.stringify(moduleId(dependency, sourceRoot))})`;
  });
  // A json file the program reads (for example public-source.json) travels as a module that returns its value.
  if (absolute.endsWith('.json')) source = `module.exports = ${JSON.stringify(JSON.parse(original))};`;
  modules.set(id, source);
  return modules;
}

// The Node window page files (html, css, js) travel inside the built program: there is no ui folder next to it on a customer's computer.
function uiAssets(sourceRoot = path.join(projectRoot, 'lib', 'nlc-node')) {
  const folder = path.join(sourceRoot, 'ui');
  const assets = {};
  for (const name of fs.readdirSync(folder).sort()) {
    if (fs.statSync(path.join(folder, name)).isFile()) assets[name] = fs.readFileSync(path.join(folder, name), 'utf8');
  }
  return assets;
}

function normalizeUpdatePublicKey(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('NLC Node build requires NLC_NODE_UPDATE_PUBLIC_KEY_B64.');
  const key = crypto.createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('NLC Node update key must be Ed25519.');
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

function renderBundle({ entryPath = defaultEntry, sourceRoot = path.join(projectRoot, 'lib', 'nlc-node'), updatePublicKey } = {}) {
  const modules = collectModules(entryPath, sourceRoot);
  const rendered = [...modules.entries()].map(([id, source]) => `${JSON.stringify(id)}: function(module, exports, require, __nlcRequire) {\n${source}\n}`).join(',\n');
  const entryId = moduleId(path.resolve(entryPath), sourceRoot);
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  const pinnedUpdatePublicKey = normalizeUpdatePublicKey(updatePublicKey);
  return `'use strict';\nglobalThis.__NLC_NODE_VERSION__ = ${JSON.stringify(release.version)};\nglobalThis.__NLC_NODE_UPDATE_PUBLIC_KEY__ = ${JSON.stringify(pinnedUpdatePublicKey)};\nglobalThis.__NLC_NODE_UI__ = ${JSON.stringify(uiAssets(sourceRoot))};\nconst __nlcModules = {\n${rendered}\n};\nconst __nlcCache = {};\nfunction __nlcRequire(id) {\n  if (__nlcCache[id]) return __nlcCache[id].exports;\n  const factory = __nlcModules[id];\n  if (!factory) throw new Error(\`NLC Node bundled module not found: \${id}\`);\n  const module = { exports: {} };\n  __nlcCache[id] = module;\n  factory(module, module.exports, require, __nlcRequire);\n  return module.exports;\n}\nconst __nlcEntry = __nlcRequire(${JSON.stringify(entryId)});\nif (__nlcEntry && typeof __nlcEntry.run === 'function') {\n  const __nlcExitAfterRun = typeof __nlcEntry.invocationShouldExit === 'function' && __nlcEntry.invocationShouldExit(process.argv.slice(2));\n  __nlcEntry.run()\n    .then(() => { if (__nlcExitAfterRun) process.exit(process.exitCode || 0); })\n    .catch(() => {\n      process.stderr.write('NLC Node could not start.\\n');\n      if (__nlcExitAfterRun) process.exit(1);\n      process.exitCode = 1;\n    });\n}\n`;
}

function writeBundle({ outPath, ...options }) {
  if (!outPath) throw new Error('NLC Node bundle output path is required.');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderBundle(options), 'utf8');
  return outPath;
}

if (require.main === module) {
  const outputIndex = process.argv.indexOf('--out');
  const outPath = outputIndex === -1 ? '' : process.argv[outputIndex + 1];
  try {
    process.stdout.write(`${writeBundle({ outPath, updatePublicKey: process.env.NLC_NODE_UPDATE_PUBLIC_KEY_B64 })}\n`);
  } catch (error) {
    process.stderr.write(`NLC Node bundle failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { uiAssets, collectModules, normalizeUpdatePublicKey, renderBundle, writeBundle };
