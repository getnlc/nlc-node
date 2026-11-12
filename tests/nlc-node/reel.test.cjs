'use strict';
// Reel tools: video_cut_silence, audio_mix_music, reel_setup, raea_run. Real ffmpeg on small generated clips.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { NodeError } = require('../../lib/nlc-node/errors.cjs');
const V = require('../../lib/nlc-node/modules/video.cjs');
const R = require('../../lib/nlc-node/modules/reel.cjs');

const FFMPEG = process.env.TEST_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.TEST_FFPROBE || 'ffprobe';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-reel-grant-'));

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
const video = V.createVideoModule({ pathGuard, resolveFfmpeg: () => ({ ffmpeg: FFMPEG, ffprobe: FFPROBE, version: 'test' }), nodeDir: root });
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args]);
const dur = (f) => parseFloat(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }));
const meanDb = (f, from, to) => {
  return spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(to - from), '-i', f, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
};
async function finish(m, res, ms = 90000) {
  assert.ok(res.jobId);
  const end = Date.now() + ms;
  for (;;) {
    const s = await m.job_status({ job_id: res.jobId });
    if (s.state !== 'running') return s;
    if (Date.now() > end) throw new Error('job did not finish');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// 10 s: speech (tone) 0-2, silence 2-5, speech 5-7, silence 7-9.5, speech 9.5-10
function makeTalk(name) {
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=10',
    '-f', 'lavfi', '-i', "sine=frequency=300:duration=10,volume='if(between(t,2,5)+between(t,7,9.5),0,1)':eval=frame",
    '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-shortest', path.join(root, name)]);
}

test('pure: silences become the stretches to keep, with room left around speech', () => {
  const sil = V.parseSilences('silence_start: 2.0\nsilence_end: 5.0 | silence_duration: 3\nsilence_start: 9.5\n', 10);
  assert.deepStrictEqual(sil, [{ start: 2, end: 5 }, { start: 9.5, end: 10 }]);
  const plan = V.keepSegments(sil, 10, { minSilence: 0.5, pad: 0.1 });
  assert.deepStrictEqual(plan.keep.map((k) => [k.start, Math.round(k.end * 100) / 100]), [[0, 2.1], [4.9, 9.6]]);
  assert.ok(Math.abs(plan.removed - 3.2) < 0.01, String(plan.removed));
  assert.strictEqual(V.keepSegments([{ start: 1, end: 1.3 }], 10, { minSilence: 0.5 }).cut.length, 0, 'a short pause is not dead air');
});

test('pure: music volume accepts a number or decibels and refuses nonsense in plain words', () => {
  assert.strictEqual(V.parseMusicVolume(), 0.18);
  assert.strictEqual(V.parseMusicVolume('-20dB'), 0.1);
  assert.strictEqual(V.parseMusicVolume(0.5), 0.5);
  assert.throws(() => V.parseMusicVolume(4), (e) => e.code === 'BAD_ARGUMENT' && /between 0.01 and 1/.test(e.message));
});

