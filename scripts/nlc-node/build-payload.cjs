'use strict';
// Packs the built NLC Node into the "payload" the one-line installers download (no dmg, no setup .exe, so nothing a
// browser would mark as downloaded). Mac: a tar.gz holding NLC Node.app. Windows: a zip holding the launcher and the host.
// Each payload gets a .sha256 file next to it ("<hash>  <name>") that the installer checks before it unpacks anything.
//   node scripts/nlc-node/build-payload.cjs macos-arm64|macos-x64|windows-x64 [--out dist/nlc-node/payload]
// Optional: --ffmpeg-dir <folder holding ffmpeg and ffprobe> and --whisper-dir <folder holding whisper-cli and its libraries>
// add them where the Node looks (ffmpeg/<platform>-<arch>/, whisper/<platform>-<arch>/ beside the host) with their notices.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const { PAYLOAD_NAMES } = require('../../lib/nlc-node/artifact-names.cjs');
const { planCentralPackage } = require('./central-package.cjs');
const NOTICE_DIR = path.join(root, 'installer', 'nlc-node');
// <platform>-<arch> as the Node itself names its program folders (lib/nlc-node/ffmpeg-path.cjs, whisper-path.cjs).
const NODE_TARGET = Object.freeze({ 'macos-arm64': 'darwin-arm64', 'macos-x64': 'darwin-x64', 'windows-x64': 'win32-x64' });

// ---- a small zip writer (deflate), enough for two or three files ----
function crc32(buffer) { return zlib.crc32(buffer) >>> 0; }
function writeZip(file, entries) {
  const parts = []; const central = []; let offset = 0;
  const stamp = (() => { const d = new Date(); return { time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, day: (((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff }; })();
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const packed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const head = Buffer.alloc(46 + name.length);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(8, 10);
    head.writeUInt16LE(stamp.time, 12); head.writeUInt16LE(stamp.day, 14);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42); name.copy(head, 46);
    parts.push(local, packed); central.push(head);
    offset += local.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, directory, end]));
}

