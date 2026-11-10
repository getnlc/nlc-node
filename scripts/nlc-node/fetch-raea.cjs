'use strict';
// Build-time only: downloads the pinned raea release archive for one computer type from the maker's GitHub release,
// checks it against the .sha256 file published beside it, and leaves archive + raea.json in <destDir>.
// Nothing is downloaded at customer run time. A computer type with no published build (Intel Mac) gets nothing.
// Usage: node scripts/nlc-node/fetch-raea.cjs <win32-x64|darwin-arm64|darwin-x64> <destDir>
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const pin = require('../../installer/nlc-node/raea-version.json');

async function fetchRaea(target, destDir, fetchImpl = globalThis.fetch) {
  const name = pin.assets[target];
  if (!name) return null;
  fs.mkdirSync(destDir, { recursive: true });
  const sumResponse = await fetchImpl(`${pin.release}/${name}.sha256`);
  if (!sumResponse.ok) throw new Error(`raea checksum for ${name} not found (${sumResponse.status}).`);
  const want = (await sumResponse.text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('raea checksum file is not a SHA-256.');
  const file = path.join(destDir, name);
  const response = await fetchImpl(`${pin.release}/${name}`);
  if (!response.ok || !response.body) throw new Error(`raea archive ${name} not available (${response.status}).`);
  const hash = crypto.createHash('sha256');
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => hash.update(chunk));
  await pipeline(body, fs.createWriteStream(file));
  if (hash.digest('hex') !== want) { fs.rmSync(file, { force: true }); throw new Error(`raea archive ${name} does not match its published checksum.`); }
  fs.writeFileSync(path.join(destDir, 'raea.json'), `${JSON.stringify({ version: pin.version, archive: name, sha256: want })}\n`);
  return { file, sha256: want, version: pin.version };
}

if (require.main === module) {
  fetchRaea(process.argv[2], path.resolve(process.argv[3] || 'raea-dir'))
    .then((r) => process.stdout.write(r ? `${r.file}\n` : 'no raea build for this computer type\n'))
    .catch((e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
}
module.exports = { fetchRaea };
