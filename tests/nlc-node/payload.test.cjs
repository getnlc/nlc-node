'use strict';
// The one-line installers download "payload" archives. These tests build them from a fake build output and read them back
// the way the installer does: check the sha256 file, unpack, and see the same files with the same content.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { buildPayload, PAYLOAD_NAMES } = require('../../scripts/nlc-node/build-payload.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-payload-'));

function readZip(file) {
  const buf = fs.readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'zip end record present');
  const count = buf.readUInt16LE(end + 10);
  let pos = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const nlen = buf.readUInt16LE(pos + 28);
    const elen = buf.readUInt16LE(pos + 30);
    const clen = buf.readUInt16LE(pos + 32);
    const lho = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(zlib.crc32(data), crc, `crc of ${name}`);
    out[name] = data;
    pos += 46 + nlen + elen + clen;
  }
  return out;
}

test('the three payload names are fixed', () => {
  assert.deepEqual(Object.values(PAYLOAD_NAMES).sort(), ['payload-macos-arm64.tar.gz', 'payload-macos-x64.tar.gz', 'payload-win-x64.zip']);
});

test('Mac payload: a tar.gz holding NLC Node.app, runnable files keep their run permission, sha256 file matches', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const app = path.join(root, 'NLC Node.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist/>');
  for (const n of ['NLC Node', 'NLC Node Host']) fs.writeFileSync(path.join(app, 'Contents', 'MacOS', n), `binary ${n}`, { mode: 0o755 });
  const out = path.join(root, 'out');
  const result = buildPayload({ target: 'macos-arm64', outputDir: out, appDir: app });
  assert.equal(path.basename(result.file), 'payload-macos-arm64.tar.gz');
  const sha = fs.readFileSync(`${result.file}.sha256`, 'utf8');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(result.file)).digest('hex');
  assert.equal(sha, `${actual}  payload-macos-arm64.tar.gz\n`);
  const dest = path.join(root, 'unpacked');
  fs.mkdirSync(dest);
  execFileSync('tar', ['-xzf', result.file, '-C', dest]);
  assert.equal(fs.readFileSync(path.join(dest, 'NLC Node.app', 'Contents', 'MacOS', 'NLC Node Host'), 'utf8'), 'binary NLC Node Host');
  assert.ok(fs.statSync(path.join(dest, 'NLC Node.app', 'Contents', 'MacOS', 'NLC Node')).mode & 0o100, 'launcher is still runnable');
  assert.deepEqual(fs.readdirSync(dest), ['NLC Node.app']);
});

test('Windows payload: a zip holding the launcher and the host (and nothing else), sha256 file matches', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'launcher.exe'), 'LAUNCHER'.repeat(500));
  fs.writeFileSync(path.join(root, 'host.exe'), crypto.randomBytes(5000));
  const result = buildPayload({ target: 'windows-x64', outputDir: path.join(root, 'out'), launcherPath: path.join(root, 'launcher.exe'), hostPath: path.join(root, 'host.exe') });
  assert.equal(path.basename(result.file), 'payload-win-x64.zip');
  const files = readZip(result.file);
  assert.deepEqual(Object.keys(files).sort(), ['NLC Node Host.exe', 'NLC Node.exe']);
  assert.equal(files['NLC Node.exe'].toString(), 'LAUNCHER'.repeat(500));
  assert.deepEqual(files['NLC Node Host.exe'], fs.readFileSync(path.join(root, 'host.exe')));
  const actual = crypto.createHash('sha256').update(fs.readFileSync(result.file)).digest('hex');
  assert.equal(fs.readFileSync(`${result.file}.sha256`, 'utf8'), `${actual}  payload-win-x64.zip\n`);
  try { execFileSync('unzip', ['-tq', result.file], { stdio: 'pipe' }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
});

test('a missing build output is reported in plain words, not a stack trace', () => {
  const root = tmp();
  assert.throws(() => buildPayload({ target: 'macos-x64', outputDir: root, appDir: path.join(root, 'nope', 'NLC Node.app') }), /build the macos-x64 app first/i);
  assert.throws(() => buildPayload({ target: 'windows-x64', outputDir: root, launcherPath: path.join(root, 'a.exe'), hostPath: path.join(root, 'b.exe') }), /build the Windows installer parts first/i);
  assert.throws(() => buildPayload({ target: 'linux-x64', outputDir: root }), /macos-arm64, macos-x64 or windows-x64/);
});

// ---- the video and captioning programs ride inside the payload, where the Node looks for them ----
const { resolveFfmpeg } = require('../../lib/nlc-node/ffmpeg-path.cjs');
const { resolveWhisper } = require('../../lib/nlc-node/whisper-path.cjs');
const fakeFfmpegRun = () => 'ffmpeg version 8.1.3 Copyright\nconfiguration: --disable-gpl --disable-nonfree\n';

