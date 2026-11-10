'use strict';
// Pure helpers for video_check (piece V2). No ffmpeg here: these turn ffmpeg's text output and caption/transcript text
// into plain findings. Ported from Tamsin's NarratedExplainerVideo scripts (motion-steps, seam-check, caption-check).

const CHECKS = ['freeze', 'black', 'loudness', 'motion', 'captions', 'seams'];
const CHECK_ALIASES = {
  frozen: 'freeze', freezing: 'freeze', freeze: 'freeze', freezes: 'freeze', still: 'freeze',
  black: 'black', blank: 'black', 'black_frames': 'black', 'black frames': 'black', 'black-frames': 'black',
  audio: 'loudness', volume: 'loudness', sound: 'loudness', loudness: 'loudness', silence: 'loudness', loud: 'loudness',
  motion: 'motion', choppy: 'motion', smooth: 'motion', smoothness: 'motion', judder: 'motion',
  caption: 'captions', captions: 'captions', subtitles: 'captions', subtitle: 'captions',
  seam: 'seams', seams: 'seams', repeated: 'seams', repeats: 'seams', 'repeated words': 'seams', 'repeated_words': 'seams',
};
// "freeze", ["Frozen", "black"], undefined -> canonical list, or null for an unknown name (the caller refuses plainly).
function normaliseChecks(value) {
  if (value === undefined || value === null || value === '') return { list: null };
  const arr = Array.isArray(value) ? value : String(value).split(/[,\s]+/).filter(Boolean);
  const out = [];
  for (const v of arr) {
    const k = CHECK_ALIASES[String(v).trim().toLowerCase()];
    if (!k) return { bad: String(v) };
    if (!out.includes(k)) out.push(k);
  }
  return { list: out };
}

const t1 = (s) => (Math.round(Number(s) * 10) / 10).toFixed(1) + 's';

// ffmpeg -v info log of `freezedetect,blackdetect` and `volumedetect`.
function parseDetectLog(log, duration) {
  const freeze = []; const black = [];
  let cur = null;
  for (const line of String(log).split(/\r?\n/)) {
    let m;
    if ((m = /lavfi\.freezedetect\.freeze_start:\s*([\d.]+)/.exec(line))) { cur = { start: parseFloat(m[1]) }; freeze.push(cur); continue; }
    if ((m = /lavfi\.freezedetect\.freeze_end:\s*([\d.]+)/.exec(line)) && cur) { cur.end = parseFloat(m[1]); cur = null; continue; }
    if ((m = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/.exec(line))) black.push({ start: parseFloat(m[1]), end: parseFloat(m[2]) });
  }
  for (const f of freeze) if (f.end === undefined) f.end = duration || f.start; // still frozen when the file ends
  const mean = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(log), max = /max_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(log);
  const num = (m) => (m ? (m[1] === '-inf' ? -91 : parseFloat(m[1])) : null);
  return { freeze, black, loudness: mean || max ? { mean_db: num(mean), max_db: num(max) } : null };
}

// A black picture is also a frozen picture; report it once, as black.
function dropFreezeInsideBlack(freeze, black) {
  return freeze.filter((f) => !black.some((b) => f.start >= b.start - 0.35 && f.end <= b.end + 0.35));
}

function detectFindings({ freeze, black, loudness }, want, duration) {
  const out = [];
  if (want.includes('freeze')) for (const f of dropFreezeInsideBlack(freeze, black)) out.push({ kind: 'freeze', start: f.start, end: f.end, note: `Frozen picture from ${t1(f.start)} to ${t1(f.end)}.` });
  if (want.includes('black')) for (const b of black) out.push({ kind: 'black', start: b.start, end: b.end, note: `Black picture from ${t1(b.start)} to ${t1(b.end)}.` });
  if (want.includes('loudness') && loudness) {
    if (loudness.max_db <= -60) out.push({ kind: 'loudness', start: 0, end: duration, note: 'The sound is silent (nothing louder than -60 dB).' });
    else if (loudness.max_db >= -0.1) out.push({ kind: 'loudness', start: 0, end: duration, note: `The sound is too loud and probably clips (loudest point ${loudness.max_db} dB). Turn it down.` });
    else if (loudness.mean_db < -35) out.push({ kind: 'loudness', start: 0, end: duration, note: `The sound is very quiet (average ${loudness.mean_db} dB). Turn it up.` });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Per-frame brightness change (YAVG of a frame-difference picture), as printed by signalstats. Tamsin: alt2 > 0.3 = 12-step motion.
function parseYavg(text) { return [...String(text).matchAll(/YAVG=([\d.]+)/g)].map((m) => parseFloat(m[1])); }
function motionFinding(series, duration) {
  const d = series.slice(1);
  if (d.length < 10) return null;
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  if (mean < 0.05) return null; // hardly any movement: nothing to judge
  let a2 = 0;
  for (let i = 0; i < d.length; i++) a2 += (d[i] - mean) * (i % 2 ? 1 : -1);
  const alt2 = Math.abs(a2 / d.length) / mean;
  if (alt2 <= 0.3) return null;
  return { kind: 'motion', start: 0, end: duration, note: 'The movement looks choppy: the picture only changes on every second frame. Run video_smooth to fix it.' };
}

// ---- captions and transcripts ----
function tsec(h, m, s, ms) { return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, '0').slice(0, 3)) / 1000; }
function parseSrt(text) {
  const cues = [];
  for (const block of String(text).replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.length);
    const i = lines.findIndex((l) => /-->/.test(l));
    if (i < 0) continue;
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(lines[i]);
    if (!m) continue;
    const t = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    cues.push({ start: tsec(m[1], m[2], m[3], m[4]), end: tsec(m[5], m[6], m[7], m[8]), text: t });
  }
  return cues;
}
const words = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);
// Narration units: SRT cues when the text has timings, otherwise one unit per non-empty line.
function transcriptUnits(text) {
  if (/-->/.test(text)) { const c = parseSrt(text); if (c.length) return { unit: 'cue', items: c }; }
  return { unit: 'line', items: String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((t) => ({ start: null, end: null, text: t })) };
}
function seamFindings(text) {
  const { unit, items } = transcriptUnits(text);
  const out = [];
  for (let k = 0; k + 1 < items.length; k++) {
    const a = words(items[k].text), b = words(items[k + 1].text);
    let n = 0;
    for (let len = Math.min(4, a.length, b.length); len >= 1; len--) {
      if (a.slice(a.length - len).join(' ') === b.slice(0, len).join(' ')) { n = len; break; }
    }
    if (!n) continue;
    const rep = b.slice(0, n).join(' ');
    const at = items[k + 1].start;
    out.push({ kind: 'seam', start: at, end: at, note: `Repeated ${n > 1 ? 'words' : 'word'} "${rep}" at the join between ${unit} ${k + 1} and ${unit} ${k + 2}${at !== null ? ` (${t1(at)})` : ''}. Check the narration for a doubled word at the join.` });
  }
  return out;
}

module.exports = { CHECKS, normaliseChecks, parseDetectLog, detectFindings, dropFreezeInsideBlack, parseYavg, motionFinding, parseSrt, transcriptUnits, seamFindings, t1 };
