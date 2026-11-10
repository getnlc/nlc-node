'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installRaea } = require('../../lib/nlc-node/raea-install.cjs');
const { planExtras } = require('../../scripts/nlc-node/build-payload.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-raea-'));
  const nodeDir = path.join(root, 'node');
  const homeDir = path.join(root, 'home');
  const bundle = path.join(nodeDir, 'raea');
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'raea-9.9.9-test.zip'), 'archive');
  fs.writeFileSync(path.join(bundle, 'raea.json'), JSON.stringify({ version: '9.9.9', archive: 'raea-9.9.9-test.zip', sha256: 'a'.repeat(64) }));
  // The fake unpacker lays out what the maker's archive holds: one folder with bin/ and share/.
  const runImpl = async (_file, args) => {
    const into = args[args.length - 1];
    fs.mkdirSync(path.join(into, 'raea-9.9.9', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(into, 'raea-9.9.9', 'bin', 'raea'), 'x');
  };
  return { root, nodeDir, homeDir, runImpl };
}

test('raea: the bundled archive is unpacked into ~/.raea once and the command is put on the PATH', async () => {
  const f = fixture();
  const paths = [];
  const addToPath = async ({ binDir }) => { paths.push(binDir); };
  const first = await installRaea({ platform: 'win32', homeDir: f.homeDir, nodeDir: f.nodeDir, runImpl: f.runImpl, addToPath });
  assert.equal(first.status, 'installed');
  assert.ok(fs.existsSync(path.join(f.homeDir, '.raea', 'bin', 'raea')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.homeDir, '.raea', 'nlc-installed.json'), 'utf8')).version, '9.9.9');
  assert.deepEqual(paths, [path.join(f.homeDir, '.raea', 'bin')]);
  const second = await installRaea({ platform: 'win32', homeDir: f.homeDir, nodeDir: f.nodeDir, runImpl: f.runImpl, addToPath });
  assert.equal(second.status, 'current');
  assert.equal(paths.length, 1);
});

test('raea: a payload without raea (Intel Mac) changes nothing', async () => {
  const f = fixture();
  fs.rmSync(path.join(f.nodeDir, 'raea'), { recursive: true });
  const out = await installRaea({ platform: 'win32', homeDir: f.homeDir, nodeDir: f.nodeDir, runImpl: f.runImpl });
  assert.equal(out.status, 'not-bundled');
  assert.equal(fs.existsSync(path.join(f.homeDir, '.raea')), false);
});

test('raea: a broken archive leaves the person\'s existing ~/.raea alone', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.homeDir, '.raea', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(f.homeDir, '.raea', 'bin', 'raea'), 'theirs');
  await assert.rejects(installRaea({ platform: 'win32', homeDir: f.homeDir, nodeDir: f.nodeDir, runImpl: async () => { throw new Error('bad archive'); } }));
  assert.equal(fs.readFileSync(path.join(f.homeDir, '.raea', 'bin', 'raea'), 'utf8'), 'theirs');
});

test('the payload builder carries the fetched raea archive and its raea.json', () => {
  const f = fixture();
  const out = planExtras({ target: 'windows-x64', raeaDir: path.join(f.nodeDir, 'raea'), centralTransportDir: '', centralRuntimePath: '' });
  assert.deepEqual(out.filter((e) => e.rel.startsWith('raea/')).map((e) => e.rel).sort(), ['raea/raea-9.9.9-test.zip', 'raea/raea.json']);
});
