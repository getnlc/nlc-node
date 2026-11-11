'use strict';
// HF-2026-11-11-18: a payload without ffmpeg, ffprobe, whisper-cli and their notices must never go out as the current Node.
const test = require('node:test');
const assert = require('node:assert/strict');
const { missingTools } = require('../../scripts/nlc-node/check-payload-tools.cjs');
const { PINS, requiredFiles } = require('../../scripts/nlc-node/fetch-tools.cjs');

const mac = (arch) => [
  'NLC Node.app/Contents/MacOS/NLC Node',
  `NLC Node.app/Contents/MacOS/ffmpeg/darwin-${arch}/ffmpeg`,
  `NLC Node.app/Contents/MacOS/ffmpeg/darwin-${arch}/ffprobe`,
  `NLC Node.app/Contents/MacOS/whisper/darwin-${arch}/whisper-cli`,
  'NLC Node.app/Contents/Resources/NOTICE-ffmpeg.txt',
  'NLC Node.app/Contents/Resources/NOTICE-whisper.txt',
];
const raeaMac = ['NLC Node.app/Contents/Resources/raea/raea.json', 'NLC Node.app/Contents/Resources/raea/raea-0.1.1-rc2-macos-arm64.tar.gz'];
const win = [
  'NLC Node.exe', 'ffmpeg/win32-x64/ffmpeg.exe', 'ffmpeg/win32-x64/ffprobe.exe', 'whisper/win32-x64/whisper-cli.exe', 'NOTICE-ffmpeg.txt', 'NOTICE-whisper.txt',
  'raea/raea.json', 'raea/raea-0.1.1-rc2-windows-x86_64.zip',
];

test('a Mac payload with all tools and notices passes', () => {
  assert.deepEqual(missingTools('payload-macos-arm64.tar.gz', [...mac('arm64'), ...raeaMac]), []);
  assert.deepEqual(missingTools('payload-macos-x64.tar.gz', mac('x64')), [], 'Intel Mac has no raea build, so none is asked for');
});

test('a Windows payload with all tools and notices passes', () => {
  assert.deepEqual(missingTools('payload-win-x64.zip', win), []);
});

test('a payload with only the app and raea is refused and says what is missing', () => {
  const bare = ['NLC Node.app/Contents/MacOS/NLC Node', 'NLC Node.app/Contents/Resources/raea/raea'];
  assert.deepEqual(missingTools('payload-macos-arm64.tar.gz', bare), ['ffmpeg', 'ffprobe', 'whisper-cli', 'NOTICE-ffmpeg.txt', 'NOTICE-whisper.txt', 'raea.json', 'raea archive']);
});

test('a payload missing only the captioning tool is refused', () => {
  const entries = [...mac('arm64'), ...raeaMac].filter((e) => !/whisper-cli/.test(e));
  assert.deepEqual(missingTools('payload-macos-arm64.tar.gz', entries), ['whisper-cli']);
});

test('an Apple-chip or Windows payload without raea is refused', () => {
  assert.deepEqual(missingTools('payload-macos-arm64.tar.gz', mac('arm64')), ['raea.json', 'raea archive']);
  assert.deepEqual(missingTools('payload-win-x64.zip', win.filter((e) => !/raea/.test(e))), ['raea.json', 'raea archive']);
});

test('a Windows payload carrying Mac-style names is refused', () => {
  assert.ok(missingTools('payload-win-x64.zip', mac('x64')).length > 0);
});

test('every platform has a pinned tools archive and a known list of required files', () => {
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    assert.match(PINS[target], /^[0-9a-f]{64}$/);
    assert.equal(requiredFiles(target).length, 3);
  }
});
