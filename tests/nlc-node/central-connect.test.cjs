'use strict';
// NN-2026-11-21-01: a computer linked to the customer's NLC is connected to NLC Central with no further step, and so are the
// desktop agents on it; a self-update repeats it by itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCentralConnect, findDesktopAgents, checkInstaller } = require('../../lib/nlc-node/central-connect.cjs');
const { createConnection } = require('../../lib/nlc-node/connection.cjs');

const ORIGIN = 'https://nlc.test';
const DIGEST = 'a'.repeat(64);
const INSTALLER = Buffer.from('// the Central installer\n');
const SHA = crypto.createHash('sha256').update(INSTALLER).digest('hex');
const NAME = 'nlc-central-bootstrap-2.4.6.cjs';

function tmp(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `nn-${label}-`)); }
function reply(runtime, sha = SHA) {
  return { runtime, installationToken: 'tok-' + runtime, localPrincipalDigest: DIGEST,
    runtimeExchangeUrl: 'https://central.test/runtime/event',
    transport: { installer: { filename: NAME, sha256: sha, url: 'https://central.test/runtime/installers/' + NAME } } };
}

// A fake NLC and Central: records every call and hands out installers.
function world({ status = 200, sha = SHA, agents = ['claude', 'codex'] } = {}) {
  const calls = { enroll: [], downloads: [], installs: [], runs: [] };
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/api/node/central/enroll')) {
      calls.enroll.push({ authorization: init.headers.authorization, body: JSON.parse(init.body) });
      if (status !== 200) return { ok: false, status, json: async () => ({ error: 'no' }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, setup: Object.fromEntries(['claude', 'codex'].map(r => [r, reply(r, sha)])) }) };
    }
    calls.downloads.push(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => INSTALLER };
  };
  const home = tmp('home');
  for (const a of agents) fs.mkdirSync(path.join(home, '.' + a), { recursive: true });
  const nodeDir = tmp('nodedir');
  fs.mkdirSync(path.join(nodeDir, 'central-runtime'), { recursive: true });
  fs.writeFileSync(path.join(nodeDir, 'central-runtime', 'node'), '');
  const run = async (file, args) => {
    calls.runs.push({ file, args });
    const connectionFile = args[args.indexOf('--connection') + 1];
    calls.installs.push({ file, installerExists: fs.existsSync(args.find(a => a.endsWith('.cjs'))), connection: JSON.parse(fs.readFileSync(connectionFile, 'utf8')), connectionFile, home: args[args.indexOf('--home') + 1] });
    return { ok: true, stdout: '{}' };
  };
  return { calls, fetchImpl, home, nodeDir, run };
}

function make(w, extra = {}) {
  const stateRoot = tmp('state');
  let build = 'build-1';
  const connect = createCentralConnect({
    stateRoot, homeDir: w.home, nodeDir: w.nodeDir, platform: 'linux', env: {}, identity: { digest: () => DIGEST },
    fetchImpl: w.fetchImpl, run: w.run, build: () => build, ...extra,
  });
  return { connect, stateRoot, setBuild: (value) => { build = value; } };
}

test('finds the desktop agents that are on this computer', () => {
  const home = tmp('agents');
  assert.deepEqual(findDesktopAgents({ homeDir: home, platform: 'linux', env: {} }), { claude: false, codex: false });
  fs.mkdirSync(path.join(home, '.claude'));
  assert.deepEqual(findDesktopAgents({ homeDir: home, platform: 'linux', env: {} }), { claude: true, codex: false });
  assert.deepEqual(findDesktopAgents({ homeDir: home, platform: 'darwin', env: {}, exists: (p) => p === '/Applications/Codex.app' }), { claude: false, codex: true });
});

test('the installer must be an https Central installer with a sha256', () => {
  const good = { filename: NAME, sha256: SHA, url: 'https://central.test/runtime/installers/' + NAME };
  assert.ok(checkInstaller(good));
  assert.equal(checkInstaller({ ...good, url: 'http://central.test/runtime/installers/' + NAME }), null);
  assert.equal(checkInstaller({ ...good, url: 'https://central.test/other/' + NAME }), null);
  assert.equal(checkInstaller({ ...good, filename: 'evil.cjs', url: 'https://central.test/runtime/installers/evil.cjs' }), null);
  assert.equal(checkInstaller({ ...good, sha256: 'xyz' }), null);
});

