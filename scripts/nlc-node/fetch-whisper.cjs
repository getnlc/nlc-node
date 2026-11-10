'use strict';
// Build-time only: downloads the whisper.cpp command line program (MIT) per OS from a pinned URL, verifies a pinned SHA-256,
// and installs it as <destDir>/<platform>-<arch>/whisper-cli(.exe) with the libraries it loads. Nothing is downloaded here at customer run time
// (the speech MODEL is fetched on first use by lib/nlc-node/modules/speech.cjs, also against a pinned SHA-256).
// Usage: node scripts/nlc-node/fetch-whisper.cjs <win32-x64|darwin-arm64|darwin-x64> <destDir>
const fs = require('node:fs');
const { tarProgram } = require('../../lib/nlc-node/archive-tool.cjs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// RULES: MIT-licensed CPU builds only. Windows x64 comes from the official whisper.cpp release (published there as a b#### prerelease,
// the v1.9.x tags carry no binaries). macOS has no official command line binary (only an xcframework), so it is built by
// .github/workflows/nlc-node-whisper.yml and published to OUR release storage (NLC_WHISPER_RELEASE_BASE = that folder's URL).
// sha256 null = not pinned: the script refuses to download until a person pins it.
const WHISPER_VERSION = '1.9.5';
const WIN_TAG = 'b5454';
const WIN_FILE = 'whisper-bin-x64.zip';
const WIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WIN_TAG}/${WIN_FILE}`;
// GitHub's digest for the asset, read from the release API on 24 Oct 2026, and re-computed from the downloaded file (matched). The zip was listed, never run, on a PC.
const WIN_SHA256 = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb';
const TRUSTED_PREFIXES = ['https://github.com/ggml-org/whisper.cpp/releases/download/'];

function buildSources(env = process.env) {
  const base = (env.NLC_WHISPER_RELEASE_BASE || '').replace(/\/+$/, '');
  const mac = (arch, envName) => ({
    url: base ? `${base}/whisper-${WHISPER_VERSION}-darwin-${arch}-cpu.tar.gz` : null,
    sha256: env[envName] || null,
    exe: '',
    keep: (name) => name === 'whisper-cli',
    missingBase: 'Set NLC_WHISPER_RELEASE_BASE to the folder where the workflow nlc-node-whisper published the macOS build.',
    licence: `MIT (whisper.cpp ${WHISPER_VERSION} built from source by NLC, CPU only, static)`,
  });
  return {
    'win32-x64': {
      url: base ? `${base}/${WIN_FILE}` : WIN_URL,
      sha256: WIN_SHA256,
      exe: '.exe',
      keep: (name) => name === 'whisper-cli.exe' || name === 'whisper.dll' || /^ggml[\w-]*\.dll$/.test(name),
      licence: `MIT (official whisper.cpp ${WIN_TAG} release, CPU build)`,
    },
    'darwin-arm64': mac('arm64', 'NLC_WHISPER_DARWIN_ARM64_SHA256'),
    'darwin-x64': mac('x64', 'NLC_WHISPER_DARWIN_X64_SHA256'),
  };
}
const SOURCES = buildSources(process.env);

function refuseIfUnsafe(target, src, trusted) {
  if (!/^MIT/.test(src.licence || '')) throw new Error(`Refusing ${target}: only MIT builds may ship, this entry says "${src.licence || 'no licence'}".`);
  if (/(^|[-_./])(cuda|cublas|opencl|blas|gpl)([-_.]|$)/i.test(src.url)) throw new Error(`Refusing ${target}: only the plain CPU build is allowed (the file name says GPU, BLAS or GPL).`);
  let u;
  try { u = new URL(src.url); } catch { throw new Error(`Refusing ${target}: the download address is not valid.`); }
  const base = (process.env.NLC_WHISPER_RELEASE_BASE || '').replace(/\/+$/, '');
  const ok = trusted.some((p) => src.url.startsWith(p)) || (base && src.url.startsWith(base + '/'));
  if (!ok || (u.protocol !== 'https:' && !trusted.some((p) => p.startsWith('http:')))) throw new Error(`Refusing ${target}: ${u.hostname} is not a trusted source (the official whisper.cpp releases or NLC_WHISPER_RELEASE_BASE).`);
}

function defaultExtract(archive, dir) {
  // bsdtar (Windows 10+, macOS) reads both zip and tar.gz.
  return new Promise((resolve, reject) => execFile(tarProgram(), ['-xf', archive, '-C', dir], { windowsHide: true }, (e) => (e ? reject(e) : resolve())));
}
function listFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(full)); else out.push(full);
  }
  return out;
}

async function fetchWhisper({ target, destDir, sources = SOURCES, fetch: doFetch = globalThis.fetch, extract = defaultExtract, trustedPrefixes = TRUSTED_PREFIXES }) {
  const src = sources[target];
  if (!src) throw new Error(`Unknown target ${target}. Use one of: ${Object.keys(sources).join(', ')}`);
  if (src.blocked) throw new Error(`Refusing ${target}: ${src.blocked}`);
  if (!src.url) throw new Error(`Refusing ${target}: ${src.missingBase || 'no download URL.'}`);
  refuseIfUnsafe(target, src, trustedPrefixes);
  if (!src.sha256) throw new Error(`Refusing ${target}: the SHA-256 is not pinned yet. Pin it from the publisher's checksums first.`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-whisper-'));
  const res = await doFetch(src.url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${target}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== src.sha256.toLowerCase()) throw new Error(`Checksum mismatch for ${target}: expected ${src.sha256}, got ${got}. Nothing was installed.`);
  const archive = path.join(work, 'whisper-archive');
  fs.writeFileSync(archive, bytes);
  const unpack = path.join(work, 'unpacked'); fs.mkdirSync(unpack);
  await extract(archive, unpack);
  const exe = src.exe || '';
  const keep = src.keep || (() => true);
  const found = listFiles(unpack).filter((f) => keep(path.basename(f)));
  if (!found.some((f) => path.basename(f) === 'whisper-cli' + exe)) throw new Error(`The archive for ${target} has no whisper-cli${exe}.`);
  const out = path.join(destDir, target); fs.mkdirSync(out, { recursive: true });
  for (const f of found) fs.copyFileSync(f, path.join(out, path.basename(f)));
  const whisper = path.join(out, 'whisper-cli' + exe);
  if (!exe) fs.chmodSync(whisper, 0o755);
  return { whisper, files: found.map((f) => path.basename(f)).sort(), licence: src.licence };
}

module.exports = { fetchWhisper, SOURCES, buildSources, WHISPER_VERSION, WIN_TAG };

if (require.main === module) {
  const [target, destDir] = process.argv.slice(2);
  fetchWhisper({ target, destDir: path.resolve(destDir || '.') }).then((r) => console.log('Installed', r.whisper, r.files.join(' ')), (e) => { console.error(e.message); process.exit(1); });
}
