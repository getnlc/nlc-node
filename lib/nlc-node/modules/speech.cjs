'use strict';
// NLC Node "speech" module (piece V3): captions from speech with whisper.cpp (MIT), run on the customer's own computer, CPU only.
// captions_from_audio takes an audio or video file inside a shared folder, extracts 16 kHz mono sound with the bundled ffmpeg,
// runs the bundled whisper-cli, and writes an SRT plus a plain transcript next to the input. It is a job (captions_status / captions_cancel).
// The speech model is not bundled: it is downloaded once on first use from a pinned address and checked against a pinned SHA-256.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { NodeError } = require('../errors.cjs');

const REPAIR = 'The captioning tool needs repair. Reinstall NLC Node.';
const FFMPEG_REPAIR = 'The video tools need repair. Reinstall NLC Node.';
const MAX_RUNNING = 1; // whisper uses every core it is given; one job at a time keeps the computer usable
const MODEL_HOSTS = ['huggingface.co'];

// ggerganov/whisper.cpp model files (MIT, OpenAI Whisper weights converted to ggml). Sizes and SHA-256 are the LFS values read from
// https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main on 24 Oct 2026. English-only model for 'en', multilingual for everything else.
const MODELS = Object.freeze({
  en: Object.freeze({ file: 'ggml-base.en.bin', size: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' }),
  multi: Object.freeze({ file: 'ggml-base.bin', size: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' }),
});

const LANGS = new Set(('en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su').split(' '));
const LANG_NAMES = { english: 'en', chinese: 'zh', mandarin: 'zh', german: 'de', spanish: 'es', russian: 'ru', korean: 'ko', french: 'fr', japanese: 'ja', portuguese: 'pt', turkish: 'tr', polish: 'pl', dutch: 'nl', arabic: 'ar', swedish: 'sv', italian: 'it', indonesian: 'id', hindi: 'hi', finnish: 'fi', vietnamese: 'vi', hebrew: 'he', ukrainian: 'uk', greek: 'el', malay: 'ms', czech: 'cs', romanian: 'ro', danish: 'da', hungarian: 'hu', tamil: 'ta', norwegian: 'no', thai: 'th', urdu: 'ur', tagalog: 'tl', filipino: 'tl' };
const STYLES = { phrases: ['-ml', '42', '-sow'], words: ['-ml', '1', '-sow'] };
const BAD_EXT = ['.mp4', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.txt', '.vtt', '.ass'];

// ---------- pure helpers (exported for tests) ----------

// 'auto', a two-letter code in any case ('FR', 'zh-CN'), or a common language name -> the code whisper wants; anything else -> null.
function normaliseLanguage(v) {
  if (v === undefined || v === null || String(v).trim() === '') return 'auto';
  const s = String(v).trim().toLowerCase();
  if (s === 'auto' || s === 'detect' || s === 'automatic') return 'auto';
  if (LANG_NAMES[s]) return LANG_NAMES[s];
  const code = s.split(/[-_]/)[0];
  return LANGS.has(code) ? code : null;
}
function normaliseStyle(v) {
  if (v === undefined || v === null || String(v).trim() === '') return 'phrases';
  const s = String(v).trim().toLowerCase();
  if (s === 'phrase' || s === 'lines' || s === 'sentences') return 'phrases';
  if (s === 'word' || s === 'word-level' || s === 'word level') return 'words';
  return STYLES[s] ? s : null;
}
// Output name: a bare name; ".srt" is added when missing. The transcript gets the same name with ".txt".
function checkOutputName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new NodeError('BAD_ARGUMENT', 'Give a file name for the captions, like "interview-captions".');
  if (/[\\/]/.test(name) || name === '.' || name === '..' || /^[A-Za-z]:/.test(name) || name.includes('\0') || /[<>:"|?*]/.test(name)) {
    throw new NodeError('BAD_ARGUMENT', 'Give just a file name, not a path.');
  }
  const ext = path.extname(name).toLowerCase();
  if (ext === '.srt') return name.slice(0, -4);
  if (BAD_EXT.includes(ext)) throw new NodeError('BAD_ARGUMENT', 'Give a name for the captions without an extension, or ending in .srt. The transcript is saved with the same name and .txt.');
  return name;
}
function lastLines(text, n = 8) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l && !/^whisper_print_progress_callback/.test(l)).slice(-n).join('\n');
}
// Parse whisper's SRT, drop empty cues (whisper emits a blank first cue in word mode), trim text, renumber.
function cleanSrt(text) {
  const cues = [];
  for (const block of String(text).replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l, i) => !(i === 0 && /^\d+$/.test(l.trim())));
    const time = lines.find((l) => /-->/.test(l));
    if (!time) continue;
    const body = lines.slice(lines.indexOf(time) + 1).map((l) => l.trim()).filter(Boolean).join('\n');
    if (body) cues.push({ time: time.trim(), body });
  }
  return cues;
}
const renderSrt = (cues) => cues.map((c, i) => `${i + 1}\n${c.time}\n${c.body}\n`).join('\n');
const renderTranscript = (cues, style) => (cues.length ? cues.map((c) => c.body.replace(/\n/g, ' ')).join(style === 'words' ? ' ' : '\n') + '\n' : '');

// ---------- module ----------

function createSpeechModule({ pathGuard, resolveFfmpeg, resolveWhisper, nodeDir, modelsDir, models = MODELS, fetchImpl = globalThis.fetch, maxRunning = MAX_RUNNING } = {}) {
  if (!pathGuard || typeof resolveFfmpeg !== 'function' || typeof resolveWhisper !== 'function' || !modelsDir) throw new Error('speech module needs pathGuard, resolveFfmpeg, resolveWhisper and modelsDir');
  const jobs = new Map();
  const verified = new Set();

  const toolsOrThrow = () => {
    let whisper;
    try { whisper = resolveWhisper({ nodeDir }); } catch (e) { throw new NodeError('FFMPEG_MISSING', REPAIR); }
    if (!whisper || !whisper.whisper) throw new NodeError('FFMPEG_MISSING', REPAIR);
    let ff;
    try { ff = resolveFfmpeg({ nodeDir }); } catch (e) { throw e instanceof NodeError ? e : new NodeError('FFMPEG_MISSING', FFMPEG_REPAIR); }
    return { whisper, ffmpeg: ff.ffmpeg };
  };
  async function input(folder, rel) {
    try { return await pathGuard.resolve(folder, rel, { intent: 'read' }); }
    catch (e) { if (e instanceof NodeError && e.code === 'NOT_FOUND' && !String(e.message).includes(String(rel))) throw new NodeError('NOT_FOUND', `${rel} was not found.`); throw e; }
  }
  const running = () => [...jobs.values()].filter((j) => j.state === 'running');
  const taken = (p) => fs.existsSync(p) || running().some((j) => j.finals.includes(p));

  // ----- model -----
  function modelProblem(m) {
    if (!m || !/^[0-9a-f]{64}$/i.test(String(m.sha256 || ''))) return 'The speech model source is not pinned, so it was not downloaded. Reinstall NLC Node.';
    let u; try { u = new URL(m.url); } catch { return 'The speech model address is not valid. Reinstall NLC Node.'; }
    if (u.protocol !== 'https:' || !MODEL_HOSTS.includes(u.hostname)) return 'The speech model source is not a trusted address, so it was not downloaded. Reinstall NLC Node.';
    return null;
  }
  const hashFile = (file) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
  async function ensureModel(job, key) {
    const m = models[key];
    const target = path.join(modelsDir, m.file);
    const bad = modelProblem(m);
    if (bad) throw new NodeError('FFMPEG_FAILED', bad);
    if (verified.has(target) && fs.existsSync(target)) return target;
    if (fs.existsSync(target)) {
      if (fs.statSync(target).size === m.size && (await hashFile(target)) === m.sha256.toLowerCase()) { verified.add(target); return target; }
      fs.rmSync(target, { force: true }); // damaged or partial copy: fetch it again
    }
    fs.mkdirSync(modelsDir, { recursive: true });
    const partial = target + '.partial-' + crypto.randomBytes(3).toString('hex');
    const down = 'The speech model could not be downloaded. Check the internet connection and try again.';
    job.phase = 'downloading the speech model';
    job.abort = new AbortController();
    let fd = null;
    try {
      let res;
      try { res = await fetchImpl(m.url, { signal: job.abort.signal }); } catch { if (job.cancelled) return null; throw new NodeError('FFMPEG_FAILED', down); }
      if (!res || !res.ok || !res.body) throw new NodeError('FFMPEG_FAILED', down);
      const hash = crypto.createHash('sha256');
      fd = fs.openSync(partial, 'w');
      let got = 0;
      try {
        for await (const chunk of res.body) {
          if (job.cancelled) return null;
          got += chunk.length;
          if (got > m.size) throw new NodeError('FFMPEG_FAILED', 'The speech model download was the wrong size and was discarded. Try again.');
          hash.update(chunk); fs.writeSync(fd, chunk);
          job.progress = Math.max(job.progress, 0.05 + 0.25 * Math.min(1, got / m.size));
        }
      } catch (e) { if (e instanceof NodeError) throw e; if (job.cancelled) return null; throw new NodeError('FFMPEG_FAILED', down); }
      fs.closeSync(fd); fd = null;
      if (got !== m.size || hash.digest('hex') !== m.sha256.toLowerCase()) throw new NodeError('FFMPEG_FAILED', 'The speech model download was damaged and was discarded. Try again.');
      fs.renameSync(partial, target);
      verified.add(target);
      return target;
    } finally {
      job.abort = null;
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      fs.rmSync(partial, { force: true });
    }
  }

  // ----- child processes -----
  function runChild(job, file, args, { cwd, onLine } = {}) {
    return new Promise((resolve) => {
      let stderr = ''; let buf = ''; let spawnError = null;
      const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      job.child = child;
      child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-8000);
        if (onLine) { buf += d; const parts = buf.split(/\r?\n|\r/); buf = parts.pop(); for (const l of parts) onLine(l); }
      });
      child.on('error', (e) => { spawnError = e; });
      child.on('close', (code) => { job.child = null; resolve({ code, stderr, spawnError }); });
    });
  }

  function startJob({ folder, outRel, finals, make }) {
    if (running().length >= maxRunning) throw new NodeError('BUSY', 'A captioning job is already running. Wait for it to finish or cancel it.');
    const id = 'job-' + crypto.randomBytes(5).toString('hex');
    const job = { id, kind: 'captions', state: 'running', progress: 0, phase: 'preparing the sound', folder, output: outRel, finals, error: null, note: null, child: null, abort: null, cancelled: false, tmp: null, partials: [] };
    jobs.set(id, job);
    if (jobs.size > 60) for (const [k, j] of jobs) { if (j.state !== 'running') { jobs.delete(k); break; } }
    const cleanup = () => {
      for (const p of job.partials) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
      if (job.tmp) { try { fs.rmSync(job.tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
    };
    const fail = (e) => { job.state = 'failed'; job.error = (e && e.toJSON ? e : new NodeError('FFMPEG_FAILED', 'The captioning tool could not finish. ' + String(e && e.message || e))).toJSON(); };
    (async () => {
      try {
        await make(job);
        if (job.cancelled) { job.state = 'cancelled'; return; }
        job.progress = 1; job.state = 'done';
      } catch (e) {
        if (job.cancelled) job.state = 'cancelled'; else fail(e);
      } finally { cleanup(); }
    })();
    return { jobId: id };
  }

  const api = {
    async captions_from_audio({ folder, path: rel, language, style, output_name } = {}) {
      const lang = normaliseLanguage(language);
      if (lang === null) throw new NodeError('BAD_ARGUMENT', 'Use one of: auto, en, es, fr, de, zh, ja, ko, pt, ru (or another two-letter language code such as it, nl, ar, hi). auto detects the language.');
      const st = normaliseStyle(style);
      if (st === null) throw new NodeError('BAD_ARGUMENT', 'style must be one of: phrases, words. phrases makes readable subtitle lines; words makes one caption per word.');
      const base = checkOutputName(output_name);
      const t = toolsOrThrow();
      const f = await input(folder, rel);
      const relDir = (() => { const d = path.posix.dirname(String(rel).replace(/\\/g, '/')); return d === '.' ? '' : d; })();
      const outSrtRel = path.posix.join(relDir, base + '.srt');
      const outTxtRel = path.posix.join(relDir, base + '.txt');
      const srt = await pathGuard.resolve(folder, outSrtRel, { intent: 'create' });
      const txt = await pathGuard.resolve(folder, outTxtRel, { intent: 'create' });
      for (const [r, name] of [[srt, base + '.srt'], [txt, base + '.txt']]) {
        if (taken(r.realPath)) throw new NodeError('EXISTS', `${name} already exists. Use mode overwrite or pick another name.`);
      }
      const modelKey = lang === 'en' ? 'en' : 'multi';
      return startJob({
        folder, outRel: outSrtRel, finals: [srt.realPath, txt.realPath],
        async make(job) {
          job.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-speech-'));
          const wav = path.join(job.tmp, 'speech.wav');
          // 1. 16 kHz mono wav (what whisper reads)
          const a = await runChild(job, t.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', f.realPath, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
          if (job.cancelled) return;
          if (a.spawnError) throw new NodeError('FFMPEG_MISSING', FFMPEG_REPAIR);
          if (a.code !== 0) {
            if (/matches no streams|does not contain any stream|Output file does not contain/i.test(a.stderr)) throw new NodeError('FFMPEG_FAILED', 'That file has no sound to caption.');
            throw new NodeError('FFMPEG_FAILED', 'The video tool could not read the sound. ffmpeg said:\n' + (lastLines(a.stderr) || 'It stopped without a message.'));
          }
          job.progress = 0.05;
          // 2. the model (first use downloads it)
          const model = await ensureModel(job, modelKey);
          if (job.cancelled || !model) return;
          job.progress = Math.max(job.progress, 0.3); job.phase = 'listening to the speech';
          // 3. whisper
          const outBase = path.join(job.tmp, 'out');
          const threads = String(Math.max(1, Math.min(4, os.cpus().length - 1)));
          const args = [...(t.whisper.prefixArgs || []), '-m', model, '-f', wav, '-l', lang, '-t', threads, '-osrt', '-of', outBase, '-pp', ...STYLES[st]];
          const w = await runChild(job, t.whisper.whisper, args, {
            cwd: t.whisper.dir,
            onLine(l) { const m = /progress\s*=\s*(\d+)%/.exec(l); if (m) job.progress = Math.max(job.progress, Math.min(0.99, 0.3 + 0.69 * (Number(m[1]) / 100))); },
          });
          if (job.cancelled) return;
          if (w.spawnError) throw new NodeError('FFMPEG_MISSING', REPAIR);
          if (w.code !== 0) throw new NodeError('FFMPEG_FAILED', 'The captioning tool could not finish. It said:\n' + (lastLines(w.stderr) || 'It stopped without a message.'));
          // 4. tidy the result and put it beside the input, never over an existing file
          const raw = fs.existsSync(outBase + '.srt') ? fs.readFileSync(outBase + '.srt', 'utf8') : '';
          const cues = cleanSrt(raw);
          if (!cues.length) { job.note = 'No speech was found in this file, so no captions were written.'; job.output = null; return; }
          const pieces = [[srt.realPath, renderSrt(cues)], [txt.realPath, renderTranscript(cues, st)]];
          for (const [fin, body] of pieces) {
            const ext = path.extname(fin);
            const part = fin.slice(0, -ext.length) + '.partial-' + crypto.randomBytes(3).toString('hex') + ext;
            job.partials.push(part);
            fs.writeFileSync(part, body, 'utf8');
          }
          for (let i = 0; i < pieces.length; i++) {
            if (fs.existsSync(pieces[i][0])) throw new NodeError('EXISTS', `${path.basename(pieces[i][0])} already exists. Use mode overwrite or pick another name.`);
          }
          pieces.forEach(([fin], i) => { fs.renameSync(job.partials[i], fin); });
          job.partials = [];
          job.cues = cues.length;
        },
      });
    },

    async captions_status({ job_id } = {}) {
      const j = jobs.get(job_id);
      if (!j) throw new NodeError('NOT_FOUND', 'There is no captioning job with that id.');
      const r = { job_id: j.id, kind: j.kind, state: j.state, progress: Math.round(j.progress * 1000) / 1000 };
      if (j.state === 'running') r.phase = j.phase;
      if (j.state === 'done') {
        if (j.output) r.output = { folder: j.folder, path: j.output, transcript_path: j.output.replace(/\.srt$/, '.txt') };
        if (j.note) r.note = j.note;
      }
      if (j.state === 'failed') r.error = j.error;
      return r;
    },

    async captions_cancel({ job_id } = {}) {
      const j = jobs.get(job_id);
      if (!j) throw new NodeError('NOT_FOUND', 'There is no captioning job with that id.');
      if (j.state !== 'running') return { job_id: j.id, state: j.state };
      j.cancelled = true;
      if (j.abort) { try { j.abort.abort(); } catch { /* ignore */ } }
      if (j.child) {
        await new Promise((resolve) => { j.child.once('close', resolve); j.child.kill(); setTimeout(resolve, 3000).unref(); });
      }
      // let the job runner finish its cleanup before answering
      const end = Date.now() + 3000;
      while (j.state === 'running' && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      return { job_id: j.id, state: j.state === 'running' ? 'cancelled' : j.state };
    },
  };
  return api;
}

const manifest = Object.freeze({ apiVersion: 'nlc-node.module/v1', id: 'speech', version: '0.1.0' });
// Descriptor for the module host: deps (pathGuard, resolveFfmpeg, resolveWhisper, nodeDir, modelsDir) are bound by the Node at startup.
function speechDescriptor(deps) {
  return {
    manifest,
    create() {
      const tools = createSpeechModule(deps);
      return { tools, async start() {}, health() { return { ok: true }; }, async stop() {} };
    },
  };
}

module.exports = { createSpeechModule, speechDescriptor, manifest, MODELS, normaliseLanguage, normaliseStyle, checkOutputName, cleanSrt, renderSrt, renderTranscript, lastLines, REPAIR };
