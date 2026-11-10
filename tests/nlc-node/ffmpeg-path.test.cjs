'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveFfmpeg, parseVersion } = require('../../lib/nlc-node/ffmpeg-path.cjs');

const LGPL = 'ffmpeg version 8.1.3-24-g92611900bb Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc 14\nconfiguration: --enable-version3 --disable-debug --enable-mediafoundation\nlibavutil 60. 1.100\n';
const GPL = LGPL.replace('--enable-version3', '--enable-gpl --enable-libx264');
const NONFREE = LGPL.replace('--enable-version3', '--enable-nonfree --enable-libfdk-aac');
const MSG = 'The video tools need repair. Reinstall NLC Node.';
const allExist = () => true;

function expectMissing(opts) {
  assert.throws(() => resolveFfmpeg(opts), (e) => e.name === 'NodeError' && e.code === 'FFMPEG_MISSING' && e.message === MSG);
}

test('win32 resolves ffmpeg.exe and ffprobe.exe in the Node folder and parses the version', () => {
  const seen = [];
  const r = resolveFfmpeg({ platform: 'win32', arch: 'x64', nodeDir: 'C:\\Users\\Jo\\AppData\\Local\\NLC Node', exists: allExist, run: (f) => { seen.push(f); return LGPL; } });
  assert.strictEqual(r.ffmpeg, 'C:\\Users\\Jo\\AppData\\Local\\NLC Node\\ffmpeg\\win32-x64\\ffmpeg.exe');
  assert.strictEqual(r.ffprobe, 'C:\\Users\\Jo\\AppData\\Local\\NLC Node\\ffmpeg\\win32-x64\\ffprobe.exe');
  assert.strictEqual(r.version, '8.1.3-24-g92611900bb');
  assert.deepStrictEqual(seen, [r.ffmpeg]);
});

test('darwin arm64 and x64 resolve their own folders without .exe', () => {
  for (const arch of ['arm64', 'x64']) {
    const r = resolveFfmpeg({ platform: 'darwin', arch, nodeDir: '/Users/jo/Library/Application Support/NLC Node', exists: allExist, run: () => LGPL });
    assert.strictEqual(r.ffmpeg, `/Users/jo/Library/Application Support/NLC Node/ffmpeg/darwin-${arch}/ffmpeg`);
    assert.strictEqual(r.ffprobe, `/Users/jo/Library/Application Support/NLC Node/ffmpeg/darwin-${arch}/ffprobe`);
  }
});

test('missing binary, missing probe, unsupported platform all give the repair message', () => {
  expectMissing({ platform: 'win32', arch: 'x64', nodeDir: 'C:\\n', exists: () => false, run: () => LGPL });
  expectMissing({ platform: 'darwin', arch: 'arm64', nodeDir: '/n', exists: (p) => !p.endsWith('ffprobe'), run: () => LGPL });
  expectMissing({ platform: 'linux', arch: 'x64', nodeDir: '/n', exists: allExist, run: () => LGPL });
});

test('a corrupted binary (run throws or prints nothing useful) gives the repair message', () => {
  expectMissing({ platform: 'win32', arch: 'x64', nodeDir: 'C:\\n', exists: allExist, run: () => { throw new Error('spawn UNKNOWN'); } });
  expectMissing({ platform: 'win32', arch: 'x64', nodeDir: 'C:\\n', exists: allExist, run: () => 'garbage' });
});

test('GPL and nonfree builds are refused', () => {
  expectMissing({ platform: 'darwin', arch: 'arm64', nodeDir: '/n', exists: allExist, run: () => GPL });
  expectMissing({ platform: 'darwin', arch: 'arm64', nodeDir: '/n', exists: allExist, run: () => NONFREE });
});

test('parseVersion handles release and git style version lines', () => {
  assert.strictEqual(parseVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright'), '6.1.1-3ubuntu5');
  assert.strictEqual(parseVersion('ffmpeg version N-127957-g935f29eaae-20261023 Copyright'), 'N-127957-g935f29eaae-20261023');
  assert.strictEqual(parseVersion('nope'), null);
});