function fakeTools(root, exe) {
  const ff = path.join(root, 'ff'); const wh = path.join(root, 'wh');
  fs.mkdirSync(ff, { recursive: true }); fs.mkdirSync(wh, { recursive: true });
  fs.writeFileSync(path.join(ff, `ffmpeg${exe}`), 'FFMPEG-BIN', { mode: 0o755 });
  fs.writeFileSync(path.join(ff, `ffprobe${exe}`), 'FFPROBE-BIN', { mode: 0o755 });
  fs.writeFileSync(path.join(ff, 'notes-should-not-travel.md'), 'x');
  fs.writeFileSync(path.join(ff, 'LICENSE-LGPL-2.1.txt'), 'LGPL TEXT');
  fs.writeFileSync(path.join(ff, 'NOTICE-ffmpeg.txt'), 'FILLED LGPL NOTICE FROM THE BUILD');
  fs.writeFileSync(path.join(wh, `whisper-cli${exe}`), 'WHISPER-BIN', { mode: 0o755 });
  if (exe) { fs.writeFileSync(path.join(wh, 'whisper.dll'), 'DLL1'); fs.writeFileSync(path.join(wh, 'ggml-cpu-sse42.dll'), 'DLL2'); }
  return { ffmpegDir: ff, whisperDir: wh };
}

test('Windows payload with the tools: ffmpeg, ffprobe, whisper and the notices are where the Node looks for them', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'launcher.exe'), 'L'); fs.writeFileSync(path.join(root, 'host.exe'), 'H');
  const tools = fakeTools(root, '.exe');
  const result = buildPayload({ target: 'windows-x64', outputDir: path.join(root, 'out'), launcherPath: path.join(root, 'launcher.exe'), hostPath: path.join(root, 'host.exe'), ...tools });
  const files = readZip(result.file);
  assert.deepEqual(Object.keys(files).sort(), [
    'LICENSE-LGPL-2.1.txt', 'NLC Node Host.exe', 'NLC Node.exe', 'NOTICE-ffmpeg.txt', 'NOTICE-whisper.txt',
    'ffmpeg/win32-x64/ffmpeg.exe', 'ffmpeg/win32-x64/ffprobe.exe',
    'whisper/win32-x64/ggml-cpu-sse42.dll', 'whisper/win32-x64/whisper-cli.exe', 'whisper/win32-x64/whisper.dll',
  ]);
  assert.equal(files['ffmpeg/win32-x64/ffmpeg.exe'].toString(), 'FFMPEG-BIN');
  assert.match(files['NOTICE-whisper.txt'].toString(), /MIT/);
  assert.equal(files['NOTICE-ffmpeg.txt'].toString(), 'FILLED LGPL NOTICE FROM THE BUILD', 'the notice the build filled in travels, not the template');
});

test('Mac payload with the tools: after unpacking, the Node finds ffmpeg and whisper next to its host program, and they can run', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const app = path.join(root, 'NLC Node.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'NLC Node Host'), 'H', { mode: 0o755 });
  const tools = fakeTools(root, '');
  const result = buildPayload({ target: 'macos-arm64', outputDir: path.join(root, 'out'), appDir: app, sign: false, ...tools }); // the fake programs here are text files; real signing is proven on the Mac runner
  const dest = path.join(root, 'unpacked'); fs.mkdirSync(dest);
  execFileSync('tar', ['-xzf', result.file, '-C', dest]);
  const nodeDir = path.join(dest, 'NLC Node.app', 'Contents', 'MacOS');
  const found = resolveFfmpeg({ platform: 'darwin', arch: 'arm64', nodeDir, run: fakeFfmpegRun });
  assert.equal(fs.readFileSync(found.ffmpeg, 'utf8'), 'FFMPEG-BIN');
  assert.ok(fs.statSync(found.ffprobe).mode & 0o100, 'ffprobe stays runnable');
  const wh = resolveWhisper({ platform: 'darwin', arch: 'arm64', nodeDir });
  assert.ok(fs.statSync(wh.whisper).mode & 0o100, 'whisper-cli stays runnable');
  assert.ok(fs.existsSync(path.join(dest, 'NLC Node.app', 'Contents', 'Resources', 'NOTICE-ffmpeg.txt')));
  assert.ok(fs.existsSync(path.join(dest, 'NLC Node.app', 'Contents', 'Resources', 'NOTICE-whisper.txt')));
});

test('a tools folder without ffmpeg or whisper is refused in plain words, never packed half-empty', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'launcher.exe'), 'L'); fs.writeFileSync(path.join(root, 'host.exe'), 'H');
  fs.mkdirSync(path.join(root, 'empty'));
  const base = { target: 'windows-x64', outputDir: path.join(root, 'out'), launcherPath: path.join(root, 'launcher.exe'), hostPath: path.join(root, 'host.exe') };
  assert.throws(() => buildPayload({ ...base, ffmpegDir: path.join(root, 'empty') }), /ffmpeg\.exe and ffprobe\.exe were not found/);
  assert.throws(() => buildPayload({ ...base, whisperDir: path.join(root, 'empty') }), /whisper-cli\.exe was not found/);
});

