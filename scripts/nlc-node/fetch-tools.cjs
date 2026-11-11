'use strict';
// Fetch the video and captioning programs NLC Node packs in its payloads (ffmpeg, ffprobe, whisper-cli) for one platform,
// from our own release (node-tools-1 of this repository), and check them against the hash pinned here.
// Usage: node scripts/nlc-node/fetch-tools.cjs <darwin-arm64|darwin-x64|win32-x64> <destDir>
// Result: <destDir>/ffmpeg (ffmpeg, ffprobe) and <destDir>/whisper (whisper-cli and what it needs), the two folders
// scripts/nlc-node/build-payload.cjs takes as --ffmpeg-dir and --whisper-dir.
// NLC_NODE_TOOLS_BASE = folder URL that holds the files (default: the node-tools-1 release of this repository).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TOOLS_TAG = 'node-tools-1';
const DEFAULT_BASE = `https://github.com/getnlc/nlc-node/releases/download/${TOOLS_TAG}`;
// sha256 of each file in the release; taken from the last complete payloads (ffmpeg 8.1.3 LGPL, whisper.cpp 1.9.5).
const PINS = Object.freeze({
  'darwin-arm64': 'ed4134f198c9c9747a452ee24317b8b81295761e640c640df853b35189ab3fbb',
  'darwin-x64': 'ca11429d1e1dae7d34a09f0d4bcb54cae2378da4c6f9e823570863631230d0a6',
  'win32-x64': 'a413aaa57ca9bd3e168d9a1ac22d5563b84cd7abc307e830566f3841ab6eff6a',
});

function requiredFiles(target) {
  const exe = target.startsWith('win32') ? '.exe' : '';
  return [`ffmpeg/ffmpeg${exe}`, `ffmpeg/ffprobe${exe}`, `whisper/whisper-cli${exe}`];
}

async function fetchTools(target, destDir, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const want = PINS[target];
  if (!want) throw new Error(`No tools are pinned for ${target}. Known: ${Object.keys(PINS).join(', ')}`);
  const base = String(env.NLC_NODE_TOOLS_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const name = `tools-${target}.tar.gz`;
  const res = await fetchImpl(`${base}/${name}`);
  if (!res.ok) throw new Error(`Could not download ${name} (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new Error(`${name} does not match the pinned hash (got ${got}).`);
  fs.mkdirSync(destDir, { recursive: true });
  const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-tools-')), name);
  fs.writeFileSync(archive, bytes);
  // bsdtar (System32) on Windows, the system tar elsewhere.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', archive, '-C', destDir], { stdio: 'inherit' });
  for (const rel of requiredFiles(target)) {
    if (!fs.existsSync(path.join(destDir, rel))) throw new Error(`${rel} is missing after unpacking ${name}.`);
  }
  return { ffmpegDir: path.join(destDir, 'ffmpeg'), whisperDir: path.join(destDir, 'whisper'), sha256: got };
}

module.exports = { fetchTools, requiredFiles, PINS, TOOLS_TAG };

if (require.main === module) {
  const [target, dest] = process.argv.slice(2);
  if (!target || !dest) { console.error('Usage: node scripts/nlc-node/fetch-tools.cjs <darwin-arm64|darwin-x64|win32-x64> <destDir>'); process.exit(2); }
  fetchTools(target, path.resolve(dest)).then((r) => { console.log(`tools ready: ${r.ffmpegDir} and ${r.whisperDir} (sha256 ${r.sha256})`); }).catch((e) => { console.error(e.message); process.exit(1); });
}
