'use strict';
// One link, everything connected (NN-2026-11-21-01). Once this computer is linked to the customer's NLC, the Node asks that NLC
// to connect the computer to NLC Central under the NLC's own account, and then runs the verified Central installer for every
// desktop agent found here (Claude Desktop, the Codex app). It runs once per Node build, so a self-update repeats it by itself
// and the customer never does a step. It never touches the sign-in of the agents, only their Central entry and hooks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const RUNTIMES = Object.freeze(['claude', 'codex']);
const STATE_FILE = 'central-connect.json';
const WORK_DIR = 'central-connect';
const RETRY_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 4 * 60 * 1000;
const INSTALLER_LIMIT_BYTES = 2 * 1024 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const INSTALLER_NAME = /^nlc-central-bootstrap-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.cjs$/;

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode });
  fs.renameSync(temporary, file);
}

// Which desktop agents live on this computer. Looks for their private folder or their application.
function findDesktopAgents({ homeDir = os.homedir(), platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const local = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const roaming = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const claudeRoot = env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
  const codexRoot = env.CODEX_HOME || path.join(homeDir, '.codex');
  const places = {
    claude: [claudeRoot, ...(platform === 'darwin'
      ? ['/Applications/Claude.app', path.join(homeDir, 'Applications', 'Claude.app'), path.join(homeDir, 'Library', 'Application Support', 'Claude')]
      : platform === 'win32' ? [path.join(local, 'AnthropicClaude'), path.join(local, 'Programs', 'Claude'), path.join(roaming, 'Claude')] : [])],
    codex: [codexRoot, ...(platform === 'darwin'
      ? ['/Applications/Codex.app', path.join(homeDir, 'Applications', 'Codex.app')]
      : platform === 'win32' ? [path.join(local, 'Programs', 'Codex'), path.join(local, 'Codex')] : [])],
  };
  return Object.fromEntries(RUNTIMES.map(runtime => [runtime, places[runtime].some(place => { try { return exists(place); } catch { return false; } })]));
}

// The Codex app carries its own command line tool; the installer needs it to write Codex's settings the supported way.
function findCodexExecutable({ homeDir = os.homedir(), platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.NLC_CODEX_EXECUTABLE) return env.NLC_CODEX_EXECUTABLE;
  const roots = platform === 'darwin' ? ['/Applications/Codex.app', path.join(homeDir, 'Applications', 'Codex.app')] : [];
  const names = platform === 'win32' ? ['codex.exe'] : ['codex'];
  const inside = platform === 'darwin' ? ['Contents/Resources', 'Contents/MacOS', 'Contents/Resources/bin'] : [];
  for (const root of roots) for (const folder of inside) for (const name of names) {
    const candidate = path.join(root, folder, name);
    try { if (exists(candidate)) return candidate; } catch { /* next */ }
  }
  return '';
}

// What runs the Central installer (a Node script): the plain Node program this Node ships beside itself, else this Node host itself,
// which can run it with --run-central-installer (so a computer with no Node of its own needs nothing else).
function findInstallerRunner({ nodeDir = path.dirname(process.execPath), platform = process.platform, exists = fs.existsSync, hostPath = process.execPath } = {}) {
  const shipped = path.join(nodeDir, 'central-runtime', platform === 'win32' ? 'node.exe' : 'node');
  if (exists(shipped)) return { file: shipped, prefix: [] };
  return hostPath ? { file: hostPath, prefix: ['--run-central-installer'] } : null;
}

function checkInstaller(entry) {
  const filename = String(entry && entry.filename || '');
  let url;
  try { url = new URL(String(entry && entry.url || '')); } catch { return null; }
  if (!INSTALLER_NAME.test(filename) || !HEX64.test(String(entry.sha256 || '').toLowerCase())) return null;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/runtime/installers/' + filename)) return null;
  return { filename, url: url.href, sha256: String(entry.sha256).toLowerCase() };
}

function runFile(file, args, { env, timeout }) {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''),
      killed: Boolean(error && error.killed), error: error ? String(error.message || error.code || error) : '',
    }));
  });
}

