'use strict';
// NLC Node "video" module (piece Q2): thin execFile/spawn wrappers over the bundled ffmpeg (Q1).
// Command shapes follow ffmpeg-mcp-lite (MIT: trim, merge, burn subtitles, compress, info); the NarratedExplainerVideo
// pitfalls are applied (forward slashes + escaped drive colon in filter graphs, exact frame handling by re-encoding).
// Every tool resolves inputs/outputs through pathGuard (inside a grant only), never overwrites, and long work runs as a job.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { NodeError } = require('../errors.cjs');
const checks = require('../video-checks.cjs');

const REPAIR = 'The video tools need repair. Reinstall NLC Node.';
const PROXY_HEIGHTS = { '720p': 720, '540p': 540, '360p': 360 };
const OUT_EXT = ['.mp4', '.mov', '.mkv'];
const MAX_RUNNING = 2;

// ---------- CPU cap (piece V2) ----------
// The complaint: ffmpeg hogged the machine. Every ffmpeg this module starts for work (not the instant probes) gets
// (1) a thread limit: default = half the cores, at least 1; set `threads` when creating the module to change it, and
// (2) a lower operating-system priority (below normal / nice +10), set right after the process starts; set `priority`
// (an os.constants.priority value) to change it.
const cores = () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
function defaultThreads(n = cores()) { return Math.max(1, Math.floor(n / 2)); }
// -threads once for the decoder (global, before the inputs) and once just before the output for the encoder; filters too.
function capArgs(args, threads) {
  if (!args.length) return args;
  const last = args.length - 1;
  return ['-threads', String(threads), '-filter_threads', String(threads), ...args.slice(0, last), '-threads', String(threads), args[last]];
}

// ---------- pure helpers (exported for tests) ----------

// Escape a file path for use as the value of subtitles=filename='...' inside an ffmpeg filter graph.
// Backslashes become forward slashes (Windows), the drive colon and every other ':' get a backslash, quotes are re-opened safely.
function escapeFilterPath(p) {
  return "'" + String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\\\\\''") + "'";
}
function buildSubtitlesFilter(srtPath) {
  return `subtitles=filename=${escapeFilterPath(srtPath)}:force_style='FontSize=24,Outline=2,MarginV=30'`;
}

// "90", 90, "1:30", "01:30:05.5" -> seconds; anything else -> null.
function parseTime(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

// Output file name: a bare name only. Adds .mp4 when no extension is given.
function checkOutputName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new NodeError('BAD_ARGUMENT', 'Give a file name for the result.');
  if (/[\\/]/.test(name) || name === '.' || name === '..' || /^[A-Za-z]:/.test(name) || name.includes('\0') || /[<>:"|?*]/.test(name)) {
    throw new NodeError('BAD_ARGUMENT', 'Give just a file name, not a path.');
  }
  const ext = path.extname(name).toLowerCase();
  if (!ext) return name + '.mp4';
  if (!OUT_EXT.includes(ext)) throw new NodeError('BAD_ARGUMENT', 'Use a file name ending in .mp4, .mov or .mkv.');
  return name;
}

// Choose a video encoder from the `ffmpeg -encoders` listing. LGPL builds have no libx264, so fall back to the OS encoder.
const DEFAULT_ENCODER_ORDER = ['libx264', 'h264_videotoolbox', 'h264_mf', 'libopenh264', 'mpeg4'];
function pickEncoder(listing, order = DEFAULT_ENCODER_ORDER) {
  const have = new Set();
  for (const line of String(listing).split(/\r?\n/)) {
    const m = /^\s*V\S*\s+(\S+)/.exec(line);
    if (m) have.add(m[1]);
  }
  return order.find((e) => have.has(e)) || null;
}
function videoArgs(enc, kind) {
  const bitrate = kind === 'proxy' ? '2500k' : '8M';
  switch (enc) {
    case 'libx264': return ['-c:v', 'libx264', '-crf', kind === 'proxy' ? '24' : '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
    case 'mpeg4': return ['-c:v', 'mpeg4', '-q:v', kind === 'proxy' ? '5' : '3', '-pix_fmt', 'yuv420p'];
    default: return ['-c:v', enc, '-b:v', bitrate, '-pix_fmt', 'yuv420p']; // h264_videotoolbox, h264_mf, libopenh264
  }
}
const AUDIO_ARGS = ['-c:a', 'aac', '-b:a', '160k'];

function lastLines(text, n = 10) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n).join('\n');
}
function failure(stderr) {
  const tail = lastLines(stderr);
  return new NodeError('FFMPEG_FAILED', 'The video tool could not finish. ffmpeg said:\n' + (tail || 'It stopped without a message.'));
}
function runFile(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(err.code === 'ENOENT' ? new NodeError('FFMPEG_MISSING', REPAIR) : failure(stderr || err.message));
      resolve(String(stdout));
    });
  });
}
const posixDirname = (rel) => { const d = path.posix.dirname(String(rel).replace(/\\/g, '/')); return d === '.' ? '' : d; };

