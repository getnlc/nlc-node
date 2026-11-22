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
      : platform === 'win32' ? [path.join(local, 'OpenAI', 'Codex'), path.join(local, 'Programs', 'Codex'), path.join(local, 'Codex')] : [])],
  };
  return Object.fromEntries(RUNTIMES.map(runtime => [runtime, places[runtime].some(place => { try { return exists(place); } catch { return false; } })]));
}

// The Codex app carries its own command line tool; the installer needs it to write Codex's settings the supported way. A clean
// computer has the app but no `codex` on its PATH, so the tool is found inside the app (REPA-2026-11-22-21). Returns '' when none.
function findCodexExecutable({ homeDir = os.homedir(), platform = process.platform, env = process.env, exists = fs.existsSync, list = fs.readdirSync, stat = fs.statSync } = {}) {
  if (env.NLC_CODEX_EXECUTABLE) return env.NLC_CODEX_EXECUTABLE;
  const ok = (candidate) => { try { return exists(candidate); } catch { return false; } };
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    // The app keeps one folder per version under OpenAI\Codexin; newest first, so an old leftover is never chosen.
    const versions = [];
    for (const bin of [path.join(local, 'OpenAI', 'Codex', 'bin'), path.join(local, 'Programs', 'Codex', 'bin')]) {
      let names = [];
      try { names = list(bin); } catch { /* no such folder */ }
      for (const name of names) {
        const candidate = path.join(bin, String(name), 'codex.exe');
        if (!ok(candidate)) continue;
        let at = 0; try { at = stat(candidate).mtimeMs || 0; } catch { /* keep 0 */ }
        versions.push({ candidate, at });
      }
    }
    versions.sort((a, b) => b.at - a.at);
    if (versions.length) return versions[0].candidate;
    for (const candidate of [path.join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe'), path.join(local, 'Programs', 'Codex', 'codex.exe'), path.join(local, 'Programs', 'Codex', 'resources', 'codex.exe')]) if (ok(candidate)) return candidate;
    return '';
  }
  if (platform === 'darwin') {
    for (const root of ['/Applications/Codex.app', path.join(homeDir, 'Applications', 'Codex.app')])
      for (const folder of ['Contents/Resources', 'Contents/MacOS', 'Contents/Resources/bin'])
        if (ok(path.join(root, folder, 'codex'))) return path.join(root, folder, 'codex');
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

// A computer that already holds a Central connection for this agent (to another installation, or one that cannot be told apart) keeps
// it: the Central installer refuses to replace it, and that refusal is protection, not a failure (REPA-2026-11-22-23). This is the
// installer's own rule (prepareInstallationCredential), read before running it, so the answer is the same and nothing is retried.
const KEPT = 'kept_existing';
function existingCredentialFile(runtime, { homeDir, env }) {
  const root = runtime === 'codex' ? (env.CODEX_HOME || path.join(homeDir, '.codex')) : (env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'));
  return path.join(root, 'nlc-central-v2', 'credentials', 'nlc-central-installation.json');
}
function wouldKeepExisting(runtime, reply, where) {
  const prior = readJson(existingCredentialFile(runtime, where));
  if (!prior || typeof prior !== 'object' || !reply) return false;
  const samePrincipal = prior.localPrincipalDigest === reply.localPrincipalDigest && prior.runtimeExchangeUrl === reply.runtimeExchangeUrl;
  const sameToken = prior.runtimeInstallationToken === reply.installationToken;
  const sameSource = Boolean(reply.sourceId) && prior.sourceId === reply.sourceId;
  return !samePrincipal || (!sameToken && !sameSource);
}
const connectedOk = (value) => value === 'ok' || value === KEPT;

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
  exists = fs.existsSync, list = fs.readdirSync, stat = fs.statSync, run = runFile, retryMs = RETRY_MS, hostPath = process.execPath,
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
      if (runtime === 'codex') { const codex = findCodexExecutable({ homeDir, platform, env, exists, list, stat }); if (codex) args.push('--codex-executable', codex); }
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
    if (sameBuild && wanted.every(runtime => saved.runtimes && connectedOk(saved.runtimes[runtime]))) return { status: 'current' };
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
        const result = wouldKeepExisting(runtime, body.setup[runtime], { homeDir, env }) ? { ok: true, kept: true } : await installFor(runtime, body.setup[runtime], runner);
        record.runtimes[runtime] = result.kept ? KEPT : result.ok ? 'ok' : result.why;
        if (result.kept) log(`central connect ${runtime}: this computer already holds a Central connection for it; kept as it is`);
        if (!result.ok && result.detail) errors[runtime] = result.detail;
        if (!result.kept) log(`central connect ${runtime}: ${result.ok ? 'ok' : result.why + (result.detail ? ' (' + result.detail + ')' : '')}`);
      }
      const allOk = wanted.every(runtime => connectedOk(record.runtimes[runtime]));
      writeJson(stateFile, allOk ? record : { ...record, ...(Object.keys(errors).length ? { errors } : {}), failedAt: now(), status: 'install_failed' });
      return { status: allOk ? 'connected' : 'install_failed', runtimes: record.runtimes };
    } catch (error) {
      log('central connect failed: ' + (error && error.message || error));
      return { status: 'failed' };
    } finally { working = false; }
  }

  return Object.freeze({ ensure });
}

module.exports = { createCentralConnect, findDesktopAgents, findCodexExecutable, findInstallerRunner, checkInstaller, failureDetail, wouldKeepExisting, STATE_FILE };
