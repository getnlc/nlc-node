'use strict';
// NLC Node updates itself. When the server it is paired with says a different build of its payload is published
// (the node-update-notice frame), the Node runs that same server's own installer script, quietly. The installer already
// downloads the payload, checks it against the published checksum, stops the old copy, puts the new copy in place, registers
// the restart supervision and starts the Node again, and it never touches the pairing or the person's folders. The update is
// that existing install, started by the Node instead of by a person.
//
// The installer is started OUTSIDE the Node's own process tree (a one-time Task Scheduler task on Windows, a separate launchd
// job on Mac), because the installer stops the running Node and anything it started inside its tree would stop with it.
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const HEX64 = /^[0-9a-f]{64}$/;
const BUILD_FILE = 'installed-build.txt';
const ATTEMPT_FILE = 'update-attempt.json';
const UPDATE_DIR = 'update';
const WINDOWS_TASK = 'NLC Node Update';
const MAC_JOB = 'com.nlc.node.update';
const SCRIPT_LIMIT_BYTES = 400 * 1024;
const RETRY_SAME_BUILD_MS = 6 * 60 * 60 * 1000;

function payloadFor(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return 'win-x64.zip';
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64.tar.gz';
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64.tar.gz';
  return '';
}

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Starts the installer outside this process tree. Returns when the start was handed over, not when the install finishes.
function launchInstaller({ platform, scriptPath, runnerPath, sha256, execFileImpl = execFile, spawnImpl = spawn }) {
  // No scheduler or launchd session to hand it to (a computer with nobody signed in to a desktop): run it as its own session instead.
  const ownSession = (file, args) => { const child = spawnImpl(file, args, { detached: true, stdio: 'ignore', windowsHide: true }); if (child && typeof child.unref === 'function') child.unref(); };
  const run = (file, args) => new Promise((resolve, reject) => {
    execFileImpl(file, args, { windowsHide: true, timeout: 30000 }, (error) => (error ? reject(error) : resolve()));
  });
  if (platform === 'win32') {
    const runner = [
      "$env:NLC_NODE_NO_OPEN = '1'",
      `$env:NLC_NODE_EXPECT_SHA = ${psQuote(sha256)}`,
      // What the installer says is kept beside it, so a failed update can be read afterwards.
      `$log = ${psQuote(path.join(path.dirname(runnerPath), 'update.log'))}`,
      `try { & ${psQuote(scriptPath)} *>&1 | Out-File -FilePath $log -Append -Encoding utf8 } catch { $_ | Out-File -FilePath $log -Append -Encoding utf8 } finally { schtasks.exe /Delete /TN ${psQuote(WINDOWS_TASK)} /F | Out-Null }`,
      '',
    ].join('\r\n');
    fs.writeFileSync(runnerPath, runner, { encoding: 'utf8', mode: 0o600 });
    // The scheduler starts wscript.exe (no console of its own), which starts PowerShell with its window hidden from the first
    // moment; starting powershell.exe directly would flash a console window on the customer's screen.
    const hiddenPath = runnerPath.replace(/\.ps1$/, '.vbs');
    const inner = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runnerPath}"`;
    fs.writeFileSync(hiddenPath, `CreateObject("WScript.Shell").Run "${inner.replace(/"/g, '""')}", 0, True\r\n`, { encoding: 'utf8', mode: 0o600 });
    const action = `wscript.exe //B //Nologo "${hiddenPath}"`;
    return run('schtasks.exe', ['/Create', '/TN', WINDOWS_TASK, '/SC', 'ONCE', '/ST', '00:00', '/TR', action, '/F'])
      .then(() => run('schtasks.exe', ['/Run', '/TN', WINDOWS_TASK]))
      .catch(() => ownSession('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', runnerPath]));
  }
  const runner = [
    '#!/bin/sh',
    `NLC_NODE_NO_OPEN=1 NLC_NODE_EXPECT_SHA=${shQuote(sha256)} /bin/sh ${shQuote(scriptPath)} >> ${shQuote(path.join(path.dirname(runnerPath), 'update.log'))} 2>&1`,
    `/bin/launchctl remove ${MAC_JOB} >/dev/null 2>&1`,
    '',
  ].join('\n');
  fs.writeFileSync(runnerPath, runner, { encoding: 'utf8', mode: 0o700 });
  return run('/bin/launchctl', ['remove', MAC_JOB]).catch(() => {})
    .then(() => run('/bin/launchctl', ['submit', '-l', MAC_JOB, '--', '/bin/sh', runnerPath]))
    .catch(() => ownSession('/bin/sh', [runnerPath]));
}

function createSelfUpdater({
  stateRoot, origin, platform = process.platform, arch = process.arch,
  fetchImpl = globalThis.fetch, launch = launchInstaller, now = () => Date.now(), log = () => {}, retryMs = RETRY_SAME_BUILD_MS,
} = {}) {
  if (!stateRoot) throw new TypeError('stateRoot is required');
  if (!origin) throw new TypeError('origin is required');
  const base = String(origin).replace(/\/+$/, '');
  const payload = payloadFor(platform, arch);
  const kind = platform === 'win32' ? 'ps1' : 'sh';
  let working = false;

  function installedBuild() {
    try { const word = fs.readFileSync(path.join(stateRoot, BUILD_FILE), 'utf8').trim().split(/\s+/)[0].toLowerCase(); return HEX64.test(word) ? word : ''; } catch { return ''; }
  }
  function lastAttempt() {
    try { return JSON.parse(fs.readFileSync(path.join(stateRoot, ATTEMPT_FILE), 'utf8')); } catch { return null; }
  }

  // The notice is only a pointer: this server's own installer script does the download and the checksum check, and is told
  // which checksum to expect, so a script that would install anything else refuses.
  async function handleNotice(notice) {
    if (!payload) return { status: 'unsupported' };
    if (!notice || typeof notice !== 'object' || notice.payload !== payload || !HEX64.test(String(notice.sha256 || ''))) return { status: 'ignored' };
    const sha256 = notice.sha256;
    if (installedBuild() === sha256) return { status: 'current' };
    const before = lastAttempt();
    if (before && before.sha256 === sha256 && now() - Number(before.at || 0) < retryMs) return { status: 'waiting' };
    if (working) return { status: 'busy' };
    working = true;
    try {
      const response = await fetchImpl(`${base}/downloads/nlc-node/install.${kind}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) return { status: 'unavailable' };
      const text = await response.text();
      if (!text || Buffer.byteLength(text) > SCRIPT_LIMIT_BYTES || !text.includes('NLC Node')) return { status: 'unavailable' };
      const dir = path.join(stateRoot, UPDATE_DIR);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const scriptPath = path.join(dir, `install.${kind}`);
      fs.writeFileSync(scriptPath, text, { encoding: 'utf8', mode: 0o700 });
      fs.writeFileSync(path.join(stateRoot, ATTEMPT_FILE), `${JSON.stringify({ sha256, at: now() })}\n`, { encoding: 'utf8', mode: 0o600 });
      log('updating NLC Node to build ' + sha256.slice(0, 12));
      await launch({ platform, scriptPath, runnerPath: path.join(dir, kind === 'ps1' ? 'run-update.ps1' : 'run-update.sh'), sha256 });
      return { status: 'started', sha256 };
    } catch (error) {
      log('update did not start: ' + (error && error.message || error));
      return { status: 'failed' };
    } finally { working = false; }
  }

  return { handleNotice, installedBuild };
}

module.exports = { createSelfUpdater, launchInstaller, payloadFor, BUILD_FILE, ATTEMPT_FILE, WINDOWS_TASK, MAC_JOB };
