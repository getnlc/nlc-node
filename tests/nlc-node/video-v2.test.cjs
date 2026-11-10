'use strict';
// V2 tests: video_smooth, video_check and the CPU cap. Real ffmpeg on tiny generated clips; every assertion is
// what the agent sees (job result, output file facts) or what the operating system shows for the running ffmpeg.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { NodeError } = require('../../lib/nlc-node/errors.cjs');
const V = require('../../lib/nlc-node/modules/video.cjs');

const FFMPEG = process.env.TEST_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.TEST_FFPROBE || 'ffprobe';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-video2-grant-'));

const pathGuard = {
  async resolve(label, rel, { intent = 'read' } = {}) {
    if (label !== 'Footage') throw new NodeError('NOT_GRANTED', 'That folder has not been shared with me. Available folders: Footage.');
    const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
    const real = path.resolve(root, clean);
    if (real !== root && !real.startsWith(root + path.sep)) throw new NodeError('OUTSIDE_GRANT', 'That path is outside the shared folder Footage.');
    if (intent === 'read' && !fs.existsSync(real)) throw new NodeError('NOT_FOUND', `${clean} was not found.`);
    return { realPath: real, grant: { label }, relPath: path.relative(root, real).split(path.sep).join('/') };
  },
};
const resolveOk = () => ({ ffmpeg: FFMPEG, ffprobe: FFPROBE, version: 'test' });
const mk = (extra = {}) => V.createVideoModule({ pathGuard, resolveFfmpeg: resolveOk, nodeDir: root, ...extra });
const video = mk();

const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args]);
const probe = (file) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' }));
const vstream = (f) => probe(f).streams.find((s) => s.codec_type === 'video');
const fpsOf = (f) => { const [n, d] = vstream(f).avg_frame_rate.split('/').map(Number); return n / d; };
const frames = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
async function finish(m, res, ms = 90000) {
  assert.ok(res.jobId, 'a job id comes back at once');
  const end = Date.now() + ms;
  for (;;) {
    const s = await m.job_status({ job_id: res.jobId });
    if (s.state !== 'running') return s;
    if (Date.now() > end) throw new Error('job did not finish');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const rejectsWith = (p, code, re) => assert.rejects(p, (e) => e instanceof NodeError && e.code === code && (!re || re.test(e.message)), `${code} ${re || ''}`);
const run = async (args, m = video) => finish(m, await m.video_check({ folder: 'Footage', ...args }));

// 8 s clip: 0-3 s moving picture, 3-6 s frozen picture, 6-8 s black. Tone audio.
function makeComposite(name) {
  const still = path.join(root, 'still.png');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1', '-frames:v', '1', still]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=3', '-loop', '1', '-framerate', '10', '-t', '3', '-i', still,
    '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-filter_complex', '[0:v]format=yuv420p,setsar=1[a];[1:v]format=yuv420p,setsar=1,fps=10[b];[2:v]format=yuv420p,setsar=1[c];[a][b][c]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a', '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac', path.join(root, name)]);
}
function makeClean(name, { audio = 'sine=frequency=440', secs = 4, rate = 24 } = {}) {
  const args = ['-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${rate}:duration=${secs}`];
  if (audio) args.push('-f', 'lavfi', '-i', `${audio}:duration=${secs}`, '-c:a', 'aac');
  args.push('-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p', path.join(root, name));
  ff(args);
}

// ---------- CPU cap: look at the operating system's view of the running ffmpeg ----------
function findFfmpegProc(marker) {
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (cmd.some((a) => a.includes(marker)) && /ffmpeg/.test(cmd[0])) {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return { pid, cmd, nice: Number(rest[16]) }; // field 19 of stat = nice
      }
    } catch { /* process gone */ }
  }
  return null;
}
async function waitProc(marker) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const p = findFfmpegProc(marker); if (p) return p; await new Promise((r) => setTimeout(r, 50)); }
  return null;
}
const linux = process.platform === 'linux';

test('V2-CAP a running ffmpeg job has lowered priority and a thread limit (observed in /proc)', { skip: !linux }, async () => {
  makeClean('cap-src.mp4', { secs: 20 });
  const m = mk({ inputArgs: ['-re'], threads: 2 });
  const res = await m.video_proxy({ folder: 'Footage', path: 'cap-src.mp4', size: '360p', output_name: 'cap-out' });
  const p = await waitProc('cap-out.partial-');
  assert.ok(p, 'found the running ffmpeg');
  assert.ok(p.nice > 0, 'niceness is positive, got ' + p.nice);
  const i = p.cmd.indexOf('-threads');
  assert.ok(i > 0 && p.cmd[i + 1] === '2', 'threads limit is on the command line: ' + p.cmd.join(' '));
  await m.job_cancel({ job_id: res.jobId });
});