test('linked computer: asks its NLC with the machine token and its own digest, then installs every desktop agent', async () => {
  const w = world();
  const { connect, stateRoot } = make(w);
  const out = await connect.ensure({ origin: ORIGIN, token: 'machine-token' });
  assert.equal(out.status, 'connected');
  assert.equal(w.calls.enroll.length, 1);
  assert.equal(w.calls.enroll[0].authorization, 'Bearer machine-token');
  assert.deepEqual(w.calls.enroll[0].body, { nodeDigest: DIGEST });
  assert.deepEqual(w.calls.installs.map(i => i.connection.runtime).sort(), ['claude', 'codex']);
  for (const install of w.calls.installs) {
    assert.ok(install.installerExists, 'the verified installer was on disk when it ran');
    assert.equal(install.home, w.home);
    assert.equal(fs.existsSync(install.connectionFile), false, 'the private setup file is removed after the run');
  }
  const state = JSON.parse(fs.readFileSync(path.join(stateRoot, 'central-connect.json'), 'utf8'));
  assert.deepEqual(state.runtimes, { claude: 'ok', codex: 'ok' });
});

test('already connected on this build: nothing is asked or installed again; a self-update repeats it', async () => {
  const w = world();
  const { connect, setBuild } = make(w);
  await connect.ensure({ origin: ORIGIN, token: 't' });
  assert.equal((await connect.ensure({ origin: ORIGIN, token: 't' })).status, 'current');
  assert.equal(w.calls.enroll.length, 1);
  setBuild('build-2');
  assert.equal((await connect.ensure({ origin: ORIGIN, token: 't' })).status, 'connected');
  assert.equal(w.calls.enroll.length, 2, 'the new build asked again');
  assert.equal(w.calls.installs.length, 4, 'and installed both agents again with the new token');
});

test('only the agents that are here are installed', async () => {
  const w = world({ agents: ['claude'] });
  const { connect } = make(w);
  await connect.ensure({ origin: ORIGIN, token: 't' });
  assert.deepEqual(w.calls.installs.map(i => i.connection.runtime), ['claude']);
});

test('no desktop agent here: Central is not asked at all', async () => {
  const w = world({ agents: [] });
  const { connect } = make(w);
  assert.equal((await connect.ensure({ origin: ORIGIN, token: 't' })).status, 'no_desktop_agent');
  assert.equal(w.calls.enroll.length, 0);
});

test('an installer that does not match its checksum is never run', async () => {
  const w = world({ sha: 'b'.repeat(64) });
  const { connect, stateRoot } = make(w);
  const out = await connect.ensure({ origin: ORIGIN, token: 't' });
  assert.equal(out.status, 'install_failed');
  assert.equal(w.calls.installs.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, 'central-connect.json'), 'utf8')).runtimes.claude, 'installer_checksum_mismatch');
});

test('a refused or unpaired computer connects nothing, and is not asked again for a few minutes', async () => {
  const w = world({ status: 401 });
  let time = 1_000;
  const { connect } = make(w, { now: () => time });
  assert.equal((await connect.ensure({ origin: ORIGIN, token: 't' })).status, 'not_paired');
  assert.equal(w.calls.installs.length, 0);
  time += 60_000;
  assert.equal((await connect.ensure({ origin: ORIGIN, token: 't' })).status, 'waiting');
  assert.equal(w.calls.enroll.length, 1);
  time += 11 * 60_000;
  await connect.ensure({ origin: ORIGIN, token: 't' });
  assert.equal(w.calls.enroll.length, 2, 'it tries again later by itself');
});

test('the line coming up with an accepted token starts the connection with that token', async () => {
  const seen = [];
  class FakeSocket {
    constructor() { setImmediate(() => { this.onopen && this.onopen(); this.push({ type: 'node-auth-challenge' }); }); }
    push(msg) { setImmediate(() => { this.onmessage && this.onmessage({ data: JSON.stringify(msg) }); }); }
    send(raw) { if (JSON.parse(raw).type === 'node-auth') this.push({ type: 'node-auth-ok' }); }
    close() {}
  }
  const store = { async load() { return { machineId: 'm-1', token: 'T_now', expiresAt: new Date(Date.now() + 86400000).toISOString() }; }, async save() {}, async clear() {} };
  const c = createConnection({
    origin: 'http://nlc.test', tokenStore: store, dispatcher: { handle: async () => ({ ok: true, result: {} }) }, WebSocketImpl: FakeSocket,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }), keepaliveMs: 60000, onConnected: (session) => { seen.push(session); },
  });
  await c.start();
  const end = Date.now() + 3000;
  while (!seen.length && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(seen, [{ token: 'T_now', machineId: 'm-1' }]);
  await c.stop();
});