function writeSha(file) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${hash}  ${path.basename(file)}\n`, 'utf8');
  return hash;
}

// Fills what the program itself tells us into the notice template; the offer-of-source lines are filled at release time.
function fillFfmpegNotice(template, versionText) {
  const version = /^ffmpeg version (\S+)/m.exec(String(versionText || ''));
  const config = /^configuration:\s*(.*)$/m.exec(String(versionText || ''));
  if (!version || !config) return template;
  const lgpl = /--enable-version3/.test(config[1]) ? '3' : '2.1';
  return template.split('{{FFMPEG_VERSION}}').join(version[1]).split('{{CONFIGURATION_LINE}}').join(config[1])
    .split('{{BUILD_DESCRIPTION}}').join('the LGPL build bundled by NLC (see Source below)').split('{{LGPL_VERSION}}').join(lgpl);
}

// The files that travel beside the host program: { rel: path inside the program folder, from: file, run: needs to be runnable, notice: licence text }.
function planExtras({ target, ffmpegDir, whisperDir, noticeDir = NOTICE_DIR, centralTransportDir, centralRuntimePath }) {
  const isWin = target === 'windows-x64';
  const exe = isWin ? '.exe' : '';
  const nodeTarget = NODE_TARGET[target];
  const extras = []; const notices = [];
  const listFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  if (ffmpegDir) {
    for (const base of ['ffmpeg', 'ffprobe']) {
      if (!fs.existsSync(path.join(ffmpegDir, base + exe))) throw new Error(`ffmpeg${exe} and ffprobe${exe} were not found in ${ffmpegDir}; fetch the video tools first.`);
      extras.push({ rel: `ffmpeg/${nodeTarget}/${base}${exe}`, from: path.join(ffmpegDir, base + exe), run: true });
    }
    notices.push('NOTICE-ffmpeg.txt');
  }
  if (whisperDir) {
    if (!fs.existsSync(path.join(whisperDir, 'whisper-cli' + exe))) throw new Error(`whisper-cli${exe} was not found in ${whisperDir}; fetch the captioning tool first.`);
    for (const name of listFiles(whisperDir).filter((n) => !/^(NOTICE|LICENSE)[-\w.]*\.txt$/.test(n))) extras.push({ rel: `whisper/${nodeTarget}/${name}`, from: path.join(whisperDir, name), run: name === 'whisper-cli' + exe });
    notices.push('NOTICE-whisper.txt');
  }
  // Notices and licence texts that came with the tools (the ffmpeg workflow fills in its own NOTICE) travel as they are;
  // otherwise the template in installer/nlc-node is used.
  const NOTICE_FILE = /^(NOTICE|LICENSE)[-\w.]*\.txt$/;
  const carried = new Set();
  for (const dir of [ffmpegDir, whisperDir].filter(Boolean)) {
    for (const name of listFiles(dir).filter((n) => NOTICE_FILE.test(n))) { extras.push({ rel: name, from: path.join(dir, name), notice: true }); carried.add(name); }
  }
  for (const name of notices.filter((n) => !carried.has(n))) {
    const from = path.join(noticeDir, name);
    if (!fs.existsSync(from)) throw new Error(`${name} was not found in ${noticeDir}.`);
    let data = null;
    if (name === 'NOTICE-ffmpeg.txt') {
      let printed = '';
      try { printed = execFileSync(path.join(ffmpegDir, 'ffmpeg' + exe), ['-version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* cannot run here (other platform): leave the template as it is */ }
      data = Buffer.from(fillFfmpegNotice(fs.readFileSync(from, 'utf8'), printed), 'utf8');
    }
    extras.push({ rel: name, from, data, notice: true });
  }
  extras.push(...planCentralPackage({ centralTransportDir, centralRuntimePath, target }));
  return extras;
}

// For the Windows setup program: copies the same layout into a folder the installer packs (nothing else is staged).
function stageTools({ target, outDir, resourcesDir = '', ffmpegDir, whisperDir, noticeDir, centralTransportDir, centralRuntimePath }) {
  for (const e of planExtras({ target, ffmpegDir, whisperDir, noticeDir, centralTransportDir, centralRuntimePath })) {
    // Data files (licence texts, the Central transport) go to the app's Resources folder when one is given; only programs sit beside the host.
    const to = path.join((e.notice || e.resource) && resourcesDir ? resourcesDir : outDir, e.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (e.data) fs.writeFileSync(to, e.data); else fs.copyFileSync(e.from, to);
  }
  return outDir;
}

function buildPayload({ target, outputDir, appDir, launcherPath, hostPath, ffmpegDir, whisperDir, noticeDir = NOTICE_DIR, sign = true, centralTransportDir, centralRuntimePath } = {}) {
  if (!PAYLOAD_NAMES[target]) throw new Error('NLC Node payloads exist for macos-arm64, macos-x64 or windows-x64.');
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, PAYLOAD_NAMES[target]);
  const extras = planExtras({ target, ffmpegDir, whisperDir, noticeDir, centralTransportDir, centralRuntimePath });
  if (target === 'windows-x64') {
    if (!launcherPath || !hostPath || !fs.existsSync(launcherPath) || !fs.existsSync(hostPath)) throw new Error('Build the Windows installer parts first (the launcher and the host); they were not found.');
    const entries = [
      { name: 'NLC Node.exe', data: fs.readFileSync(launcherPath) },
      { name: 'NLC Node Host.exe', data: fs.readFileSync(hostPath) },
      ...extras.map((e) => ({ name: e.rel, data: e.data || fs.readFileSync(e.from) })),
    ];
    writeZip(file, entries);
  } else {
    if (!appDir || !fs.existsSync(path.join(appDir, 'Contents', 'MacOS'))) throw new Error(`Build the ${target} app first; NLC Node.app was not found.`);
    const placed = [];
    for (const e of extras) {
      const to = path.join(appDir, 'Contents', e.notice || e.resource ? 'Resources' : 'MacOS', e.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (e.data) fs.writeFileSync(to, e.data); else fs.copyFileSync(e.from, to);
      fs.chmodSync(to, e.run ? 0o755 : 0o644);
      if (e.run) placed.push(to);
    }
    // New programs inside a signed app break its seal: sign each (ad hoc, or with the real identity when one is set), then the app again.
    if (sign && extras.length && process.platform === 'darwin') {
      const identity = process.env.NLC_NODE_MAC_APPLICATION_IDENTITY || '-';
      const sign = (file) => execFileSync('codesign', ['--force', ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp']), '--sign', identity, file], { stdio: 'pipe' });
      for (const file of placed) sign(file);
      sign(appDir);
    }
    execFileSync('tar', ['-czf', file, '-C', path.dirname(appDir), path.basename(appDir)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  }
  const sha256 = writeSha(file);
  return { file, sha256 };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args[0];
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const outputDir = path.resolve(opt('--out', path.join(root, 'dist', 'nlc-node', 'payload')));
  const dist = path.join(root, 'dist', 'nlc-node', target || '');
  try {
    if (opt('--stage-tools', '')) {
      process.stdout.write(`${stageTools({ target, outDir: path.resolve(opt('--stage-tools', '')), resourcesDir: opt('--stage-resources', '') ? path.resolve(opt('--stage-resources', '')) : '', ffmpegDir: opt('--ffmpeg-dir', ''), whisperDir: opt('--whisper-dir', ''), centralTransportDir: opt('--central-transport-dir', process.env.NLC_NODE_WITHOUT_CENTRAL_TRANSPORT === '1' ? '' : path.join(root, 'packages', 'nlc-central-transport')), centralRuntimePath: opt('--central-runtime', process.execPath) })}\n`);
      return;
    }
    const result = buildPayload({
      target, outputDir,
      appDir: path.join(dist, 'NLC Node.app'),
      launcherPath: path.join(dist, 'NLC Node.exe'),
      hostPath: path.join(dist, 'host', 'NLC Node Host.exe'),
      ffmpegDir: opt('--ffmpeg-dir', ''),
      whisperDir: opt('--whisper-dir', ''), centralTransportDir: opt('--central-transport-dir', process.env.NLC_NODE_WITHOUT_CENTRAL_TRANSPORT === '1' ? '' : path.join(root, 'packages', 'nlc-central-transport')), centralRuntimePath: opt('--central-runtime', process.execPath),
    });
    process.stdout.write(`${result.file}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { fillFfmpegNotice, buildPayload, stageTools, planExtras, PAYLOAD_NAMES };