test('video_cut_silence removes the dead air, keeps picture and sound together, and says how much it cut', async () => {
  makeTalk('talk.mp4');
  const s = await finish(video, await video.video_cut_silence({ folder: 'Footage', path: 'talk.mp4', output_name: 'talk-tight.mp4' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s.error));
  assert.ok(s.result.removed_seconds > 4.5, 'about 5 s of silence cut: ' + JSON.stringify(s.result));
  const out = path.join(root, 'talk-tight.mp4');
  const d = dur(out);
  assert.ok(Math.abs(d - s.result.new_seconds) < 0.4, `new length ${d} matches the report ${s.result.new_seconds}`);
  assert.ok(d < 6 && d > 4, 'shorter than the 10 s original: ' + d);
  const streams = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', out], { encoding: 'utf8' })).streams.map((x) => x.codec_type).sort();
  assert.deepStrictEqual(streams, ['audio', 'video']);
  // no stretch of 0.5 s or more is quiet any more
  const log = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', out, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.5', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  assert.ok(!/silence_start/.test(log), 'no dead air left');
  assert.ok(fs.existsSync(path.join(root, 'talk.mp4')), 'the original is untouched');
});

test('video_cut_silence says so when there is no dead air, and never overwrites', async () => {
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:v', 'mpeg4', '-c:a', 'aac', path.join(root, 'steady.mp4')]);
  const s = await finish(video, await video.video_cut_silence({ folder: 'Footage', path: 'steady.mp4', output_name: 'steady-out.mp4' }));
  assert.strictEqual(s.state, 'failed');
  assert.match(s.error.message, /No dead air found/);
  assert.ok(!fs.existsSync(path.join(root, 'steady-out.mp4')));
  await assert.rejects(video.video_cut_silence({ folder: 'Footage', path: 'talk.mp4', output_name: 'talk-tight.mp4' }), (e) => e.code === 'EXISTS');
  await assert.rejects(video.video_cut_silence({ folder: 'Footage', path: 'talk.mp4', output_name: 'x.mp4', min_silence: 99 }), (e) => e.code === 'BAD_ARGUMENT');
});

test('audio_mix_music puts quiet music under speech: speech stays clear, music is looped, picture is copied', async () => {
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=6',
    '-f', 'lavfi', '-i', "sine=frequency=300:duration=6,volume='if(between(t,3,6),0,1)':eval=frame", '-c:v', 'mpeg4', '-c:a', 'aac', path.join(root, 'voice.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:a', 'libmp3lame', path.join(root, 'loud-music.mp3')]); // short and full volume on purpose
  const s = await finish(video, await video.audio_mix_music({ folder: 'Footage', video_path: 'voice.mp4', music_path: 'loud-music.mp3', output_name: 'voice-music.mp4' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s.error));
  const out = path.join(root, 'voice-music.mp4');
  assert.ok(Math.abs(dur(out) - 6) < 0.3, 'same length as the video, music looped');
  const mean = (f, a, b) => parseFloat(/mean_volume: (-?[\d.]+) dB/.exec(meanDb(f, a, b))[1]);
  const speechAlone = mean(path.join(root, 'voice.mp4'), 0.5, 2.5);
  const speechMixed = mean(out, 0.5, 2.5);
  const musicOnly = mean(out, 3.5, 5.5);
  assert.ok(Math.abs(speechMixed - speechAlone) < 3, `speech level kept: ${speechAlone} -> ${speechMixed}`);
  assert.ok(musicOnly < speechMixed - 10, `music well under speech: music ${musicOnly} dB, speech ${speechMixed} dB`);
  assert.ok(musicOnly > -60, 'music is really there');
  const v = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', out], { encoding: 'utf8' })).streams.find((x) => x.codec_type === 'video');
  assert.strictEqual(v.codec_name, 'mpeg4', 'picture copied, not re-encoded');
});

test('audio_mix_music refuses a silent video and a bad volume in plain words', async () => {
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=24:duration=2', '-c:v', 'mpeg4', path.join(root, 'mute.mp4')]);
  await assert.rejects(video.audio_mix_music({ folder: 'Footage', video_path: 'mute.mp4', music_path: 'loud-music.mp3', output_name: 'm.mp4' }), (e) => e.code === 'BAD_ARGUMENT' && /no speech/.test(e.message));
  await assert.rejects(video.audio_mix_music({ folder: 'Footage', video_path: 'voice.mp4', music_path: 'loud-music.mp3', output_name: 'm.mp4', music_volume: 7 }), (e) => e.code === 'BAD_ARGUMENT');
});

test('reel_setup makes the three folders and the style skill, and a second run changes nothing', async () => {
  const reel = R.createReelModule({ pathGuard, homeDir: root });
  const a = await reel.reel_setup({ folder: 'Footage', name: 'Spring launch' });
  assert.deepStrictEqual(a.folders, { raw_footage: 'Spring launch/raw footage', references: 'Spring launch/references', exports: 'Spring launch/exports' });
  for (const d of ['raw footage', 'references', 'exports']) assert.ok(fs.statSync(path.join(root, 'Spring launch', d)).isDirectory());
  const skill = fs.readFileSync(path.join(root, 'Spring launch', R.STYLE_FILE), 'utf8');
  assert.match(skill, /Inspired by, not a copy/);
  assert.match(skill, /make the hook bigger/);
  assert.match(skill, /video_cut_silence/);
  fs.writeFileSync(path.join(root, 'Spring launch', R.STYLE_FILE), skill + '\n- Look and feel: warm, handheld\n');
  fs.writeFileSync(path.join(root, 'Spring launch', 'raw footage', 'clip.mp4'), 'x');
  const b = await reel.reel_setup({ folder: 'Footage', name: 'Spring launch' });
  assert.deepStrictEqual(b.created, []);
  assert.strictEqual(b.style_skill.created, false);
  assert.match(fs.readFileSync(path.join(root, 'Spring launch', R.STYLE_FILE), 'utf8'), /warm, handheld/, "the owner's style is never overwritten");
  assert.ok(fs.existsSync(path.join(root, 'Spring launch', 'raw footage', 'clip.mp4')));
  await assert.rejects(reel.reel_setup({ folder: 'Footage', name: '../x' }), (e) => e.code === 'BAD_ARGUMENT');
  await assert.rejects(reel.reel_setup({ folder: 'Nope', name: 'x' }), (e) => e.code === 'NOT_GRANTED');
});

test('raea_run runs the installed raea inside the shared folder (no shell) and reports the files it made', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-reel-home-'));
  fs.mkdirSync(path.join(home, '.raea', 'bin'), { recursive: true });
  const exe = path.join(home, '.raea', 'bin', process.platform === 'win32' ? 'raea.exe' : 'raea');
  fs.writeFileSync(exe, 'stub');
  fs.mkdirSync(path.join(root, 'job'), { recursive: true });
  const calls = [];
  const reel = R.createReelModule({ pathGuard, homeDir: home, runImpl: async (file, args, opt) => { calls.push({ file, args, cwd: opt.cwd }); fs.writeFileSync(path.join(opt.cwd, 'title.mp4'), 'v'); return { stdout: 'rendered\n', stderr: '' }; } });
  const r = await reel.raea_run({ folder: 'Footage', path: 'job', args: ['render', 'title.json; rm -rf /'] });
  assert.strictEqual(calls[0].file, exe);
  assert.deepStrictEqual(calls[0].args, ['render', 'title.json; rm -rf /'], 'arguments are passed as a list, never through a shell');
  assert.strictEqual(calls[0].cwd, path.join(root, 'job'));
  assert.deepStrictEqual(r.new_or_changed_files.map((f) => f.path), ['job/title.mp4']);
  await assert.rejects(reel.raea_run({ folder: 'Footage', path: 'job', args: 'render' }), (e) => e.code === 'BAD_ARGUMENT');
  await assert.rejects(reel.raea_run({ folder: 'Footage', path: '../..', args: ['guide'] }), (e) => e.code === 'OUTSIDE_GRANT');
  const none = R.createReelModule({ pathGuard, homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-reel-empty-')) });
  await assert.rejects(none.raea_run({ folder: 'Footage', path: 'job', args: ['guide'] }), (e) => e.code === 'NOT_FOUND' && /not installed/.test(e.message));
});