test('V2-CAP the check and smooth jobs are capped too, default threads = half the cores', { skip: !linux }, async () => {
  assert.strictEqual(V.defaultThreads(8), 4);
  assert.strictEqual(V.defaultThreads(1), 1);
  assert.strictEqual(V.defaultThreads(3), 1);
  makeClean('cap2-src.mp4', { secs: 20, rate: 10 });
  const m = mk({ inputArgs: ['-re'] });
  const chk = await m.video_check({ folder: 'Footage', path: 'cap2-src.mp4', checks: ['black'] });
  const p = await waitProc('cap2-src.mp4');
  assert.ok(p && p.nice > 0, 'check ffmpeg niceness ' + (p && p.nice));
  const want = String(V.defaultThreads());
  assert.strictEqual(p.cmd[p.cmd.indexOf('-threads') + 1], want);
  await m.job_cancel({ job_id: chk.jobId });
  const sm = await m.video_smooth({ folder: 'Footage', path: 'cap2-src.mp4', output_name: 'cap2-smooth' });
  const q = await waitProc('cap2-smooth.partial-');
  assert.ok(q && q.nice > 0 && q.cmd.includes('-threads'), 'smooth ffmpeg capped');
  await m.job_cancel({ job_id: sm.jobId });
});

// ---------- video_smooth ----------
test('V2-SMOOTH 10 fps in, 30 fps out: same length, audio kept, original untouched', async () => {
  makeClean('s10.mp4', { secs: 2, rate: 10 });
  const before = fs.readFileSync(path.join(root, 's10.mp4'));
  const s = await finish(video, await video.video_smooth({ folder: 'Footage', path: 's10.mp4', output_name: 'smooth30' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  const out = path.join(root, 'smooth30.mp4');
  assert.ok(Math.abs(fpsOf(out) - 30) < 0.5, 'fps ' + fpsOf(out));
  assert.ok(Math.abs(parseFloat(probe(out).format.duration) - 2) < 0.25);
  assert.ok(Math.abs(frames(out) - 60) <= 6, 'frames ' + frames(out));
  assert.ok(probe(out).streams.some((x) => x.codec_type === 'audio'), 'audio kept');
  assert.ok(before.equals(fs.readFileSync(path.join(root, 's10.mp4'))));
});

test('V2-SMOOTH quality good and target 48 work; numbers and spellings are accepted', async () => {
  const s = await finish(video, await video.video_smooth({ folder: 'Footage', path: 's10.mp4', target_fps: 48, quality: 'GOOD', output_name: 'smooth48' }), 180000);
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  assert.ok(Math.abs(fpsOf(path.join(root, 'smooth48.mp4')) - 48) < 0.5);
});

test('V2-SMOOTH refuses to upsample a clip that already has the target frame rate, in plain words', async () => {
  makeClean('s30.mp4', { secs: 1, rate: 30 });
  await rejectsWith(video.video_smooth({ folder: 'Footage', path: 's30.mp4', target_fps: '30', output_name: 'no' }), 'BAD_ARGUMENT', /already 30 fps.*nothing to smooth/i);
  await rejectsWith(video.video_smooth({ folder: 'Footage', path: 's30.mp4', target_fps: '25', output_name: 'no' }), 'BAD_ARGUMENT', /30, 48 or 60/);
  assert.ok(!fs.existsSync(path.join(root, 'no.mp4')));
});

test('V2-SMOOTH a choppy 12-step 24 fps clip is reported by video_check and is smooth after video_smooth', async () => {
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=12:duration=6', '-vf', 'fps=24', '-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p', path.join(root, 'choppy.mp4')]);
  const before = await run({ path: 'choppy.mp4', checks: ['motion'] });
  assert.strictEqual(before.state, 'done', JSON.stringify(before));
  const f = before.result.findings.find((x) => x.kind === 'motion');
  assert.ok(f, 'motion finding: ' + JSON.stringify(before.result));
  assert.match(f.note, /every second frame/i); assert.match(f.note, /video_smooth/);
  assert.strictEqual(before.result.ok, false);
  const s = await finish(video, await video.video_smooth({ folder: 'Footage', path: 'choppy.mp4', target_fps: '30', output_name: 'choppy-fixed' }), 120000);
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  const after = await run({ path: 'choppy-fixed.mp4', checks: ['motion'] });
  assert.strictEqual(after.result.findings.length, 0, JSON.stringify(after.result));
  assert.strictEqual(after.result.ok, true);
});

// ---------- video_check ----------
test('V2-CHECK frozen picture and black picture are found with their times, in plain English', async () => {
  makeComposite('comp.mp4');
  const s = await run({ path: 'comp.mp4' });
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  const r = s.result;
  const fr = r.findings.find((x) => x.kind === 'freeze');
  const bl = r.findings.find((x) => x.kind === 'black');
  assert.ok(fr && Math.abs(fr.start - 3) < 0.6 && Math.abs(fr.end - 6) < 0.6, JSON.stringify(r.findings));
  assert.match(fr.note, /^Frozen picture from 3\.\ds to [56]\.\ds/);
  assert.ok(bl && Math.abs(bl.start - 6) < 0.6 && Math.abs(bl.end - 8) < 0.6, JSON.stringify(r.findings));
  assert.match(bl.note, /^Black picture from [56]\.\ds to [78]\.\ds/);
  assert.strictEqual(r.findings.filter((x) => x.kind === 'freeze').length, 1, 'black part is not also reported as a second freeze');
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.loudness.mean_db === 'number' && typeof r.loudness.max_db === 'number');
});

test('V2-CHECK a clean clip passes with ok true and no findings; loudness numbers are plausible', async () => {
  makeClean('clean.mp4', { secs: 4 });
  const s = await run({ path: 'clean.mp4' });
  assert.deepStrictEqual(s.result.findings, [], JSON.stringify(s.result));
  assert.strictEqual(s.result.ok, true);
  assert.ok(s.result.loudness.mean_db < -10 && s.result.loudness.mean_db > -30, 'mean ' + s.result.loudness.mean_db);
  assert.ok(s.result.loudness.max_db <= 0 && s.result.loudness.max_db > -30);
});

test('V2-CHECK silent audio and clipping audio are reported; no audio track means loudness null and no finding', async () => {
  makeClean('silent.mp4', { audio: 'anullsrc=r=44100:cl=mono', secs: 3 });
  let s = await run({ path: 'silent.mp4', checks: ['loudness'] });
  assert.ok(s.result.findings.some((x) => x.kind === 'loudness' && /silent/i.test(x.note)), JSON.stringify(s.result));
  makeClean('loud.mp4', { audio: 'aevalsrc=sin(2*PI*440*t)', secs: 3 });
  s = await run({ path: 'loud.mp4', checks: ['loudness'] });
  assert.ok(s.result.findings.some((x) => x.kind === 'loudness' && /too loud|clip/i.test(x.note)), JSON.stringify(s.result));
  makeClean('mute.mp4', { audio: null, secs: 3 });
  s = await run({ path: 'mute.mp4', checks: ['loudness'] });
  assert.strictEqual(s.result.loudness, null);
  assert.deepStrictEqual(s.result.findings, []);
});

test('V2-CHECK only the asked checks run; spellings are accepted; a wrong name is refused with the choices', async () => {
  const s = await run({ path: 'comp.mp4', checks: ['black'] });
  assert.deepStrictEqual(s.result.findings.map((x) => x.kind), ['black']);
  const s2 = await run({ path: 'comp.mp4', checks: 'Frozen' });
  assert.deepStrictEqual(s2.result.findings.map((x) => x.kind), ['freeze']);
  await rejectsWith(video.video_check({ folder: 'Footage', path: 'comp.mp4', checks: ['sparkle'] }), 'BAD_ARGUMENT', /freeze, black, loudness, motion, captions, seams/);
  await rejectsWith(video.video_check({ folder: 'Footage', path: 'nope.mp4' }), 'NOT_FOUND', /nope\.mp4/);
  await rejectsWith(video.video_check({ folder: 'Footage', path: 'comp.mp4', checks: ['captions'] }), 'BAD_ARGUMENT', /captions_path/);
});

// Homebrew's ffmpeg on the macOS runner has no libass; the shipped build has it (checked in the ffmpeg workflow).
const HAS_SUBTITLES = /\ssubtitles\s/.test(String(require('node:child_process').spawnSync(process.env.TEST_FFMPEG || 'ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || ''));
test('V2-CHECK captions: visible ones pass, a missing caption is named with its time and text', { skip: !HAS_SUBTITLES && 'ffmpeg here has no subtitles filter (libass)' }, async () => {
  fs.writeFileSync(path.join(root, 'cap.srt'), '1\n00:00:00,500 --> 00:00:01,500\nHELLO THERE\n\n2\n00:00:02,000 --> 00:00:03,000\nSECOND LINE\n');
  ff(['-f', 'lavfi', '-i', 'color=c=0x336699:size=640x360:rate=10:duration=4', '-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p', path.join(root, 'plain.mp4')]);
  const b = await finish(video, await video.video_captions({ folder: 'Footage', path: 'plain.mp4', captions_path: 'cap.srt', output_name: 'burned' }));
  assert.strictEqual(b.state, 'done', JSON.stringify(b));
  // with the plain version as the reference
  let s = await run({ path: 'burned.mp4', checks: ['captions'], captions_path: 'cap.srt', plain_path: 'plain.mp4' });
  assert.deepStrictEqual(s.result.findings, [], JSON.stringify(s.result));
  // without a reference: the quiet moments of the same video are the reference (calm picture)
  s = await run({ path: 'burned.mp4', captions_path: 'cap.srt' });
  assert.deepStrictEqual(s.result.findings.filter((x) => x.kind === 'captions'), [], JSON.stringify(s.result));
  // captions that were never burned in are found, cue by cue
  s = await run({ path: 'plain.mp4', captions_path: 'cap.srt', plain_path: 'plain.mp4' });
  const miss = s.result.findings.filter((x) => x.kind === 'captions');
  assert.strictEqual(miss.length, 2, JSON.stringify(s.result));
  assert.match(miss[0].note, /Caption not visible at 1\.0s: "HELLO THERE"/);
  assert.ok(Math.abs(miss[1].start - 2) < 0.01 && Math.abs(miss[1].end - 3) < 0.01);
});

test('V2-CHECK repeated words at cue seams are found from the transcript (SRT or plain lines)', async () => {
  fs.writeFileSync(path.join(root, 'narr.srt'), '1\n00:00:00,000 --> 00:00:02,000\nWe walked into the\n\n2\n00:00:02,000 --> 00:00:04,000\nthe old house\n\n3\n00:00:04,000 --> 00:00:06,000\nand it was quiet\n');
  makeClean('narr.mp4', { secs: 6, audio: null });
  let s = await run({ path: 'narr.mp4', checks: ['seams'], transcript_path: 'narr.srt' });
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  assert.strictEqual(s.result.findings.length, 1, JSON.stringify(s.result));
  assert.strictEqual(s.result.findings[0].kind, 'seam');
  assert.match(s.result.findings[0].note, /"the" .*cue 1 and cue 2/);
  assert.strictEqual(s.result.findings[0].start, 2);
  fs.writeFileSync(path.join(root, 'narr.txt'), 'First we went home.\nHome was far away.\nIt rained a lot\na lot of rain fell.\n');
  s = await run({ path: 'narr.mp4', checks: ['seams'], transcript_path: 'narr.txt' });
  const kinds = s.result.findings.map((x) => x.note);
  assert.strictEqual(s.result.findings.length, 2, JSON.stringify(s.result));
  assert.ok(kinds[0].includes('"home"') && /line 1 and line 2/.test(kinds[0]));
  assert.ok(kinds[1].includes('"a lot"') && /line 3 and line 4/.test(kinds[1]));
  // giving the transcript is enough to switch the seam check on
  s = await run({ path: 'narr.mp4', transcript_path: 'narr.srt', checks: undefined });
  assert.ok(s.result.findings.some((x) => x.kind === 'seam'));
});

test('V2-CHECK a job can be cancelled', async () => {
  makeClean('long.mp4', { secs: 20, rate: 10 });
  const m = mk({ inputArgs: ['-re'] });
  const r = await m.video_check({ folder: 'Footage', path: 'long.mp4', checks: ['black'] });
  const c = await m.job_cancel({ job_id: r.jobId });
  assert.strictEqual(c.state, 'cancelled');
});

// ---------- an encoder that is listed but cannot run on this machine (VideoToolbox in a VM, NVENC with no GPU) ----------
const LISTED_BUT_UNUSABLE = String(require('node:child_process').spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '').includes(' h264_nvenc ');
test('V2-ENC a listed encoder that cannot start is skipped and the next one is used', { skip: LISTED_BUT_UNUSABLE ? false : 'no listed-but-unusable encoder in this ffmpeg' }, async () => {
  makeClean('enc-src.mp4', { rate: 24, secs: 2 });
  const m = mk({ encoderOrder: ['h264_nvenc', 'mpeg4'] });
  const s = await finish(m, await m.video_smooth({ folder: 'Footage', path: 'enc-src.mp4', output_name: 'enc-smooth' }), 120000);
  assert.equal(s.state, 'done', JSON.stringify(s));
  assert.ok(fs.existsSync(path.join(root, 'enc-smooth.mp4')));
});
