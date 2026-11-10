'use strict';
// Build-time only: downloads a static LGPL ffmpeg/ffprobe per OS from a pinned URL, verifies a pinned SHA-256,
// and installs it as <destDir>/<platform>-<arch>/ffmpeg(.exe) + ffprobe(.exe). Nothing is downloaded at customer run time.
// Usage: node scripts/nlc-node/fetch-ffmpeg.cjs <win32-x64|darwin-arm64|darwin-x64> <destDir>
const fs = require('node:fs');
const { tarProgram } = require('../../lib/nlc-node/archive-tool.cjs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// RULES: LGPL builds only. A GPL or nonfree build is never usable (ffmpeg-path.cjs also refuses it at run time).
// sha256 null = not yet pinned: the script refuses to download until a person pins it.
// Storage: macOS artifacts are built by .github/workflows/nlc-node-ffmpeg.yml and published to OUR release storage.
// NLC_FFMPEG_RELEASE_BASE = folder URL that holds them (e.g. https://github.com/<org>/<repo>/releases/download/ffmpeg-8.1.3-1).
// With the variable set, the Windows zip is also read from there (same pinned hash), because BtbN deletes old dated builds.
// NLC_FFMPEG_DARWIN_ARM64_SHA256 / NLC_FFMPEG_DARWIN_X64_SHA256 supply the hashes printed by the workflow until they are committed below.
const FFMPEG_VERSION = '8.1.3';
const BLOCKED_HOSTS = ['ffmpeg.martin-riedl.de', 'evermeet.cx', 'osxexperts.net']; // GPL builds with libx264/libx265
const WIN_FILE = 'ffmpeg-n8.1.3-24-g92611900bb-win64-lgpl-8.1.zip';
const WIN_BTBN_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-23-13-04/' + WIN_FILE;
// From the release's checksums.sha256 (read 24 Oct 2026, 4:40 PM SGT). The zip was not downloaded or run here.
const WIN_SHA256 = 'fcf161b43e3de302663b2a4be5bfa7105b607d310a97709b323f3d8eddec453a';

function buildSources(env = process.env) {
  const base = (env.NLC_FFMPEG_RELEASE_BASE || '').replace(/\/+$/, '');
  const mac = (arch, envName) => ({
    url: base ? `${base}/ffmpeg-${FFMPEG_VERSION}-darwin-${arch}-lgpl.tar.gz` : null,
    sha256: env[envName] || null,
    exe: '',
    missingBase: 'Set NLC_FFMPEG_RELEASE_BASE to the folder where the workflow nlc-node-ffmpeg published the macOS build.',
    licence: 'LGPL-2.1-or-later (FFmpeg built from source with --disable-gpl --disable-nonfree; VideoToolbox, libass; no libx264/libx265)',
  });
  return {
    'win32-x64': {
      url: base ? `${base}/${WIN_FILE}` : WIN_BTBN_URL,
      sha256: WIN_SHA256,
      exe: '.exe',
      licence: 'LGPL-2.1-or-later (BtbN FFmpeg built without --enable-gpl, --enable-nonfree; no libx264/libx265)',
    },
    'darwin-arm64': mac('arm64', 'NLC_FFMPEG_DARWIN_ARM64_SHA256'),
    'darwin-x64': mac('x64', 'NLC_FFMPEG_DARWIN_X64_SHA256'),
  };
}
const SOURCES = buildSources(process.env);

function refuseIfNotLgpl(target, src) {
  if (!/^LGPL/.test(src.licence || '')) throw new Error(`Refusing ${target}: only LGPL builds may ship, this entry says "${src.licence || 'no licence'}".`);
  let host = '';
  try { host = new URL(src.url).hostname; } catch { /* checked by caller */ }
  if (BLOCKED_HOSTS.includes(host)) throw new Error(`Refusing ${target}: ${host} is on the blocked list (GPL builds with libx264/libx265).`);
  if (/(^|[-_./])(gpl|nonfree)([-_.]|$)/i.test(src.url)) throw new Error(`Refusing ${target}: the file name says GPL or nonfree.`);
}

function defaultExtract(archive, dir) {
  // bsdtar (Windows 10+, macOS) reads zip files.
  return new Promise((resolve, reject) => execFile(tarProgram(), ['-xf', archive, '-C', dir], { windowsHide: true }, (e) => (e ? reject(e) : resolve())));
}
function findFile(dir, name) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { const f = findFile(full, name); if (f) return f; }
    else if (ent.name === name) return full;
  }
  return null;
}

async function fetchFfmpeg({ target, destDir, sources = SOURCES, fetch: doFetch = globalThis.fetch, extract = defaultExtract }) {
  const src = sources[target];
  if (!src) throw new Error(`Unknown target ${target}. Use one of: ${Object.keys(sources).join(', ')}`);
  if (src.blocked) throw new Error(`Refusing ${target}: ${src.blocked}`);
  if (!src.url) throw new Error(`Refusing ${target}: ${src.missingBase || 'no download URL.'}`);
  refuseIfNotLgpl(target, src);
  if (!src.sha256) throw new Error(`Refusing ${target}: the SHA-256 is not pinned yet. Pin it from the publisher's checksums file first.`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-ffmpeg-'));
  const res = await doFetch(src.url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${target}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== src.sha256.toLowerCase()) throw new Error(`Checksum mismatch for ${target}: expected ${src.sha256}, got ${got}. Nothing was installed.`);
  const archive = path.join(work, 'ffmpeg-archive');
  fs.writeFileSync(archive, bytes);
  const unpack = path.join(work, 'unpacked'); fs.mkdirSync(unpack);
  await extract(archive, unpack);
  const exe = src.exe || '';
  const a = findFile(unpack, 'ffmpeg' + exe), b = findFile(unpack, 'ffprobe' + exe);
  if (!a || !b) throw new Error(`The archive for ${target} has no ffmpeg${exe} / ffprobe${exe}.`);
  const out = path.join(destDir, target); fs.mkdirSync(out, { recursive: true });
  const ffmpeg = path.join(out, 'ffmpeg' + exe), ffprobe = path.join(out, 'ffprobe' + exe);
  fs.copyFileSync(a, ffmpeg); fs.copyFileSync(b, ffprobe);
  if (!exe) { fs.chmodSync(ffmpeg, 0o755); fs.chmodSync(ffprobe, 0o755); }
  return { ffmpeg, ffprobe, licence: src.licence };
}

module.exports = { fetchFfmpeg, SOURCES, buildSources, BLOCKED_HOSTS, FFMPEG_VERSION };

if (require.main === module) {
  const [target, destDir] = process.argv.slice(2);
  fetchFfmpeg({ target, destDir: path.resolve(destDir || '.') }).then((r) => console.log('Installed', r.ffmpeg), (e) => { console.error(e.message); process.exit(1); });
}
