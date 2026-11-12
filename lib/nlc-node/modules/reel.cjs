'use strict';
// NLC Node "reel" module: the make-a-reel setup and the motion-graphics engine (raea).
//   reel_setup  one step: the raw footage, references and exports folders plus a style skill file that remembers the
//               owner's style ("inspired by these, not a copy") and takes plain-word fixes. Never overwrites anything.
//   raea_run    runs the raea program the Node installed (~/.raea/bin) inside a shared folder, for motion graphics in place of
//               Remotion or HyperFrames. No shell: arguments are passed as a list. The result is the new files it made.
// Reference videos are NOT downloaded here: the agent does that on the customer's own NLC server (the Node only talks to its NLC).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { NodeError } = require('../errors.cjs');

const FOLDERS = ['raw footage', 'references', 'exports'];
const STYLE_FILE = 'reel-style.md';
const RAEA_TIMEOUT_MS = 9 * 60 * 1000;

const bad = (m) => new NodeError('BAD_ARGUMENT', m);

function cleanName(name) {
  const n = String(name === undefined || name === null ? '' : name).trim();
  if (!n) throw bad('Give the reel a name, like "Spring launch".');
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n) || n === '.' || n === '..' || n.length > 80) throw bad('Use a plain name for the reel: no slashes or special characters, up to 80 letters.');
  return n;
}

function styleSkillText(reelName) {
  return `---
name: reel-style-${reelName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'reel'}
description: Make reels in the owner's own style. Use when the owner asks for a reel, a cut, music, captions or a change like "make the hook bigger". Inspired by the references, never a copy.
---

# Reel style: ${reelName}

Folders next to this file: "raw footage" (the owner's clips), "references" (notes and links about reels they like), "exports" (finished reels). Never change a file in "raw footage"; every result is a new file in "exports".

## The owner's style (keep this section up to date)
Fill these in from what the owner says and shows. Change a line when they correct it; never wipe the list.
- Look and feel:
- Hook (first 3 seconds):
- Pace and cuts:
- Captions (size, colour, place):
- Music (kind, how loud under speech):
- Things they never want:

## Inspired by, not a copy
Study the references for what makes them work: the hook, the rhythm, the caption style, the music. Write what you learn as notes in "references" (a short .md per reference). Reference videos are downloaded by you on the NLC server (your own shell there, for example yt-dlp for a link the owner gives), never through this computer: the Node only talks to its NLC. Look at them there (frames, captions, pace) and keep only your notes in "references" with write_text. Build the owner's reel from their own footage and their own words. Do not reuse a reference's footage, voice, script, music or exact layout.

## How to make the reel (use these steps, in this order)
1. Look at each clip in "raw footage" (media_info). Transcribe the speech (captions_from_audio).
2. Cut dead air (video_cut_silence), then trim and join the keepers (video_trim, video_join).
3. Mix music under the speech (audio_mix_music). Speech must stay clear; start at music_volume 0.18 and lower it if the owner can't hear every word.
4. Burn captions (video_captions). Add motion graphics with raea (raea_run, for example a bigger hook title in the first seconds).
5. Check the result (video_check). Save the final as a new file in "exports". Say where it is.

## Plain-word fixes
When the owner says a fix in plain words, do it as a new version in "exports" (never overwrite the last one), then update the style section above if it is a lasting preference.
- "make the hook bigger": a larger, bolder title or caption in the first 3 seconds (raea_run, or video_captions with larger text).
- "too much quiet" / "tighten it": run video_cut_silence again with min_silence 0.3.
- "music too loud" / "can't hear me": audio_mix_music again with a lower music_volume (halve it).
- "faster" / "slower": trim the pauses (video_cut_silence) or leave them; do not change speed of speech.
- "more like <reference>": read your notes on that reference and move toward its hook, rhythm and caption style, not its content.
`;
}

