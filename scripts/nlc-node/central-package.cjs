'use strict';
const fs = require('node:fs');
const path = require('node:path');

function planCentralPackage({ centralTransportDir, centralRuntimePath, target }) {
  if (!centralTransportDir) return [];
  if (!centralRuntimePath || !fs.existsSync(centralRuntimePath)) throw Error('Supply the plain Node runtime selected for the Central package with --central-runtime.');
  const root = fs.realpathSync(centralTransportDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'nlc-central-transport' || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !Array.isArray(manifest.files)) throw Error('Choose a built nlc-central-transport package with a version and files manifest.');
  if (!fs.existsSync(path.join(root, 'bin/transport.cjs'))) throw Error('The selected Central package is missing bin/transport.cjs.');
  const extras = [];
  function visit(relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Central package files must stay inside their package.');
    const full = path.join(root, relative), real = fs.realpathSync(full), rel = path.relative(root, real);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw Error('Central package links must stay inside their package.');
    if (fs.statSync(real).isDirectory()) for (const name of fs.readdirSync(real).sort()) visit(path.join(relative, name));
    else extras.push({ rel: 'central-transport/' + relative.split(path.sep).join('/'), from: full, resource: target !== 'windows-x64' });
  }
  visit('package.json');
  for (const entry of manifest.files) visit(entry);
  extras.push({ rel: 'central-runtime/' + (target === 'windows-x64' ? 'node.exe' : 'node'), from: centralRuntimePath, run: true });
  return extras;
}
module.exports = { planCentralPackage };