function summariseProbe(j) {
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const fr = v && (v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate);
  let fps = null;
  if (fr) { const [n, d] = fr.split('/').map(Number); fps = d ? Math.round((n / d) * 1000) / 1000 : n; }
  return {
    duration: j.format && j.format.duration ? Math.round(parseFloat(j.format.duration) * 1000) / 1000 : null,
    width: v ? v.width : null, height: v ? v.height : null, fps,
    video_codec: v ? v.codec_name : null, audio_codec: a ? a.codec_name : null, has_audio: !!a,
    size_bytes: j.format && j.format.size ? Number(j.format.size) : null,
    format: j.format ? j.format.format_name : null,
    _raw: { fr, v, a },
  };
}

// target_fps: 30, "30", "30 fps", 30.0 -> 30; only 30, 48 and 60 are offered.
function parseTargetFps(v) {
  if (v === undefined || v === null || v === '') return 30;
  const n = Number(String(v).toLowerCase().replace(/\s*fps$/, '').trim());
  if (![30, 48, 60].includes(n)) throw new NodeError('BAD_ARGUMENT', 'target_fps must be 30, 48 or 60.');
  return n;
}
const QUALITY_ALIASES = { fast: 'fast', quick: 'fast', draft: 'fast', low: 'fast', good: 'good', best: 'good', high: 'good', better: 'good', slow: 'good', quality: 'good' };
function parseQuality(v) {
  if (v === undefined || v === null || v === '') return 'fast';
  const q = QUALITY_ALIASES[String(v).trim().toLowerCase()];
  if (!q) throw new NodeError('BAD_ARGUMENT', 'quality must be fast or good.');
  return q;
}

// ---------- module ----------