function defaultRun(file, args, { cwd, timeout }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') return reject(new NodeError('NOT_FOUND', 'raea is not installed on this computer. Reinstall NLC Node.'));
        if (error.killed) return reject(new NodeError('BUSY', 'raea took too long and was stopped.'));
        return reject(new NodeError('BAD_ARGUMENT', 'raea could not finish. It said:\n' + String(stderr || stdout || error.message).split(/\r?\n/).filter(Boolean).slice(-12).join('\n')));
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function listTree(dir, base = dir, out = [], depth = 0) {
  if (depth > 4 || out.length > 500) return out;
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of names) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listTree(full, base, out, depth + 1);
    else { try { const st = fs.statSync(full); out.push({ path: path.relative(base, full).split(path.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs }); } catch { /* gone */ } }
  }
  return out;
}

function createReelModule({ pathGuard, homeDir = os.homedir(), platform = process.platform, runImpl = defaultRun, exists = fs.existsSync, timeoutMs = RAEA_TIMEOUT_MS } = {}) {
  if (!pathGuard) throw new Error('reel module needs pathGuard');
  const raeaExe = () => path.join(homeDir, '.raea', 'bin', platform === 'win32' ? 'raea.exe' : 'raea');

  return {
    async reel_setup({ folder, path: rel = '', name } = {}) {
      const reel = cleanName(name);
      const base = String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const at = (sub) => (base ? base + '/' : '') + reel + (sub ? '/' + sub : '');
      const created = []; const existing = [];
      for (const sub of ['', ...FOLDERS]) {
        const r = await pathGuard.resolve(folder, at(sub), { intent: 'create' });
        if (fs.existsSync(r.realPath)) { existing.push(at(sub)); continue; }
        fs.mkdirSync(r.realPath, { recursive: false });
        created.push(at(sub));
      }
      const skillRel = at(STYLE_FILE);
      const skill = await pathGuard.resolve(folder, skillRel, { intent: 'create' });
      let skillWritten = false;
      if (!fs.existsSync(skill.realPath)) { fs.writeFileSync(skill.realPath, styleSkillText(reel), { flag: 'wx' }); skillWritten = true; }
      return {
        reel, folder, created, already_there: existing,
        folders: { raw_footage: at('raw footage'), references: at('references'), exports: at('exports') },
        style_skill: { path: skillRel, created: skillWritten },
        next: 'Read the style skill file with read_text, keep it up to date as the owner tells you their style, and put the owner clips in "raw footage". Reference videos are downloaded by you on the NLC server, not by this computer; save your notes on them in "references".',
      };
    },

    async raea_run({ folder, path: rel = '', args } = {}) {
      if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string' || a.includes('\0') || a.length > 4000)) {
        throw bad('args must be a list of text arguments for raea, like ["guide"]. Run it with ["guide"] first to read how raea works.');
      }
      const exe = raeaExe();
      if (!exists(exe)) throw new NodeError('NOT_FOUND', 'raea is not installed on this computer yet. Restart NLC Node (it installs raea at start) or reinstall it.');
      const dir = await pathGuard.resolve(folder, rel, { intent: 'read' });
      if (!fs.statSync(dir.realPath).isDirectory()) throw bad('path must be a folder inside a shared folder: raea runs there and writes its files there.');
      const before = new Map(listTree(dir.realPath).map((f) => [f.path, f.mtimeMs]));
      const res = await runImpl(exe, args, { cwd: dir.realPath, timeout: timeoutMs });
      const made = listTree(dir.realPath).filter((f) => !before.has(f.path) || before.get(f.path) !== f.mtimeMs).map((f) => ({ path: (String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') ? String(rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/' : '') + f.path, size: f.size }));
      const tail = (t) => String(t).split(/\r?\n/).slice(-60).join('\n');
      return { ok: true, folder, ran_in: rel || '', output: tail(res.stdout), notes: tail(res.stderr), new_or_changed_files: made.slice(0, 200) };
    },
  };
}

const manifest = Object.freeze({ apiVersion: 'nlc-node.module/v1', id: 'reel', version: '0.1.0' });
function reelDescriptor(deps) {
  return {
    manifest,
    create() {
      const tools = createReelModule(deps);
      return { tools, async start() {}, health() { return { ok: true }; }, async stop() {} };
    },
  };
}

module.exports = { createReelModule, reelDescriptor, manifest, styleSkillText, cleanName, FOLDERS, STYLE_FILE };
