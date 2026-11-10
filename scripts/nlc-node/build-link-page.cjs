'use strict';
// Renders the NLC Node link page as plain files: index.html, llms.txt, install.json, install.schema.json.
//   node scripts/nlc-node/build-link-page.cjs --out <folder> [--payload-dir <folder with payload-*.sha256>]
//        [--mode hosted|vps] [--origin https://...] [--version 0.1.0] [--commit <id>]
// Default mode "hosted" is the public copy for https://nexlevelcode.com/node: it holds the real SHA-256 values, and tells
// the reader to use the link from the customer's own NLC dashboard (no public payload host exists yet).
// Mode "vps" with --origin renders the commands for one server's own address (nexlevelcode.com too, once payloads are hosted there).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildLinkFiles, readPayloads } = require('../../lib/nlc-node/link-page-render.cjs');

function generate({ out, payloadDir, mode = 'hosted', origin, version, commit, link }) {
  if (!out) throw new Error('Say where to write the page with --out <folder>.');
  const files = buildLinkFiles({ mode, origin, link, version: version || '0.1.0', commit, sha256: payloadDir ? readPayloads(payloadDir) : {} });
  fs.mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text, 'utf8');
  return Object.keys(files);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (name, fallback = '') => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  let commit = opt('--commit');
  if (!commit) { try { commit = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8' }).trim(); } catch { commit = ''; } }
  try {
    const names = generate({ out: path.resolve(opt('--out')), payloadDir: opt('--payload-dir') && path.resolve(opt('--payload-dir')), mode: opt('--mode', 'hosted'), origin: opt('--origin'), version: opt('--version'), commit });
    process.stdout.write(`Wrote ${names.join(', ')} to ${path.resolve(opt('--out'))}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { generate };
