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
// Windows: the newest LGPL build of the pinned FFmpeg series, read from BtbN's rolling "latest" release. BtbN deletes old dated
// builds, so nothing dated is pinned here. The SHA-256 is the digest GitHub reports for that exact asset and is checked again
// against the downloaded bytes. A different FFmpeg series needs a person to change WIN_SERIES.
const WIN_SERIES = '8.1';
const WIN_LATEST_API = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest';
const WIN_LATEST_ASSET = `ffmpeg-n${WIN_SERIES}-latest-win64-lgpl-${WIN_SERIES}.zip`;

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
      // With our own storage folder set, the zip is read from there and its hash comes from NLC_FFMPEG_WIN32_X64_SHA256.
      url: base ? `${base}/${WIN_LATEST_ASSET}` : null,
      sha256: base ? (env.NLC_FFMPEG_WIN32_X64_SHA256 || null) : null,
      latest: !base,
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

// Fills in url and sha256 for a "newest build" entry from GitHub's own record of the asset.
async function resolveSource(target, sources = SOURCES, doFetch = globalThis.fetch) {
  const src = sources[target];
  if (!src || !src.latest) return src;
  const res = await doFetch(WIN_LATEST_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nlc-node-build' } });
  if (!res.ok) throw new Error(`Could not read the newest ${target} build list (${res.status}).`);
  const release = await res.json();
  const asset = (release.assets || []).find((a) => a.name === WIN_LATEST_ASSET);
  if (!asset) throw new Error(`The newest ${target} build list has no ${WIN_LATEST_ASSET}. A person must check the FFmpeg series.`);
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
  if (!digest) throw new Error(`GitHub reports no SHA-256 for ${asset.name}, so it cannot be verified. Nothing was downloaded.`);
  return { ...src, url: asset.browser_download_url, sha256: digest[1].toLowerCase(), latest: false };
}

async function fetchFfmpeg({ target, destDir, sources = SOURCES, fetch: doFetch = globalThis.fetch, extract = defaultExtract }) {
  if (!sources[target]) throw new Error(`Unknown target ${target}. Use one of: ${Object.keys(sources).join(', ')}`);
  const src = await resolveSource(target, sources, doFetch);
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

module.exports = { fetchFfmpeg, resolveSource, SOURCES, buildSources, BLOCKED_HOSTS, FFMPEG_VERSION };

if (require.main === module) {
  const [target, destDir] = process.argv.slice(2);
  fetchFfmpeg({ target, destDir: path.resolve(destDir || '.') }).then((r) => console.log('Installed', r.ffmpeg), (e) => { console.error(e.message); process.exit(1); });
}
