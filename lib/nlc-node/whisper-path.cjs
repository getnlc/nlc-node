'use strict';
// Finds the bundled whisper.cpp command line program inside the Node folder.
// Layout: <nodeDir>/whisper/<platform>-<arch>/whisper-cli(.exe) next to its libraries (written by scripts/nlc-node/fetch-whisper.cjs).
const fs = require('node:fs');
const path = require('node:path');
const { NodeError } = require('./errors.cjs');

const REPAIR = 'The captioning tool needs repair. Reinstall NLC Node.';
const TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64'];

function resolveWhisper({ platform = process.platform, arch = process.arch, nodeDir, exists = fs.existsSync } = {}) {
  const target = `${platform}-${arch}`;
  if (!TARGETS.includes(target) || !nodeDir) throw new NodeError('FFMPEG_MISSING', REPAIR);
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = p.join(nodeDir, 'whisper', target);
  const whisper = p.join(dir, 'whisper-cli' + (platform === 'win32' ? '.exe' : ''));
  if (!exists(whisper)) throw new NodeError('FFMPEG_MISSING', REPAIR);
  return { whisper, dir };
}

module.exports = { resolveWhisper, REPAIR, TARGETS };
