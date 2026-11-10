'use strict';
// raea (the maker's engine for AI-written videos and 3D scenes) travels inside the Node payload as its own release archive.
// After an install or an update the Node puts it where the maker's own installer does: ~/.raea (bin/ and share/), with the
// command on the person's PATH. Agent skills are not touched. Done once per bundled version; a failure never stops the Node.
// Layout in the payload: <nodeDir>/raea/raea.json + the archive (Windows) or <Resources>/raea/ (Mac).
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { tarProgram } = require('./archive-tool.cjs');

const MARKER = 'nlc-installed.json';

function bundleDir({ platform, nodeDir }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const candidates = platform === 'win32' ? [p.join(nodeDir, 'raea')] : [p.join(nodeDir, '..', 'Resources', 'raea'), p.join(nodeDir, 'raea')];
  return candidates.find((dir) => fs.existsSync(p.join(dir, 'raea.json'))) || '';
}

function run(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 10 * 60 * 1000 }, (error) => (error ? reject(error) : resolve())));
}

// Windows: the user's own PATH (no administrator). Mac: ~/.local/bin/raea, the same link the maker's installer makes.
async function defaultAddToPath({ platform, homeDir, binDir, runImpl }) {
  if (platform === 'win32') {
    const script = `$b='${binDir.replace(/'/g, "''")}';$p=[Environment]::GetEnvironmentVariable('Path','User');if(-not $p){$p=''};if(($p -split ';') -notcontains $b){[Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';'+$b).TrimStart(';'),'User')}`;
    await runImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    return;
  }
  const link = path.join(homeDir, '.local', 'bin', 'raea');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.join(binDir, 'raea'), link);
}

async function installRaea({ platform = process.platform, homeDir, nodeDir, runImpl = run, addToPath = defaultAddToPath } = {}) {
  if (!homeDir || !nodeDir) return { status: 'skipped' };
  const dir = bundleDir({ platform, nodeDir });
  if (!dir) return { status: 'not-bundled' };
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'raea.json'), 'utf8'));
  const archive = path.join(dir, path.basename(String(info.archive || '')));
  if (!fs.existsSync(archive)) return { status: 'not-bundled' };
  const home = path.join(homeDir, '.raea');
  const markerFile = path.join(home, MARKER);
  try { if (JSON.parse(fs.readFileSync(markerFile, 'utf8')).sha256 === info.sha256) return { status: 'current', version: info.version }; } catch { /* not installed by us yet */ }
  const staging = `${home}.nlc-new`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    await runImpl(tarProgram(platform), [platform === 'win32' ? '-xf' : '-xzf', archive, '-C', staging]);
    // The maker's archives hold bin/ and share/ either at the top or inside one folder.
    let top = staging;
    if (!fs.existsSync(path.join(top, 'bin'))) {
      const only = fs.readdirSync(staging).filter((n) => fs.statSync(path.join(staging, n)).isDirectory());
      if (only.length === 1 && fs.existsSync(path.join(staging, only[0], 'bin'))) top = path.join(staging, only[0]);
    }
    if (!fs.existsSync(path.join(top, 'bin'))) throw new Error('The raea archive did not hold a bin folder.');
    fs.writeFileSync(path.join(top, MARKER), `${JSON.stringify({ version: info.version, sha256: info.sha256 })}\n`);
    fs.rmSync(home, { recursive: true, force: true });
    fs.renameSync(top, home);
    if (platform !== 'win32') for (const n of fs.readdirSync(path.join(home, 'bin'))) { try { fs.chmodSync(path.join(home, 'bin', n), 0o755); } catch { /* best effort */ } }
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  try { await addToPath({ platform, homeDir, binDir: path.join(home, 'bin'), runImpl }); } catch { /* the command is still in ~/.raea/bin */ }
  return { status: 'installed', version: info.version };
}

module.exports = { installRaea, bundleDir, MARKER };