function createVideoModule({ pathGuard, resolveFfmpeg, nodeDir, encoderOrder = DEFAULT_ENCODER_ORDER, inputArgs = [], threads = defaultThreads(), priority = os.constants.priority.PRIORITY_BELOW_NORMAL } = {}) {
  if (!pathGuard || typeof resolveFfmpeg !== 'function') throw new Error('video module needs pathGuard and resolveFfmpeg');
  const jobs = new Map();
  let bin = null; // { ffmpeg, ffprobe, encoder }

  async function tools() {
    if (bin) return bin;
    const r = resolveFfmpeg({ nodeDir }); // throws NodeError FFMPEG_MISSING
    const listing = await runFile(r.ffmpeg, ['-hide_banner', '-encoders']);
    let encoder = pickEncoder(listing, encoderOrder);
    if (!encoder) throw new NodeError('FFMPEG_MISSING', REPAIR);
    // An encoder can be listed and still not start (VideoToolbox inside a virtual machine, NVENC with no graphics card):
    // try each listed one on a tiny clip and keep the first that really works. If none does, keep the first listed.
    const listed = encoderOrder.filter((e) => pickEncoder(listing, [e]));
    if (listed.length > 1) {
      for (const e of listed) {
        const ok = await runFile(r.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=128x72:r=10:d=0.5', '-frames:v', '3', ...videoArgs(e, 'proxy'), '-f', 'null', '-']).then(() => true, () => false);
        if (ok) { encoder = e; break; }
      }
    }
    bin = { ffmpeg: r.ffmpeg, ffprobe: r.ffprobe, encoder };
    return bin;
  }
  function spawnCapped(file, args) {
    const child = spawn(file, capArgs(args, threads), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try { if (child.pid) os.setPriority(child.pid, priority); } catch { /* the cap is best effort, never a failure */ }
    return child;
  }
  async function guarded(fn) { // a vanished binary clears the cache so the next call re-checks
    try { return await fn(); } catch (e) { if (e && e.code === 'FFMPEG_MISSING') bin = null; throw e; }
  }
  async function input(folder, rel) {
    try { return await pathGuard.resolve(folder, rel, { intent: 'read' }); }
    catch (e) { if (e instanceof NodeError && e.code === 'NOT_FOUND' && !String(e.message).includes(String(rel))) throw new NodeError('NOT_FOUND', `${rel} was not found.`); throw e; }
  }
  async function probe(file) {
    const t = await tools();
    const out = await runFile(t.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    return summariseProbe(JSON.parse(out));
  }
  async function outputFile(folder, nearRel, outputName) {
    const name = checkOutputName(outputName);
    const rel = path.posix.join(posixDirname(nearRel), name);
    const r = await pathGuard.resolve(folder, rel, { intent: 'create' });
    if (fs.existsSync(r.realPath) || [...jobs.values()].some((j) => j.state === 'running' && j.finalPath === r.realPath)) {
      throw new NodeError('EXISTS', `${name} already exists. Use mode overwrite or pick another name.`);
    }
    return { realPath: r.realPath, rel, name };
  }

  function startJob({ kind, folder, outRel, finalPath, partialPath, isDir, totalSec, args, prepare }) {
    if ([...jobs.values()].filter((j) => j.state === 'running').length >= MAX_RUNNING) {
      throw new NodeError('BUSY', 'Two video jobs are already running. Wait for one to finish or cancel one.');
    }
    const id = 'job-' + crypto.randomBytes(5).toString('hex');
    const job = { id, kind, state: 'running', progress: 0, folder, output: outRel, finalPath, partialPath, isDir: !!isDir, error: null, child: null, cancelled: false, stderr: '' };
    jobs.set(id, job);
    if (jobs.size > 60) for (const [k, j] of jobs) { if (j.state !== 'running') { jobs.delete(k); break; } }
    const cleanup = () => { try { if (isDir) fs.rmSync(partialPath, { recursive: true, force: true }); else fs.rmSync(partialPath, { force: true }); } catch { /* ignore */ } };
    (async () => {
      let t;
      try { t = await tools(); } catch (e) { job.state = 'failed'; job.error = e.toJSON ? e.toJSON() : { code: 'FFMPEG_FAILED', message: String(e.message) }; return; }
      if (job.cancelled) { job.state = 'cancelled'; return; }
      let prep;
      if (prepare) {
        try { prep = await prepare(job, t); } catch (e) { if (job.cancelled) { job.state = 'cancelled'; return; } job.state = 'failed'; job.error = (e.toJSON ? e : failure(e.message)).toJSON(); cleanup(); return; }
        if (job.cancelled) { job.state = 'cancelled'; return; }
      }
      const full = ['-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats', ...args(t, partialPath, prep)];
      const child = spawnCapped(t.ffmpeg, full);
      job.child = child;
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        const lines = buf.split(/\r?\n/); buf = lines.pop();
        for (const l of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
          if (m && totalSec > 0) job.progress = Math.max(job.progress, Math.min(0.99, Number(m[1]) / 1e6 / totalSec));
        }
      });
      child.stderr.on('data', (d) => { job.stderr = (job.stderr + d).slice(-8000); });
      child.on('error', (e) => { job.state = 'failed'; job.error = (e.code === 'ENOENT' ? new NodeError('FFMPEG_MISSING', REPAIR) : failure(e.message)).toJSON(); bin = null; cleanup(); });
      child.on('close', (code) => {
        if (job.state !== 'running') return;
        if (job.cancelled) { job.state = 'cancelled'; cleanup(); return; }
        if (code !== 0) { job.state = 'failed'; job.error = failure(job.stderr).toJSON(); cleanup(); return; }
        try {
          if (isDir) { /* frames were written straight into the new folder */ } else {
            if (fs.existsSync(finalPath)) throw new NodeError('EXISTS', `${path.basename(finalPath)} already exists. Use mode overwrite or pick another name.`);
            fs.renameSync(partialPath, finalPath);
          }
          job.progress = 1; job.state = 'done';
        } catch (e) { job.state = 'failed'; job.error = (e.toJSON ? e : failure(e.message)).toJSON(); cleanup(); }
      });
    })();
    return { jobId: id };
  }
  // A job that produces a result instead of a file (video_check). run(job, tools) -> result.
  function startTaskJob({ kind, folder, run }) {
    if ([...jobs.values()].filter((j) => j.state === 'running').length >= MAX_RUNNING) {
      throw new NodeError('BUSY', 'Two video jobs are already running. Wait for one to finish or cancel one.');
    }
    const id = 'job-' + crypto.randomBytes(5).toString('hex');
    const job = { id, kind, state: 'running', progress: 0, folder, output: null, finalPath: null, partialPath: null, error: null, child: null, cancelled: false, stderr: '', result: null };
    jobs.set(id, job);
    if (jobs.size > 60) for (const [k, j] of jobs) { if (j.state !== 'running') { jobs.delete(k); break; } }
    (async () => {
      try {
        const t = await tools();
        const result = await run(job, t);
        if (job.cancelled) { job.state = 'cancelled'; return; }
        job.result = result; job.progress = 1; job.state = 'done';
      } catch (e) {
        if (job.cancelled) { job.state = 'cancelled'; return; }
        if (e && e.code === 'FFMPEG_MISSING') bin = null;
        job.state = 'failed'; job.error = (e && e.toJSON ? e : failure(e && e.message)).toJSON();
      }
    })();
    return { jobId: id };
  }
  // Run one capped ffmpeg for a task job and collect its output. binary: stdout comes back as a Buffer.
  function capture(job, t, args, { binary = false, maxBytes = 8 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      if (job.cancelled) return reject(new Error('cancelled'));
      const child = spawnCapped(t.ffmpeg, args);
      job.child = child;
      const chunks = []; let size = 0; let err = '';
      child.stdout.on('data', (d) => { if (size < maxBytes) { chunks.push(Buffer.from(d)); size += d.length; } });
      child.stderr.on('data', (d) => { if (err.length < maxBytes) err += d; });
      child.on('error', (e) => reject(e.code === 'ENOENT' ? new NodeError('FFMPEG_MISSING', REPAIR) : failure(e.message)));
      child.on('close', (code) => {
        if (job.cancelled) return reject(new Error('cancelled'));
        if (code !== 0) return reject(failure(err));
        const buf = Buffer.concat(chunks);
        resolve({ stdout: binary ? buf : buf.toString('utf8'), stderr: err });
      });
    });
  }
  const MOTION_VF = 'scale=320:180,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-';
  async function motionSeries(job, t, file) {
    const r = await capture(job, t, ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-t', '120', '-i', file, '-an', '-vf', MOTION_VF, '-f', 'null', '-']);
    return checks.parseYavg(r.stdout);
  }
  async function readText(folder, rel, what) {
    const f = await input(folder, rel);
    let st; try { st = fs.statSync(f.realPath); } catch { throw new NodeError('NOT_FOUND', `${rel} was not found.`); }
    if (st.size > 2 * 1024 * 1024) throw new NodeError('BAD_ARGUMENT', `The ${what} file is too big (over 2 MB).`);
    return fs.readFileSync(f.realPath, 'utf8');
  }
  // Captions check (ported from caption-check.cjs): for each cue, grab the bottom band of the picture at the middle of the
  // cue and compare it with the same band where no caption should be showing. A caption that is on screen changes the band.
  // Reference: plain_path (the same video without captions) at the same time, or else a quiet moment of the same video
  // where no cue is showing. Limits: without plain_path a busy, moving picture can hide a missing caption; at most 40
  // cues are sampled (spread over the whole video); only the bottom 30% of the picture is looked at.
  const BAND_VF = 'crop=iw*0.8:ih*0.3:iw*0.1:ih*0.68,scale=160:24,format=gray';
  async function bandAt(job, t, file, sec) {
    const r = await capture(job, t, ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-ss', sec.toFixed(3), ...inputArgs, '-i', file, '-an', '-frames:v', '1', '-vf', BAND_VF, '-f', 'rawvideo', '-'], { binary: true });
    return r.stdout;
  }
  // share of the band's pixels that changed clearly (text is bright with a dark outline, so an average difference would cancel out)
  const bandDiff = (x, y) => { const n = Math.min(x.length, y.length); if (!n) return 0; let d = 0; for (let i = 0; i < n; i++) if (Math.abs(x[i] - y[i]) > 30) d++; return d / n; };
  async function captionFindings(job, t, { file, plainFile, srt, duration, hasV }) {
    if (!hasV) return [];
    const all = checks.parseSrt(srt);
    if (!all.length) return [{ kind: 'captions', start: 0, end: duration, note: 'The captions file has no captions in it (no timed lines were found).' }];
    const step = Math.max(1, Math.ceil(all.length / 40));
    const sample = all.filter((_, i) => i % step === 0);
    // quiet moments of the same video: before the first cue, between cues, after the last
    const quiet = [];
    if (!plainFile) {
      const sorted = [...all].sort((p, q) => p.start - q.start);
      if (sorted[0].start > 0.6) quiet.push(sorted[0].start / 2);
      for (let i = 0; i + 1 < sorted.length; i++) if (sorted[i + 1].start - sorted[i].end > 0.6) quiet.push((sorted[i].end + sorted[i + 1].start) / 2);
      const lastEnd = Math.max(...sorted.map((c) => c.end));
      if (duration - lastEnd > 0.6) quiet.push((lastEnd + duration) / 2);
      if (!quiet.length) return [{ kind: 'captions', start: 0, end: duration, note: 'Cannot tell whether the captions are visible: they are on screen the whole time. Give plain_path, the same video without captions.' }];
    }
    const refCache = new Map();
    const out = [];
    for (const c of sample) {
      const mid = Math.min((c.start + c.end) / 2, Math.max(0, duration - 0.1));
      const here = await bandAt(job, t, file, mid);
      let ref;
      if (plainFile) ref = await bandAt(job, t, plainFile, mid);
      else {
        const q = quiet.reduce((best, x) => (Math.abs(x - mid) < Math.abs(best - mid) ? x : best), quiet[0]);
        if (!refCache.has(q)) refCache.set(q, await bandAt(job, t, file, q));
        ref = refCache.get(q);
      }
      if (bandDiff(here, ref) < 0.01) out.push({ kind: 'captions', start: c.start, end: c.end, note: `Caption not visible at ${checks.t1(mid)}: "${c.text.slice(0, 40)}"` });
    }
    return out;
  }
  const partialOf = (finalPath) => { const e = path.extname(finalPath); return finalPath.slice(0, finalPath.length - e.length) + '.partial-' + crypto.randomBytes(3).toString('hex') + e; };

  const api = {
    async media_info({ folder, path: rel }) {
      return guarded(async () => {
        const f = await input(folder, rel);
        const { _raw, ...info } = await probe(f.realPath);
        return { path: String(rel).replace(/\\/g, '/'), ...info };
      });
    },

    async video_trim({ folder, path: rel, start, end, output_name }) {
      return guarded(async () => {
        const s = parseTime(start), e = parseTime(end);
        if (s === null || e === null) throw new NodeError('BAD_ARGUMENT', 'Give start and end as seconds (like 2.5) or as minutes:seconds (like 1:30).');
        if (e <= s) throw new NodeError('BAD_ARGUMENT', 'The end time must be after the start time.');
        await tools();
        const f = await input(folder, rel);
        const out = await outputFile(folder, rel, output_name);
        // Re-encode (not stream copy): stream copy can only cut on keyframes, so the length would be off by seconds.
        return startJob({ kind: 'trim', folder, outRel: out.rel, finalPath: out.realPath, partialPath: partialOf(out.realPath), totalSec: e - s,
          args: (t, p) => [...inputArgs, '-ss', String(s), '-i', f.realPath, '-t', String(e - s), '-map', '0:v:0', '-map', '0:a:0?', ...videoArgs(t.encoder, 'quality'), ...AUDIO_ARGS, '-movflags', '+faststart', p] });
      });
    },

    async video_join({ folder, paths, output_name }) {
      return guarded(async () => {
        if (!Array.isArray(paths) || paths.length < 2) throw new NodeError('BAD_ARGUMENT', 'Give at least two clips to join, in order.');
        await tools();
        const files = [];
        for (const p of paths) files.push((await input(folder, p)).realPath);
        const out = await outputFile(folder, paths[0], output_name);
        const infos = [];
        for (const f of files) infos.push(await probe(f));
        const sig = (i) => JSON.stringify([i._raw.v && [i._raw.v.codec_name, i._raw.v.width, i._raw.v.height, i._raw.v.r_frame_rate, i._raw.v.pix_fmt], i._raw.a && [i._raw.a.codec_name, i._raw.a.sample_rate, i._raw.a.channels]]);
        const same = infos.every((i) => sig(i) === sig(infos[0]));
        const total = infos.reduce((a, i) => a + (i.duration || 0), 0);
        if (same) {
          // Same codecs, size and rate: the concat demuxer joins without re-encoding.
          const list = path.join(os.tmpdir(), 'nlc-concat-' + crypto.randomBytes(5).toString('hex') + '.txt');
          fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
          const res = startJob({ kind: 'join', folder, outRel: out.rel, finalPath: out.realPath, partialPath: partialOf(out.realPath), totalSec: total,
            args: (t, p) => [...inputArgs, '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', p] });
          const j = jobs.get(res.jobId); const watch = setInterval(() => { if (j.state !== 'running') { clearInterval(watch); try { fs.rmSync(list, { force: true }); } catch { /* ignore */ } } }, 500); watch.unref();
          return res;
        }
        // Codecs or sizes differ: concat filter with every clip scaled/padded to the first clip's size and rate, audio resampled.
        const v0 = infos[0]._raw.v;
        const W = v0.width - (v0.width % 2), H = v0.height - (v0.height % 2), R = v0.r_frame_rate && v0.r_frame_rate !== '0/0' ? v0.r_frame_rate : '30';
        const withAudio = infos.every((i) => i.has_audio);
        const parts = files.map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${R},format=yuv420p[v${i}]` + (withAudio ? `;[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]` : ''));
        const labels = files.map((_, i) => `[v${i}]` + (withAudio ? `[a${i}]` : '')).join('');
        const graph = parts.join(';') + `;${labels}concat=n=${files.length}:v=1:a=${withAudio ? 1 : 0}[v]` + (withAudio ? '[a]' : '');
        return startJob({ kind: 'join', folder, outRel: out.rel, finalPath: out.realPath, partialPath: partialOf(out.realPath), totalSec: total,
          args: (t, p) => [...inputArgs, ...files.flatMap((f) => ['-i', f]), '-filter_complex', graph, '-map', '[v]', ...(withAudio ? ['-map', '[a]'] : []), ...videoArgs(t.encoder, 'quality'), ...(withAudio ? AUDIO_ARGS : []), '-movflags', '+faststart', p] });
      });
    },

    async video_captions({ folder, path: rel, captions_path, output_name }) {
      return guarded(async () => {
        await tools();
        const f = await input(folder, rel);
        const c = await input(folder, captions_path);
        const out = await outputFile(folder, rel, output_name);
        const info = await probe(f.realPath);
        const filter = buildSubtitlesFilter(c.realPath);
        return startJob({ kind: 'captions', folder, outRel: out.rel, finalPath: out.realPath, partialPath: partialOf(out.realPath), totalSec: info.duration || 0,
          args: (t, p) => [...inputArgs, '-i', f.realPath, '-vf', filter, '-map', '0:v:0', '-map', '0:a:0?', ...videoArgs(t.encoder, 'quality'), ...(info.has_audio ? ['-c:a', 'copy'] : []), '-movflags', '+faststart', p] });
      });
    },

    async video_proxy({ folder, path: rel, size, output_name }) {
      return guarded(async () => {
        const h = PROXY_HEIGHTS[size];
        if (!h) throw new NodeError('BAD_ARGUMENT', 'Choose a size: 720p, 540p or 360p.');
        await tools();
        const f = await input(folder, rel);
        const out = await outputFile(folder, rel, output_name);
        const info = await probe(f.realPath);
        return startJob({ kind: 'proxy', folder, outRel: out.rel, finalPath: out.realPath, partialPath: partialOf(out.realPath), totalSec: info.duration || 0,
          args: (t, p) => [...inputArgs, '-i', f.realPath, '-vf', `scale=-2:min(${h}\\,ih)`, '-map', '0:v:0', '-map', '0:a:0?', ...videoArgs(t.encoder, 'proxy'), ...AUDIO_ARGS, '-movflags', '+faststart', p] });
      });
    },

    async video_frames({ folder, path: rel, every_seconds, output_folder }) {
      return guarded(async () => {
        const n = Number(every_seconds);
        if (!Number.isFinite(n) || n <= 0) throw new NodeError('BAD_ARGUMENT', 'every_seconds must be a number above 0, like 1 or 0.5.');
        if (typeof output_folder !== 'string' || !output_folder.trim()) throw new NodeError('BAD_ARGUMENT', 'Give a folder name for the pictures.');
        await tools();
        const f = await input(folder, rel);
        const o = await pathGuard.resolve(folder, output_folder, { intent: 'create' });
        if (fs.existsSync(o.realPath) && fs.readdirSync(o.realPath).length) throw new NodeError('EXISTS', `${output_folder} already exists and is not empty. Use mode overwrite or pick another name.`);
        const info = await probe(f.realPath);
        fs.mkdirSync(o.realPath, { recursive: true });
        const outRel = String(output_folder).replace(/\\/g, '/').replace(/^\.?\/+/, '');
        return startJob({ kind: 'frames', folder, outRel, finalPath: o.realPath, partialPath: o.realPath, isDir: true, totalSec: info.duration || 0,
          args: () => [...inputArgs, '-i', f.realPath, '-vf', `fps=1/${n}`, '-q:v', '3', path.join(o.realPath, 'frame_%04d.jpg')] });
      });
    },

    async audio_mux({ folder, video_path, audio_path, output_name }) {
      return guarded(async () => {
        await tools();
        const v = await input(folder, video_path);
        const a = await input(folder, audio_path);
        const out = await outputFile(folder, video_path, output_name);
        const info = await probe(v.realPath);
        return startJob({ kind: 'mux', folder, outRel: out.rel, finalPath: out.realPath, partialPath: partialOf(out.realPath), totalSec: info.duration || 0,
          args: (t, p) => [...inputArgs, '-i', v.realPath, '-i', a.realPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...AUDIO_ARGS, '-shortest', '-movflags', '+faststart', p] });
      });
    },

    // Make a choppy or low-frame-rate clip look smooth by adding in-between frames (minterpolate).
    async video_smooth({ folder, path: rel, target_fps, quality, output_name }) {
      return guarded(async () => {
        const fps = parseTargetFps(target_fps);
        const q = parseQuality(quality);
        await tools();
        const f = await input(folder, rel);
        const out = await outputFile(folder, rel, output_name);
        const info = await probe(f.realPath);
        if (info.width === null) throw new NodeError('BAD_ARGUMENT', 'That file has no picture to smooth.');
        if (info.fps && info.fps >= fps - 0.01) {
          throw new NodeError('BAD_ARGUMENT', `This video is already ${info.fps} fps, which is not lower than ${fps}. There is nothing to smooth; choose a higher target_fps or leave the video as it is.`);
        }
        const mi = q === 'good' ? `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : `minterpolate=fps=${fps}:mi_mode=blend`;
        const copyOk = ['aac', 'mp3', 'ac3', 'eac3', 'alac'].includes(info.audio_codec) || path.extname(out.realPath).toLowerCase() === '.mkv';
        const src = info.fps || 24;
        return startJob({ kind: 'smooth', folder, outRel: out.rel, finalPath: out.realPath, partialPath: partialOf(out.realPath), totalSec: info.duration || 0,
          // Tamsin's finding: "choppy" clips are often 12-step motion in a 24 fps file (every picture shown twice). Drop the
          // repeated pictures first, then interpolate, otherwise the in-between frames are built from copies.
          prepare: async (job, t) => checks.motionFinding(await motionSeries(job, t, f.realPath), info.duration) !== null,
          args: (t, p, deStep) => [...inputArgs, '-i', f.realPath, '-map', '0:v:0', '-map', '0:a:0?',
            '-vf', (deStep ? `select='not(mod(n,2))',setpts=N/(${src}/2)/TB,fps=${src / 2},` : '') + mi,
            ...videoArgs(t.encoder, 'quality'), ...(copyOk ? ['-c:a', 'copy'] : AUDIO_ARGS), '-movflags', '+faststart', p] });
      });
    },

    // Find problems in a finished video: frozen or black picture, silent / too loud / too quiet sound, choppy motion,
    // captions that are not visible, repeated words at narration seams. Returns a job; the findings are in job_status.result.
    async video_check({ folder, path: rel, checks: checksIn, captions_path, plain_path, transcript_path }) {
      return guarded(async () => {
        const n = checks.normaliseChecks(checksIn);
        if (n.bad) throw new NodeError('BAD_ARGUMENT', `"${n.bad}" is not a check. Use any of: ${checks.CHECKS.join(', ')}.`);
        const want = n.list || ['freeze', 'black', 'loudness', 'motion', ...(captions_path ? ['captions'] : []), ...(transcript_path ? ['seams'] : [])];
        if (want.includes('captions') && !captions_path) throw new NodeError('BAD_ARGUMENT', 'The captions check needs captions_path: the .srt file the captions were made from.');
        if (want.includes('seams') && !transcript_path) throw new NodeError('BAD_ARGUMENT', 'The seams check needs transcript_path: the .srt or text file of the narration.');
        await tools();
        const f = await input(folder, rel);
        const srt = want.includes('captions') ? await readText(folder, captions_path, 'captions') : null;
        const plain = want.includes('captions') && plain_path ? await input(folder, plain_path) : null;
        const transcript = want.includes('seams') ? await readText(folder, transcript_path, 'transcript') : null;
        const info = await probe(f.realPath);
        const duration = info.duration || 0;
        const hasV = info.width !== null, hasA = info.has_audio;
        return startTaskJob({ kind: 'check', folder, run: async (job, t) => {
          const findings = []; let loudness = null;
          // pass 1: freeze + black + volume in one go (black is always measured when freeze is, so a black stretch is not also reported as frozen)
          const vf = [];
          if (hasV && (want.includes('freeze'))) vf.push('freezedetect=n=-60dB:d=1');
          if (hasV && (want.includes('black') || want.includes('freeze'))) vf.push('blackdetect=d=0.5:pix_th=0.10');
          const vol = hasA && want.includes('loudness');
          if (vf.length || vol) {
            const r = await capture(job, t, ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', ...inputArgs, '-i', f.realPath,
              ...(vf.length ? ['-vf', vf.join(',')] : ['-vn']), ...(vol ? ['-af', 'volumedetect'] : ['-an']), '-f', 'null', '-']);
            const parsed = checks.parseDetectLog(r.stderr, duration);
            findings.push(...checks.detectFindings(parsed, want, duration));
            if (vol) loudness = parsed.loudness;
          }
          job.progress = 0.5;
          if (hasV && want.includes('motion')) {
            const m = checks.motionFinding(await motionSeries(job, t, f.realPath), duration);
            if (m) findings.push(m);
          }
          job.progress = 0.7;
          if (want.includes('captions')) findings.push(...await captionFindings(job, t, { file: f.realPath, plainFile: plain && plain.realPath, srt, duration, hasV }));
          if (want.includes('seams')) findings.push(...checks.seamFindings(transcript));
          findings.sort((a, b) => (a.start === null ? 1e9 : a.start) - (b.start === null ? 1e9 : b.start));
          return { ok: findings.length === 0, findings, loudness, checked: want, duration };
        } });
      });
    },

    async job_status({ job_id }) {
      const j = jobs.get(job_id);
      if (!j) throw new NodeError('NOT_FOUND', 'There is no video job with that id.');
      const r = { job_id: j.id, kind: j.kind, state: j.state, progress: Math.round(j.progress * 1000) / 1000 };
      if (j.state === 'done') r.output = { folder: j.folder, path: j.output };
      if (j.state === 'failed') r.error = j.error;
      if (j.state === 'done' && j.result) r.result = j.result;
      return r;
    },

    async job_cancel({ job_id }) {
      const j = jobs.get(job_id);
      if (!j) throw new NodeError('NOT_FOUND', 'There is no video job with that id.');
      if (j.state !== 'running') return { job_id: j.id, state: j.state };
      j.cancelled = true;
      if (j.child && j.child.exitCode === null && j.child.signalCode === null) {
        await new Promise((resolve) => { j.child.once('close', resolve); j.child.kill(); setTimeout(resolve, 3000).unref(); });
      } else if (!j.child || j.child.exitCode !== null || j.child.signalCode !== null) { j.state = 'cancelled'; }
      return { job_id: j.id, state: j.state === 'running' ? 'cancelled' : j.state };
    },
  };
  return api;
}

const manifest = Object.freeze({ apiVersion: 'nlc-node.module/v1', id: 'video', version: '0.1.0' });
// Descriptor for the module host: deps (pathGuard, resolveFfmpeg, nodeDir) are bound by the Node at startup.
function videoDescriptor(deps) {
  return {
    manifest,
    create() {
      const tools = createVideoModule(deps);
      return { tools, async start() {}, health() { return { ok: true }; }, async stop() {} };
    },
  };
}

module.exports = { defaultThreads, capArgs, parseTargetFps, parseQuality, createVideoModule, videoDescriptor, manifest, escapeFilterPath, buildSubtitlesFilter, parseTime, checkOutputName, pickEncoder, videoArgs, lastLines };