test('staging the tools for the Windows setup program lays them out exactly like the payload does', () => {
  const { stageTools } = require('../../scripts/nlc-node/build-payload.cjs');
  const root = tmp();
  const tools = fakeTools(root, '.exe');
  const out = path.join(root, 'stage');
  stageTools({ target: 'windows-x64', outDir: out, ...tools });
  const listed = [];
  const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`); else listed.push(rel + e.name); } };
  walk(out);
  assert.deepEqual(listed.sort(), [
    'LICENSE-LGPL-2.1.txt', 'NOTICE-ffmpeg.txt', 'NOTICE-whisper.txt',
    'ffmpeg/win32-x64/ffmpeg.exe', 'ffmpeg/win32-x64/ffprobe.exe',
    'whisper/win32-x64/ggml-cpu-sse42.dll', 'whisper/win32-x64/whisper-cli.exe', 'whisper/win32-x64/whisper.dll',
  ]);
});

test('the ffmpeg notice from the template gets its version, build and LGPL version filled in from what the program prints', () => {
  const { fillFfmpegNotice } = require('../../scripts/nlc-node/build-payload.cjs');
  const template = fs.readFileSync(path.join(__dirname, '..', '..', 'installer', 'nlc-node', 'NOTICE-ffmpeg.txt'), 'utf8');
  const v3 = fillFfmpegNotice(template, 'ffmpeg version n8.1.3-24-g92611900bb-20261024 Copyright (c) 2000-2026\nconfiguration: --disable-gpl --enable-version3 --enable-libass\n');
  assert.match(v3, /FFmpeg version: n8\.1\.3-24-g92611900bb-20261024/);
  assert.match(v3, /Configuration \(as printed by "ffmpeg -version"\): --disable-gpl --enable-version3 --enable-libass/);
  assert.match(v3, /version 3 or \(at your option\) any\s+later version/);
  assert.doesNotMatch(v3, /\{\{(FFMPEG_VERSION|CONFIGURATION_LINE|LGPL_VERSION|BUILD_DESCRIPTION)\}\}/);
  const v21 = fillFfmpegNotice(template, 'ffmpeg version 8.1.3\nconfiguration: --disable-gpl --disable-nonfree\n');
  assert.match(v21, /version 2\.1 or \(at your option\)/);
  assert.equal(fillFfmpegNotice(template, 'garbage'), template, 'nothing is guessed when the program printed nothing usable');
});

test('Mac payload: the Central transport is app data in Contents/Resources, never a script inside Contents/MacOS, and the Node still finds it', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const app = path.join(root, 'NLC Node.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'NLC Node Host'), 'H', { mode: 0o755 });
  const pkg = path.join(root, 'transport');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'nlc-central-transport', version: '1.2.3', files: ['bin'] }));
  fs.writeFileSync(path.join(pkg, 'bin', 'transport.cjs'), '// transport');
  const runtime = path.join(root, 'node'); fs.writeFileSync(runtime, 'RUNTIME', { mode: 0o755 });
  const result = buildPayload({ target: 'macos-arm64', outputDir: path.join(root, 'out'), appDir: app, sign: false, centralTransportDir: pkg, centralRuntimePath: runtime });
  const dest = path.join(root, 'unpacked'); fs.mkdirSync(dest);
  execFileSync('tar', ['-xzf', result.file, '-C', dest]);
  const contents = path.join(dest, 'NLC Node.app', 'Contents');
  assert.equal(fs.existsSync(path.join(contents, 'MacOS', 'central-transport')), false, 'no script inside Contents/MacOS, where the app signature would demand it be signed code');
  assert.ok(fs.existsSync(path.join(contents, 'Resources', 'central-transport', 'bin', 'transport.cjs')));
  assert.ok(fs.statSync(path.join(contents, 'MacOS', 'central-runtime', 'node')).mode & 0o100, 'the runtime program stays beside the host');
  const { runtimePaths } = require('../../lib/nlc-node/transport-runner.cjs');
  const found = runtimePaths('claude', { homeDir: path.join(root, 'home'), nodeDir: path.join(contents, 'MacOS'), platform: 'darwin' });
  assert.equal(found.packageRoot, path.join(contents, 'Resources', 'central-transport'));
  assert.equal(found.version, '1.2.3');
});

test('Windows keeps the Central transport beside the host program', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'launcher.exe'), 'L'); fs.writeFileSync(path.join(root, 'host.exe'), 'H');
  const pkg = path.join(root, 'transport');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'nlc-central-transport', version: '1.2.3', files: ['bin'] }));
  fs.writeFileSync(path.join(pkg, 'bin', 'transport.cjs'), '// transport');
  const runtime = path.join(root, 'node.exe'); fs.writeFileSync(runtime, 'RUNTIME');
  const result = buildPayload({ target: 'windows-x64', outputDir: path.join(root, 'out'), launcherPath: path.join(root, 'launcher.exe'), hostPath: path.join(root, 'host.exe'), centralTransportDir: pkg, centralRuntimePath: runtime });
  const files = readZip(result.file);
  assert.ok(files['central-transport/bin/transport.cjs'], 'beside the host');
  assert.ok(files['central-runtime/node.exe']);
});
