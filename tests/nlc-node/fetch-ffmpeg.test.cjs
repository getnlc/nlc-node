'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchFfmpeg, SOURCES } = require('../../scripts/nlc-node/fetch-ffmpeg.cjs');

function serve(body) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { res.end(body); });
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}/ffmpeg.zip` }));
  });
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Fake extractor: pretends the archive holds <top>/bin/ffmpeg(.exe) and ffprobe(.exe).
const fakeExtract = (exe) => async (archive, dir) => {
  const bin = path.join(dir, 'ffmpeg-x', 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ffmpeg' + exe), 'FF'); fs.writeFileSync(path.join(bin, 'ffprobe' + exe), 'FP');
};

test('downloads, verifies sha256 and installs ffmpeg + ffprobe into <dest>/<target>/', async () => {
  const body = Buffer.from('pretend zip bytes');
  const { s, url } = await serve(body);
  try {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'q1-ok-'));
    const sources = { 'win32-x64': { url, sha256: sha(body), exe: '.exe', licence: 'LGPL' } };
    const r = await fetchFfmpeg({ target: 'win32-x64', destDir: dest, sources, fetch, extract: fakeExtract('.exe') });
    assert.strictEqual(fs.readFileSync(r.ffmpeg, 'utf8'), 'FF');
    assert.strictEqual(fs.readFileSync(r.ffprobe, 'utf8'), 'FP');
    assert.strictEqual(r.ffmpeg, path.join(dest, 'win32-x64', 'ffmpeg.exe'));
  } finally { s.close(); }
});

test('a wrong sha256 is refused and nothing is installed', async () => {
  const { s, url } = await serve(Buffer.from('tampered'));
  try {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'q1-bad-'));
    const sources = { 'win32-x64': { url, sha256: sha(Buffer.from('original')), exe: '.exe', licence: 'LGPL' } };
    await assert.rejects(fetchFfmpeg({ target: 'win32-x64', destDir: dest, sources, fetch, extract: fakeExtract('.exe') }), /checksum/i);
    assert.strictEqual(fs.existsSync(path.join(dest, 'win32-x64')), false);
  } finally { s.close(); }
});

test('an unpinned or blocked source never downloads', async () => {
  let called = false;
  const spy = async () => { called = true; throw new Error('should not fetch'); };
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'q1-blk-'));
  await assert.rejects(fetchFfmpeg({ target: 'win32-x64', destDir: dest, sources: { 'win32-x64': { url: 'http://x/y.zip', sha256: null, exe: '.exe', licence: 'LGPL' } }, fetch: spy, extract: fakeExtract('.exe') }), /pin/i);
  await assert.rejects(fetchFfmpeg({ target: 'darwin-arm64', destDir: dest, sources: { 'darwin-arm64': { blocked: 'GPL build' } }, fetch: spy, extract: fakeExtract('') }), /GPL/);
  await assert.rejects(fetchFfmpeg({ target: 'linux-x64', destDir: dest, sources: {}, fetch: spy }), /target/i);
  assert.strictEqual(called, false);
});

test('the shipped source table covers the three targets and never lists a GPL build as usable', () => {
  assert.deepStrictEqual(Object.keys(SOURCES).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
  for (const [t, v] of Object.entries(SOURCES)) {
    if (!v.blocked) assert.match(v.licence, /^LGPL/, t);
    assert.ok(!/gpl\.zip|-gpl-/.test(v.url || '') || /lgpl/.test(v.url), t);
  }
});

// ---- Q1b: our own LGPL artifacts (macOS built by .github/workflows/nlc-node-ffmpeg.yml), pinned BtbN LGPL zip (Windows) ----
const { buildSources, BLOCKED_HOSTS } = require('../../scripts/nlc-node/fetch-ffmpeg.cjs');
const BASE = 'https://example.invalid/nlc-ffmpeg/ffmpeg-8.1.3-1';

test('Windows entry is the pinned BtbN LGPL zip with the SHA-256 read from the release checksums file', () => {
  const s = buildSources({});
  assert.strictEqual(s['win32-x64'].sha256, 'fcf161b43e3de302663b2a4be5bfa7105b607d310a97709b323f3d8eddec453a');
  assert.match(s['win32-x64'].url, /autobuild-2026-10-23-13-04\/ffmpeg-n8\.1\.3-24-g92611900bb-win64-lgpl-8\.1\.zip$/);
});

test('NLC_FFMPEG_RELEASE_BASE points every target at our own storage and keeps the pinned hash', () => {
  const s = buildSources({ NLC_FFMPEG_RELEASE_BASE: BASE });
  assert.strictEqual(s['darwin-arm64'].url, BASE + '/ffmpeg-8.1.3-darwin-arm64-lgpl.tar.gz');
  assert.strictEqual(s['darwin-x64'].url, BASE + '/ffmpeg-8.1.3-darwin-x64-lgpl.tar.gz');
  assert.strictEqual(s['win32-x64'].url, BASE + '/ffmpeg-n8.1.3-24-g92611900bb-win64-lgpl-8.1.zip');
  assert.strictEqual(s['win32-x64'].sha256, 'fcf161b43e3de302663b2a4be5bfa7105b607d310a97709b323f3d8eddec453a');
  for (const t of ['darwin-arm64', 'darwin-x64']) assert.match(s[t].licence, /^LGPL/);
});

test('macOS without a storage location or a pinned hash is refused in plain words, nothing downloads', async () => {
  let called = false;
  const spy = async () => { called = true; throw new Error('should not fetch'); };
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'q1b-mac-'));
  await assert.rejects(fetchFfmpeg({ target: 'darwin-arm64', destDir: dest, sources: buildSources({}), fetch: spy }), /NLC_FFMPEG_RELEASE_BASE/);
  await assert.rejects(fetchFfmpeg({ target: 'darwin-arm64', destDir: dest, sources: buildSources({ NLC_FFMPEG_RELEASE_BASE: BASE }), fetch: spy }), /pin/i);
  assert.strictEqual(called, false);
});

test('a pinned hash for a Mac artifact lets it install from our storage', async () => {
  const body = Buffer.from('mac tarball bytes');
  const { s, url } = await serve(body);
  try {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'q1b-macok-'));
    const base = url.replace(/\/ffmpeg\.zip$/, '');
    const src = buildSources({ NLC_FFMPEG_RELEASE_BASE: base, NLC_FFMPEG_DARWIN_ARM64_SHA256: sha(body) });
    const r = await fetchFfmpeg({ target: 'darwin-arm64', destDir: dest, sources: src, fetch, extract: fakeExtract('') });
    assert.strictEqual(r.ffmpeg, path.join(dest, 'darwin-arm64', 'ffmpeg'));
  } finally { s.close(); }
});

test('GPL mirrors and non-LGPL entries stay blocked even with a valid hash', async () => {
  assert.ok(['ffmpeg.martin-riedl.de', 'evermeet.cx', 'osxexperts.net'].every((h) => BLOCKED_HOSTS.includes(h)));
  const spy = async () => { throw new Error('should not fetch'); };
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'q1b-gpl-'));
  const mk = (o) => ({ 'darwin-arm64': { sha256: 'a'.repeat(64), exe: '', licence: 'LGPL-2.1-or-later', ...o } });
  await assert.rejects(fetchFfmpeg({ target: 'darwin-arm64', destDir: dest, sources: mk({ url: 'https://evermeet.cx/ffmpeg/ffmpeg.zip' }), fetch: spy }), /GPL|blocked/i);
  await assert.rejects(fetchFfmpeg({ target: 'darwin-arm64', destDir: dest, sources: mk({ url: 'https://x.invalid/ffmpeg-win64-gpl.zip' }), fetch: spy }), /GPL/);
  await assert.rejects(fetchFfmpeg({ target: 'darwin-arm64', destDir: dest, sources: mk({ url: 'https://x.invalid/f.zip', licence: 'GPL-3.0' }), fetch: spy }), /LGPL/);
});

test('the ffmpeg licence notice template exists and carries the LGPL obligations', () => {
  const t = fs.readFileSync(path.join(__dirname, '../../installer/nlc-node/NOTICE-ffmpeg.txt'), 'utf8');
  for (const needle of ['LGPL', 'GNU Lesser General Public License', 'source code', '--disable-gpl', '{{FFMPEG_VERSION}}', '{{SOURCE_URL}}']) assert.ok(t.includes(needle), needle);
});