test('a computer with no plain Node program runs the installer inside the Node host itself', async () => {
  const w = world();
  fs.rmSync(path.join(w.nodeDir, 'central-runtime', 'node'));
  const { connect } = make(w, { hostPath: '/apps/NLC Node Host' });
  assert.equal((await connect.ensure({ origin: ORIGIN, token: 't' })).status, 'connected');
  assert.ok(w.calls.runs.length === 2 && w.calls.runs.every(r => r.file === '/apps/NLC Node Host' && r.args[0] === '--run-central-installer'));
});

test('with the shipped plain Node program, that runs the installer', async () => {
  const w = world();
  const { connect } = make(w, { hostPath: '/apps/NLC Node Host' });
  await connect.ensure({ origin: ORIGIN, token: 't' });
  assert.ok(w.calls.runs.every(r => r.file === path.join(w.nodeDir, 'central-runtime', 'node') && r.args[0] !== '--run-central-installer'));
});

test('the host runs a Central installer file with --run-central-installer and hands it its own arguments', async () => {
  const { runAdapterMode } = require('../../lib/nlc-node/central-adapter.cjs');
  const dir = tmp('hostrun');
  const out = path.join(dir, 'seen.json');
  const installer = path.join(dir, 'nlc-central-bootstrap-9.9.9.cjs');
  fs.writeFileSync(installer, `'use strict';
const fs = require('node:fs');
module.exports.main = async (args) => { fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args, isMain: require.main === module })); return { migration: 'complete' }; };
if (require.main === module) throw new Error('must not start by itself');
`);
  assert.equal(await runAdapterMode(['--run-central-installer', installer, '--connection', 'c.json', '--home', '/h'], { stateRoot: dir }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { args: ['--connection', 'c.json', '--home', '/h'], isMain: false });
});

// HF-2026-11-20-36: the installer's own error is kept in central-connect.json, not only the word installer_failed.
test('a failed installer: its own error message is kept in central-connect.json beside installer_failed', async () => {
  const w = world();
  const failing = async () => ({ ok: false, stdout: '', stderr: 'NLC Central installer failed: Normal NLC Central OAuth MCP entry is required before installing NLC Node\n', error: 'Command failed: node installer' });
  const { connect, stateRoot } = make(w, { run: failing });
  const out = await connect.ensure({ origin: ORIGIN, token: 't' });
  assert.equal(out.status, 'install_failed');
  const state = JSON.parse(fs.readFileSync(path.join(stateRoot, 'central-connect.json'), 'utf8'));
  assert.deepEqual(state.runtimes, { claude: 'installer_failed', codex: 'installer_failed' });
  for (const runtime of ['claude', 'codex']) assert.match(state.errors[runtime], /Normal NLC Central OAuth MCP entry is required before installing NLC Node/);
});

test('a failed installer that only wrote to stdout, or only timed out, or said nothing, still names its cause', async () => {
  const cases = [
    [{ ok: false, stdout: 'line one\nthe real reason', stderr: '' }, /the real reason/],
    [{ ok: false, stdout: '', stderr: '', killed: true, error: 'Command failed' }, /did not finish within 240 seconds/],
    [{ ok: false, stdout: '', stderr: '', error: 'Command failed: node x\nspawn EACCES' }, /spawn EACCES/],
    [{ ok: false, stdout: '', stderr: '' }, /said nothing/],
  ];
  for (const [outcome, expected] of cases) {
    const w = world({ agents: ['claude'] });
    const { connect, stateRoot } = make(w, { run: async () => outcome });
    await connect.ensure({ origin: ORIGIN, token: 't' });
    const state = JSON.parse(fs.readFileSync(path.join(stateRoot, 'central-connect.json'), 'utf8'));
    assert.match(state.errors.claude, expected);
  }
});

test('the kept installer message never carries a token and is short', async () => {
  const w = world({ agents: ['claude'] });
  const secret = 'A'.repeat(60);
  const noisy = async () => ({ ok: false, stdout: '', stderr: `failed Authorization: Bearer ${secret} and token=abc123 then ${secret} ` + 'x '.repeat(600) });
  const { connect, stateRoot } = make(w, { run: noisy });
  await connect.ensure({ origin: ORIGIN, token: 't' });
  const raw = fs.readFileSync(path.join(stateRoot, 'central-connect.json'), 'utf8');
  assert.ok(!raw.includes(secret) && !raw.includes('abc123'));
  assert.ok(JSON.parse(raw).errors.claude.length <= 505);
});

test('a successful install keeps no errors', async () => {
  const w = world();
  const { connect, stateRoot } = make(w);
  await connect.ensure({ origin: ORIGIN, token: 't' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, 'central-connect.json'), 'utf8')).errors, undefined);
});
