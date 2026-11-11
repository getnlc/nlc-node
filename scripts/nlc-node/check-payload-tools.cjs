'use strict';
// A payload that goes out as the current NLC Node must carry its video and captioning tools and their notices.
// Usage: node scripts/nlc-node/check-payload-tools.cjs <payload-macos-arm64.tar.gz|payload-macos-x64.tar.gz|payload-win-x64.zip> ...
// Exit 1 and say which entry is missing when a payload has no ffmpeg, ffprobe, whisper-cli or their notices.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function listEntries(file) {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return execFileSync(tar, ['-tf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
}

function missingTools(file, entries = listEntries(file)) {
  const name = path.basename(file);
  const win = /win/i.test(name);
  const exe = win ? '.exe' : '';
  const need = [
    new RegExp(`(^|/)ffmpeg/[^/]+/ffmpeg${exe.replace('.', '\\.')}$`),
    new RegExp(`(^|/)ffmpeg/[^/]+/ffprobe${exe.replace('.', '\\.')}$`),
    new RegExp(`(^|/)whisper/[^/]+/whisper-cli${exe.replace('.', '\\.')}$`),
    /(^|\/)NOTICE-ffmpeg\.txt$/,
    /(^|\/)NOTICE-whisper\.txt$/,
  ];
  const labels = ['ffmpeg', 'ffprobe', 'whisper-cli', 'NOTICE-ffmpeg.txt', 'NOTICE-whisper.txt'];
  return labels.filter((_, i) => !entries.some((e) => need[i].test(e)));
}

module.exports = { missingTools, listEntries };

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('Usage: node scripts/nlc-node/check-payload-tools.cjs <payload file> ...'); process.exit(2); }
  let bad = 0;
  for (const f of files) {
    const missing = missingTools(f);
    if (missing.length) { bad += 1; console.error(`NO TOOLS ${path.basename(f)}: missing ${missing.join(', ')}`); } else console.log(`OK ${path.basename(f)} carries ffmpeg, ffprobe, whisper-cli and their notices`);
  }
  process.exit(bad ? 1 : 0);
}
