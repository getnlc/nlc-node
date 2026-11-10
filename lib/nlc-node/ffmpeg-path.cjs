'use strict';
// Finds the bundled ffmpeg/ffprobe inside the Node folder and checks it is a usable LGPL build.
// Layout: <nodeDir>/ffmpeg/<platform>-<arch>/ffmpeg(.exe) and ffprobe(.exe) (written by scripts/nlc-node/fetch-ffmpeg.cjs).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { NodeError } = require('./errors.cjs');

const REPAIR = 'The video tools need repair. Reinstall NLC Node.';
const TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64'];

function parseVersion(text) {
  const m = /^ffmpeg version (\S+)/m.exec(String(text || ''));
  return m ? m[1] : null;
}
// GPL and nonfree builds must never ship (CONTRACT open item 4).
function isLgplSafe(text) {
  const m = /^configuration:(.*)$/m.exec(String(text || ''));
  if (!m) return false;
  return !/--enable-(gpl|nonfree)(?![\w-])/.test(m[1]);
}
function defaultRun(file) {
  return execFileSync(file, ['-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

function resolveFfmpeg({ platform = process.platform, arch = process.arch, nodeDir, exists = fs.existsSync, run = defaultRun } = {}) {
  const target = `${platform}-${arch}`;
  if (!TARGETS.includes(target) || !nodeDir) throw new NodeError('FFMPEG_MISSING', REPAIR);
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exe = platform === 'win32' ? '.exe' : '';
  const dir = p.join(nodeDir, 'ffmpeg', target);
  const ffmpeg = p.join(dir, 'ffmpeg' + exe);
  const ffprobe = p.join(dir, 'ffprobe' + exe);
  if (!exists(ffmpeg) || !exists(ffprobe)) throw new NodeError('FFMPEG_MISSING', REPAIR);
  let out;
  try { out = run(ffmpeg, ['-version']); } catch { throw new NodeError('FFMPEG_MISSING', REPAIR); }
  const version = parseVersion(out);
  if (!version || !isLgplSafe(out)) throw new NodeError('FFMPEG_MISSING', REPAIR);
  return { ffmpeg, ffprobe, version };
}

module.exports = { resolveFfmpeg, parseVersion, isLgplSafe, REPAIR, TARGETS };
