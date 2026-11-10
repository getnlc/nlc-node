'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const RUNTIMES = Object.freeze(['claude', 'codex']);
const HOST_FIELDS = ['NLC_RUNTIME_ID', 'RUNTIME_ID', 'NLC_AGENT_ID', 'NLC_CODEX_AGENT_ID', 'CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'NLC_SESSION_ID', 'NLC_RUNTIME_SESSION_ID'];
const MAX_OUTPUT = 4 * 1024 * 1024;
function packageVersion(root) {
  try { const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); return manifest.name === 'nlc-central-transport' && /^\d+\.\d+\.\d+$/.test(manifest.version) ? manifest.version : null; } catch { return null; }
}
function runtimePaths(runtime, { homeDir = os.homedir(), nodeDir = path.dirname(process.execPath), legacyOnly = false, platform = process.platform } = {}) {
  if (!RUNTIMES.includes(runtime)) throw Error('Choose runtime claude or codex.');
  const hostRoot = path.join(homeDir, '.' + runtime, 'nlc-central-v2');
  const managed = path.join(hostRoot, 'data', 'nlc-central-runner', 'managed-runtime');
  let installed = null;
  for (const name of ['ready.txt', 'previous-ready.txt']) {
    let fields;
    try { fields = fs.readFileSync(path.join(managed, name), 'utf8').trim().split(/\s+/); } catch { continue; }
    if (fields.length !== 3 || !/^runtime-[a-zA-Z0-9.-]+$/.test(fields[0]) || !/^payload-[a-zA-Z0-9.-]+$/.test(fields[1]) || !/^v[0-9.]+$/.test(fields[2])) continue;
    const packageRoot = path.join(managed, fields[1], 'node_modules', 'nlc-central-transport');
    const executable = path.join(managed, fields[0], process.platform === 'win32' ? 'node.exe' : 'bin/node');
    const version = packageVersion(packageRoot);
    if (version && fs.existsSync(executable) && fs.existsSync(path.join(packageRoot, 'bin', 'transport.cjs'))) { installed = { packageRoot, executable, version, source: 'legacy' }; break; }
  }
  // On a Mac the package is app data in Contents/Resources (a script inside Contents/MacOS would count as unsigned code and break the
  // app's signature); Windows keeps it beside the host program.
  const resourcesPackage = path.join(nodeDir, '..', 'Resources', 'central-transport');
  const packageRoot = platform === 'darwin' && fs.existsSync(path.join(resourcesPackage, 'package.json')) ? resourcesPackage : path.join(nodeDir, 'central-transport');
  const executable = path.join(nodeDir, 'central-runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const version = packageVersion(packageRoot);
  const packaged = version && fs.existsSync(executable) && fs.existsSync(path.join(packageRoot, 'bin', 'transport.cjs')) ? { packageRoot, executable, version, source: 'node' } : null;
  const compare = (a, b) => { const av = a.split('.').map(Number), bv = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] - bv[i]; return 0; };
  const selected = legacyOnly ? installed : packaged && (!installed || compare(packaged.version, installed.version) >= 0) ? packaged : installed;
  if (!selected) throw Error('The Central transport is unavailable. Restore the existing ready transport or reinstall NLC Node.');
  return { ...selected, credentialFile: path.join(hostRoot, 'credentials', 'nlc-central-installation.json'), settingsFile: path.join(homeDir, '.claude', 'settings.json') };
}
function runSelected(event, selected, timeoutMs) {
  const args = [path.join(selected.packageRoot, 'bin', 'transport.cjs'), '--credential-file', selected.credentialFile, '--runtime', event.runtime];
  if (event.runtime === 'claude' && fs.existsSync(selected.settingsFile)) args.push('--settings-file', selected.settingsFile);
  const env = { ...process.env };
  for (const field of HOST_FIELDS) delete env[field];
  Object.assign(env, event.host, { NLC_RUNTIME_ID: event.runtime });
  delete env.NLC_CENTRAL_TRANSPORT_MODE; delete env.NLC_CENTRAL_MCP_LAUNCHER;
  return new Promise((resolve, reject) => {
    const child = spawn(selected.executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env });
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error('central_transport_timeout')); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) { child.kill(); reject(Error('central_transport_output_limit')); } else chunks.push(chunk); });
    child.on('close', code => { clearTimeout(timer); resolve({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode: code }); });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(event.input));
  });
}
function executeTransport(event, options = {}) { return runSelected(event, runtimePaths(event.runtime, options), options.timeoutMs || 2500); }
function executeLegacy(event, options = {}) { return runSelected(event, runtimePaths(event.runtime, { ...options, legacyOnly: true }), options.timeoutMs || 25000); }
function transportHealth(options = {}) {
  return Object.fromEntries(RUNTIMES.map(runtime => {
    try { const selected = runtimePaths(runtime, options); return [runtime, { available: true, version: selected.version, source: selected.source, credentialPresent: fs.existsSync(selected.credentialFile) }]; }
    catch { return [runtime, { available: false }]; }
  }));
}
module.exports = { runtimePaths, executeTransport, executeLegacy, transportHealth };
