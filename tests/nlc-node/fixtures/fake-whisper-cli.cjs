'use strict';
// A stand-in for the whisper.cpp CLI. It honours the same flags the speech module uses
// (-m -f -l -t -ml -sow -osrt -otxt -of -pp -np) so the job flow can be proven on any machine.
// FAKE_WHISPER_MODE: ok (default) | slow | fail | silent.   FAKE_WHISPER_LOG: file that receives one JSON line per run.
const fs = require('node:fs');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const has = (f) => a.includes(f);
const mode = process.env.FAKE_WHISPER_MODE || 'ok';
const wavFile = val('-f');
const buf = fs.readFileSync(wavFile);
const wav = {
  riff: buf.toString('ascii', 0, 4) === 'RIFF',
  channels: buf.readUInt16LE(22),
  rate: buf.readUInt32LE(24),
  bytes: buf.length,
};
if (process.env.FAKE_WHISPER_LOG) fs.appendFileSync(process.env.FAKE_WHISPER_LOG, JSON.stringify({ args: a, wav, modelExists: fs.existsSync(val('-m')) }) + '\n');
if (mode === 'fail') { process.stderr.write('whisper_init_from_file_with_params_no_state: failed to load model\nerror: failed to initialize whisper context\n'); process.exit(3); }
const secs = Math.max(1, (wav.bytes - 44) / (wav.rate * 2 * wav.channels));
const stamp = (t) => { const ms = Math.round(t * 1000); const p = (n, w) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`; };
const words = has('-ml') && val('-ml') === '1';
const lines = mode === 'silent' ? [] : (words ? ['Hello', 'from', 'NLC'] : ['Hello from NLC', 'this is a test']);
const outBase = val('-of');
const per = secs / Math.max(1, lines.length);
const srt = lines.map((l, i) => `${i + 1}\n${stamp(i * per)} --> ${stamp((i + 1) * per)}\n ${l}\n`).join('\n');
const txt = lines.map((l) => l).join(has('-ml') ? ' ' : '\n') + (lines.length ? '\n' : '');
const finish = () => {
  if (has('-osrt')) fs.writeFileSync(outBase + '.srt', srt);
  if (has('-otxt')) fs.writeFileSync(outBase + '.txt', txt);
  process.exit(0);
};
if (mode === 'slow') {
  let p = 0;
  const t = setInterval(() => { p += 5; process.stderr.write(`whisper_print_progress_callback: progress = ${String(p).padStart(3)}%\n`); if (p >= 100) { clearInterval(t); finish(); } }, 100);
} else {
  process.stderr.write('whisper_print_progress_callback: progress =  50%\nwhisper_print_progress_callback: progress = 100%\n');
  finish();
}