// The installer's own words for why it failed, kept short and with anything secret-looking removed, so central-connect.json names
// the cause and not only "installer_failed" (HF-2026-11-20-36: the real error was thrown away).
const DETAIL_LIMIT = 500;
function failureDetail(out, timeoutMs) {
  const lines = (text) => String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let detail = lines(out && out.stderr).join(' | ') || lines(out && out.stdout).join(' | ');
  if (!detail && out && out.killed) detail = `the installer did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped`;
  if (!detail && out && out.error) detail = lines(out.error).filter(line => !/^Command failed:/.test(line)).join(' | ');
  detail = detail
    .replace(/(Bearer\s+)\S+/gi, '$1[removed]')
    .replace(/((?:token|secret|password|authorization|key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[removed]')
    .replace(/[A-Za-z0-9_\-+/=]{40,}/g, '[removed]');
  return detail.length > DETAIL_LIMIT ? detail.slice(0, DETAIL_LIMIT) + '...' : detail;
}

function createCentralConnect({
  stateRoot, homeDir = os.homedir(), nodeDir = path.dirname(process.execPath), platform = process.platform, env = process.env,
  identity, fetchImpl = globalThis.fetch, build = () => '', version = '0.0.0', now = () => Date.now(), log = () => {},
  exists = fs.existsSync, run = runFile, retryMs = RETRY_MS, hostPath = process.execPath,
} = {}) {
  if (!stateRoot) throw new TypeError('stateRoot is required');
  if (!identity || typeof identity.digest !== 'function') throw new TypeError('identity is required');
  const stateFile = path.join(stateRoot, STATE_FILE);
  const workDir = path.join(stateRoot, WORK_DIR);
  let working = false;

  async function download(entry) {
    const response = await fetchImpl(entry.url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('installer_unavailable');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > INSTALLER_LIMIT_BYTES) throw new Error('installer_unavailable');
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('installer_checksum_mismatch');
    const file = path.join(workDir, entry.filename);
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return file;
  }

  async function installFor(runtime, reply, runner) {
    const entry = checkInstaller(reply && reply.transport && reply.transport.installer);
    if (!entry) return { ok: false, why: 'no_verified_installer' };
    let installer;
    try { installer = await download(entry); } catch (error) { return { ok: false, why: String(error.message || 'installer_unavailable') }; }
    const connectionFile = path.join(workDir, `connection-${runtime}-${crypto.randomBytes(6).toString('hex')}.json`);
    fs.writeFileSync(connectionFile, JSON.stringify(reply), { mode: 0o600 });
    try {
      const args = [...runner.prefix, installer, '--connection', connectionFile, '--home', homeDir];
      if (runtime === 'codex') { const codex = findCodexExecutable({ homeDir, platform, env, exists }); if (codex) args.push('--codex-executable', codex); }
      const out = await run(runner.file, args, { env: { ...env }, timeout: INSTALL_TIMEOUT_MS });
      return out.ok ? { ok: true } : { ok: false, why: 'installer_failed', detail: failureDetail(out, INSTALL_TIMEOUT_MS) || 'the installer exited with an error and said nothing' };
    } finally { try { fs.unlinkSync(connectionFile); } catch { /* already gone */ } }
  }

  // `session` is { origin, token } of the signed-in link to the customer's NLC. Safe to call on every connect.
  async function ensure({ origin, token } = {}) {
    if (working) return { status: 'busy' };
    if (!origin || !token) return { status: 'not_linked' };
    const agents = findDesktopAgents({ homeDir, platform, env, exists });
    const wanted = RUNTIMES.filter(runtime => agents[runtime]);
    if (!wanted.length) return { status: 'no_desktop_agent' };
    const buildId = String(build() || version);
    const saved = readJson(stateFile) || {};
    const sameBuild = saved.build === buildId && saved.origin === origin;
    if (sameBuild && wanted.every(runtime => saved.runtimes && saved.runtimes[runtime] === 'ok')) return { status: 'current' };
    if (sameBuild && saved.failedAt && now() - saved.failedAt < retryMs) return { status: 'waiting' };
    working = true;
    try {
      const runner = findInstallerRunner({ nodeDir, platform, exists, hostPath });
      const record = { build: buildId, origin, nodeDigest: identity.digest(), runtimes: {}, at: now() };
      const errors = {};
      const fail = (status) => { writeJson(stateFile, { ...record, failedAt: now(), status }); return { status }; };
      if (!runner) return fail('no_runtime');
      let response;
      try {
        response = await fetchImpl(`${origin.replace(/\/+$/, '')}/api/node/central/enroll`, {
          method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({ nodeDigest: record.nodeDigest }), signal: AbortSignal.timeout(30000),
        });
      } catch { return fail('unreachable'); }
      let body = null;
      try { body = await response.json(); } catch { /* handled below */ }
      if (!response.ok || !body || !body.setup) return fail(response.status === 401 ? 'not_paired' : 'refused');
      for (const runtime of wanted) {
        const result = await installFor(runtime, body.setup[runtime], runner);
        record.runtimes[runtime] = result.ok ? 'ok' : result.why;
        if (!result.ok && result.detail) errors[runtime] = result.detail;
        log(`central connect ${runtime}: ${result.ok ? 'ok' : result.why + (result.detail ? ' (' + result.detail + ')' : '')}`);
      }
      const allOk = wanted.every(runtime => record.runtimes[runtime] === 'ok');
      writeJson(stateFile, allOk ? record : { ...record, ...(Object.keys(errors).length ? { errors } : {}), failedAt: now(), status: 'install_failed' });
      return { status: allOk ? 'connected' : 'install_failed', runtimes: record.runtimes };
    } catch (error) {
      log('central connect failed: ' + (error && error.message || error));
      return { status: 'failed' };
    } finally { working = false; }
  }

  return Object.freeze({ ensure });
}

module.exports = { createCentralConnect, findDesktopAgents, findCodexExecutable, findInstallerRunner, checkInstaller, failureDetail, STATE_FILE };
