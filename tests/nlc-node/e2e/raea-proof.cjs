'use strict';
// Proof that the built payload carries raea and that the Node puts it in place: unpacks the payload the way an install does,
// runs the Node's own raea step against a throwaway home folder, and runs the installed raea (offline "raea guide").
//   node tests/nlc-node/e2e/raea-proof.cjs --artifacts <payload folder> --transcript <file>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tarProgram } = require('../../../lib/nlc-node/archive-tool.cjs');
const { installRaea } = require('../../../lib/nlc-node/raea-install.cjs');

const args = process.argv.slice(2);
const opt = (name, fallback = '') => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const lines = [];
const say = (text) => { lines.push(text); process.stdout.write(`${text}\n`); };

(async () => {
  const platform = process.platform === 'win32' ? 'win32' : 'darwin';
  const artifacts = path.resolve(opt('--artifacts'));
  const payload = fs.readdirSync(artifacts).find((n) => (platform === 'win32' ? /^payload-win-x64\.zip$/ : /^payload-macos-arm64\.tar\.gz$/).test(n));
  if (!payload) throw new Error('No payload for this computer in ' + artifacts);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-raea-proof-'));
  const unpacked = path.join(work, 'unpacked');
  const homeDir = path.join(work, 'home');
  fs.mkdirSync(unpacked, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  execFileSync(tarProgram(platform), [platform === 'win32' ? '-xf' : '-xzf', path.join(artifacts, payload), '-C', unpacked], { stdio: 'pipe' });
  const nodeDir = platform === 'win32' ? unpacked : path.join(unpacked, 'NLC Node.app', 'Contents', 'MacOS');
  say(`payload: ${payload} (${fs.statSync(path.join(artifacts, payload)).size} bytes)`);
  const result = await installRaea({ platform, homeDir, nodeDir, addToPath: async () => {} });
  say(`install step: ${JSON.stringify(result)}`);
  if (result.status !== 'installed') throw new Error('raea was not installed from the payload.');
  const exe = path.join(homeDir, '.raea', 'bin', platform === 'win32' ? 'raea.exe' : 'raea');
  if (!fs.existsSync(exe)) throw new Error('raea program missing after install: ' + exe);
  const out = execFileSync(exe, ['guide'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  say(`raea guide first line: ${out.split(/\r?\n/).find(Boolean) || '(empty)'}`);
  if (!out.trim()) throw new Error('raea guide printed nothing.');
  const again = await installRaea({ platform, homeDir, nodeDir, addToPath: async () => {} });
  say(`second start: ${JSON.stringify(again)}`);
  if (again.status !== 'current') throw new Error('a second start must not unpack again.');
  say('PASS raea travels in the payload, is put in ~/.raea, and runs');
})().catch((error) => { say(`FAIL ${error.message}`); process.exitCode = 1; }).finally(() => {
  const t = opt('--transcript');
  if (t) fs.writeFileSync(t, `${lines.join('\n')}\n`);
});
