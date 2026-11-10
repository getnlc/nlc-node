'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchWhisper, SOURCES, buildSources } = require('../../scripts/nlc-node/fetch-whisper.cjs');
const { resolveWhisper } = require('../../lib/nlc-node/whisper-path.cjs');
const { NodeError } = require('../../lib/nlc-node/errors.cjs');

function serve(body) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { res.end(body); });
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}/whisper.zip` }));
  });
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Fake extractor: the archive holds Release/whisper-cli.exe, whisper.dll, two ggml dlls and programs we do not ship.
const fakeExtract = async (archive, dir) => {
  const rel = path.join(dir, 'Release'); fs.mkdirSync(rel, { recursive: true });
  for (const n of ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-cpu-x64.dll', 'whisper-server.exe', 'llama.dll', 'SDL2.dll', 'bench.exe']) fs.writeFileSync(path.join(rel, n), n);
};
const LOCAL = ['http://127.0.0.1'];

test('downloads, verifies sha256 and installs whisper-cli with only the libraries it loads', async () => {
  const body = Buffer.from('pretend zip bytes');
  const { s, url } = await serve(body);
  try {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-ok-'));
    const sources = { 'win32-x64': { url, sha256: sha(body), exe: '.exe', licence: 'MIT (test)', keep: buildSources({})['win32-x64'].keep } };
    const r = await fetchWhisper({ target: 'win32-x64', destDir: dest, sources, fetch, extract: fakeExtract, trustedPrefixes: LOCAL });
    assert.deepStrictEqual(r.files, ['ggml-cpu-x64.dll', 'ggml.dll', 'whisper-cli.exe', 'whisper.dll']);
    assert.strictEqual(r.whisper, path.join(dest, 'win32-x64', 'whisper-cli.exe'));
    assert.deepStrictEqual(fs.readdirSync(path.join(dest, 'win32-x64')).sort(), r.files);
  } finally { s.close(); }
});

test('a wrong sha256 is refused and nothing is installed', async () => {
  const { s, url } = await serve(Buffer.from('tampered'));
  try {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-bad-'));
    const sources = { 'win32-x64': { url, sha256: sha(Buffer.from('original')), exe: '.exe', licence: 'MIT (test)' } };
    await assert.rejects(fetchWhisper({ target: 'win32-x64', destDir: dest, sources, fetch, extract: fakeExtract, trustedPrefixes: LOCAL }), /checksum/i);
    assert.strictEqual(fs.existsSync(path.join(dest, 'win32-x64')), false);
  } finally { s.close(); }
});

test('unpinned, non-MIT, GPU, untrusted-host and missing-base sources never download', async () => {
  let called = false;
  const spy = async () => { called = true; throw new Error('should not fetch'); };
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-blk-'));
  const ok = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
  const run = (src) => fetchWhisper({ target: 't', destDir: dest, sources: { t: src }, fetch: spy, extract: fakeExtract });
  await assert.rejects(run({ url: ok, sha256: null, exe: '.exe', licence: 'MIT' }), /pin/i);
  await assert.rejects(run({ url: ok, sha256: 'a'.repeat(64), exe: '.exe', licence: 'GPL-3.0' }), /MIT/);
  await assert.rejects(run({ url: ok.replace('whisper-bin-x64', 'whisper-bin-win-cuda-12.4.0-x64'), sha256: 'a'.repeat(64), exe: '.exe', licence: 'MIT' }), /CPU build/);
  await assert.rejects(run({ url: 'https://evil.example.com/whisper-bin-x64.zip', sha256: 'a'.repeat(64), exe: '.exe', licence: 'MIT' }), /not a trusted source/);
  await assert.rejects(run({ url: 'http://github.com/ggml-org/whisper.cpp/releases/download/b5454/x.zip', sha256: 'a'.repeat(64), exe: '.exe', licence: 'MIT' }), /trusted/);
  await assert.rejects(fetchWhisper({ target: 'darwin-arm64', destDir: dest, sources: buildSources({}), fetch: spy }), /NLC_WHISPER_RELEASE_BASE/);
  await assert.rejects(fetchWhisper({ target: 'linux-x64', destDir: dest, sources: {}, fetch: spy }), /target/i);
  assert.strictEqual(called, false);
});

test('the shipped source table covers three targets, is MIT, CPU only, and the Windows entry is pinned to the official release', () => {
  assert.deepStrictEqual(Object.keys(SOURCES).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
  for (const v of Object.values(SOURCES)) assert.match(v.licence, /^MIT/);
  const w = SOURCES['win32-x64'];
  assert.match(w.sha256, /^[0-9a-f]{64}$/);
  assert.ok(w.url.startsWith('https://github.com/ggml-org/whisper.cpp/releases/download/b5454/'));
  const m = buildSources({ NLC_WHISPER_RELEASE_BASE: 'https://example.invalid/rel/', NLC_WHISPER_DARWIN_ARM64_SHA256: 'b'.repeat(64) });
  assert.strictEqual(m['darwin-arm64'].url, 'https://example.invalid/rel/whisper-1.9.5-darwin-arm64-cpu.tar.gz');
  assert.strictEqual(m['darwin-x64'].sha256, null, 'mac x64 stays unpinned until the workflow prints its hash');
});

test('resolveWhisper finds <nodeDir>/whisper/<target>/whisper-cli and says "needs repair" otherwise', () => {
  const r = resolveWhisper({ platform: 'win32', arch: 'x64', nodeDir: 'C:\\NLC', exists: () => true });
  assert.strictEqual(r.whisper, 'C:\\NLC\\whisper\\win32-x64\\whisper-cli.exe');
  assert.strictEqual(r.dir, 'C:\\NLC\\whisper\\win32-x64');
  const m = resolveWhisper({ platform: 'darwin', arch: 'arm64', nodeDir: '/Applications/NLC', exists: () => true });
  assert.strictEqual(m.whisper, '/Applications/NLC/whisper/darwin-arm64/whisper-cli');
  for (const args of [{ platform: 'win32', arch: 'x64', nodeDir: 'C:\\NLC', exists: () => false }, { platform: 'linux', arch: 'x64', nodeDir: '/x', exists: () => true }, { platform: 'win32', arch: 'x64', exists: () => true }]) {
    assert.throws(() => resolveWhisper(args), (e) => e instanceof NodeError && e.code === 'FFMPEG_MISSING' && e.message === 'The captioning tool needs repair. Reinstall NLC Node.');
  }
});
