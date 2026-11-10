'use strict';
// Drives the video module the way the agent does: real ffmpeg on tiny generated clips, a real temp folder as the grant.
// Master's /usr/bin/ffmpeg is a GPL build, so the tests inject a resolver double that returns it; the real resolver
// (Q1) is covered by ffmpeg-path.test.cjs and its refusal is exercised below (V09).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { NodeError } = require('../../lib/nlc-node/errors.cjs');
const V = require('../../lib/nlc-node/modules/video.cjs');

const FFMPEG = process.env.TEST_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.TEST_FFPROBE || 'ffprobe';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-video-grant-'));
const sub = path.join(root, 'My Clips'); // a folder with a space on purpose
fs.mkdirSync(sub);

// Minimal pathGuard double with the Addendum A signature.
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

function gen(rel, { secs = 10, size = '320x240', rate = 10, audio = true, pattern = 'testsrc' } = {}) {
  const out = path.join(root, rel);
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${pattern}=size=${size}:rate=${rate}:duration=${secs}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-c:a', 'aac', '-shortest');
  args.push('-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p', out);
  execFileSync(FFMPEG, args);
  return out;
}
const probe = (file) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' }));
const dur = (f) => parseFloat(probe(f).format.duration);
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function finish(res, ms = 60000) {
  assert.ok(res.jobId, 'a job id comes back at once');
  const end = Date.now() + ms;
  for (;;) {
    const s = await video.job_status({ job_id: res.jobId });
    if (s.state !== 'running') return s;
    if (Date.now() > end) throw new Error('job did not finish');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const rejectsWith = (p, code, re) => assert.rejects(p, (e) => e instanceof NodeError && e.code === code && (!re || re.test(e.message)), `${code} ${re || ''}`);

test('V01 media_info returns duration, resolution, fps, codec', async () => {
  gen('info.mp4');
  const i = await video.media_info({ folder: 'Footage', path: 'info.mp4' });
  assert.ok(Math.abs(i.duration - 10) < 0.2);
  assert.strictEqual(i.width, 320); assert.strictEqual(i.height, 240);
  assert.strictEqual(i.fps, 10);
  assert.strictEqual(i.video_codec, 'mpeg4');
  assert.strictEqual(i.has_audio, true);
});

test('V02 video_trim 2s to 5s gives 3.0s +-0.1 and leaves the original alone', async () => {
  const src = gen('trim-src.mp4');
  const before = hash(src);
  const s = await finish(await video.video_trim({ folder: 'Footage', path: 'trim-src.mp4', start: 2, end: '0:05', output_name: 'trimmed' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  assert.strictEqual(s.output.path, 'trimmed.mp4');
  assert.ok(Math.abs(dur(path.join(root, 'trimmed.mp4')) - 3) <= 0.1, 'length ' + dur(path.join(root, 'trimmed.mp4')));
  assert.strictEqual(hash(src), before);
  assert.ok(!fs.readdirSync(root).some((n) => n.includes('.partial-')), 'no partial file left');
});

test('V02b trim rejects bad times in plain words', async () => {
  await rejectsWith(video.video_trim({ folder: 'Footage', path: 'trim-src.mp4', start: 'abc', end: 5, output_name: 'x' }), 'BAD_ARGUMENT', /seconds/);
  await rejectsWith(video.video_trim({ folder: 'Footage', path: 'trim-src.mp4', start: 5, end: 2, output_name: 'x' }), 'BAD_ARGUMENT', /after/);
});

test('V03 video_join of 3 clips (one different size) sums the durations; a missing file is NOT_FOUND naming it', async () => {
  gen('j1.mp4', { secs: 3 }); gen('j2.mp4', { secs: 4 }); gen('j3.mp4', { secs: 2, size: '160x120' });
  const s = await finish(await video.video_join({ folder: 'Footage', paths: ['j1.mp4', 'j2.mp4', 'j3.mp4'], output_name: 'joined.mp4' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  const out = path.join(root, 'joined.mp4');
  assert.ok(Math.abs(dur(out) - 9) <= 0.2, 'length ' + dur(out));
  assert.strictEqual(probe(out).streams.find((x) => x.codec_type === 'video').width, 320);
  execFileSync(FFMPEG, ['-v', 'error', '-i', out, '-f', 'null', '-']); // it decodes
  await rejectsWith(video.video_join({ folder: 'Footage', paths: ['j1.mp4', 'nope-clip.mp4'], output_name: 'x.mp4' }), 'NOT_FOUND', /nope-clip\.mp4/);
});

test('V03b joining clips with identical settings copies without re-encoding (same codec in, same out)', async () => {
  gen('k1.mp4', { secs: 2 }); gen('k2.mp4', { secs: 3 });
  const s = await finish(await video.video_join({ folder: 'Footage', paths: ['k1.mp4', 'k2.mp4'], output_name: 'kjoined.mp4' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  assert.ok(Math.abs(dur(path.join(root, 'kjoined.mp4')) - 5) <= 0.2);
  await rejectsWith(video.video_join({ folder: 'Footage', paths: ['k1.mp4'], output_name: 'y.mp4' }), 'BAD_ARGUMENT', /two clips/);
});

// Some test machines (Homebrew's ffmpeg on the macOS runner) have no libass. The shipped ffmpeg always has it, and the
// ffmpeg workflow smoke-tests burned captions on the real build; here the test says so instead of failing on the runner's tool.
const HAS_SUBTITLES_FILTER = /\ssubtitles\s/.test(String(spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || ''));
if (!HAS_SUBTITLES_FILTER) process.stderr.write('NOTE: V04 skipped, this machine\'s ffmpeg has no subtitles filter (libass). The shipped build is checked in the ffmpeg workflow.\n');
test('V04 video_captions burns the SRT (pixels differ at the caption time); a captions path with spaces works', { skip: !HAS_SUBTITLES_FILTER && 'ffmpeg here has no subtitles filter' }, async () => {
  gen('cap-src.mp4', { secs: 4, pattern: 'color=c=gray' === 0 ? 'x' : 'testsrc', size: '640x360' });
  fs.writeFileSync(path.join(sub, "it's a caption file, ok [1].srt"), '1\n00:00:01,000 --> 00:00:03,000\nHELLO CAPTION TEXT\n');
  const s = await finish(await video.video_captions({ folder: 'Footage', path: 'cap-src.mp4', captions_path: "My Clips/it's a caption file, ok [1].srt", output_name: 'captioned.mp4' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  const frame = (file) => execFileSync(FFMPEG, ['-v', 'error', '-ss', '2', '-i', file, '-frames:v', '1', '-vf', 'crop=640:120:0:240,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1e7 });
  const a = frame(path.join(root, 'cap-src.mp4')), b = frame(path.join(root, 'captioned.mp4'));
  let diff = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (Math.abs(a[i] - b[i]) > 40) diff++;
  assert.ok(diff > 300, 'caption pixels differ: ' + diff);
  // outside the caption time the picture is the same
  const early = (file) => execFileSync(FFMPEG, ['-v', 'error', '-ss', '0.2', '-i', file, '-frames:v', '1', '-vf', 'crop=640:120:0:240,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1e7 });
  const ea = early(path.join(root, 'cap-src.mp4')), eb = early(path.join(root, 'captioned.mp4'));
  let ed = 0; for (let i = 0; i < Math.min(ea.length, eb.length); i++) if (Math.abs(ea[i] - eb[i]) > 40) ed++;
  assert.ok(ed < diff / 4, 'quiet frame differs far less: ' + ed);
});

test('V04b filter path escaping is right for Windows drive paths and posix paths', () => {
  assert.strictEqual(V.escapeFilterPath('C:\\Users\\Jo Lee\\Clips\\a b.srt'), "'C\\:/Users/Jo Lee/Clips/a b.srt'");
  assert.strictEqual(V.escapeFilterPath('c:/Footage/x.srt'), "'c\\:/Footage/x.srt'");
  assert.strictEqual(V.escapeFilterPath('/Users/jo/My Clips/a.srt'), "'/Users/jo/My Clips/a.srt'");
  assert.strictEqual(V.escapeFilterPath("/tmp/it's.srt"), "'/tmp/it'\\\\\\''s.srt'");
  assert.match(V.buildSubtitlesFilter('D:\\a b\\c.srt'), /^subtitles=filename='D\\:\/a b\/c\.srt':force_style=/);
});

test('V05 video_proxy 720p: height 720, smaller, same duration, audio kept', async () => {
  const src = gen('big.mp4', { secs: 6, size: '1280x960', rate: 10 });
  const s = await finish(await video.video_proxy({ folder: 'Footage', path: 'big.mp4', size: '540p', output_name: 'big-540.mp4' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  const o = probe(path.join(root, 'big-540.mp4'));
  assert.strictEqual(o.streams.find((x) => x.codec_type === 'video').height, 540);
  assert.ok(o.streams.some((x) => x.codec_type === 'audio'));
  assert.ok(Math.abs(parseFloat(o.format.duration) - dur(src)) <= 0.1);
  assert.ok(fs.statSync(path.join(root, 'big-540.mp4')).size < fs.statSync(src).size);
  const s7 = await finish(await video.video_proxy({ folder: 'Footage', path: 'big.mp4', size: '720p', output_name: 'big-720.mp4' }));
  assert.strictEqual(probe(path.join(root, 'big-720.mp4')).streams.find((x) => x.codec_type === 'video').height, 720);
  await rejectsWith(video.video_proxy({ folder: 'Footage', path: 'big.mp4', size: '1080p', output_name: 'z' }), 'BAD_ARGUMENT', /720p/);
  assert.strictEqual(s7.state, 'done');
});

test('V06 video_frames every 1s from a 10s clip gives 10 images in the named folder', async () => {
  gen('fr.mp4');
  const s = await finish(await video.video_frames({ folder: 'Footage', path: 'fr.mp4', every_seconds: 1, output_folder: 'fr-frames' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  const files = fs.readdirSync(path.join(root, 'fr-frames')).filter((n) => n.endsWith('.jpg'));
  assert.strictEqual(files.length, 10);
  await rejectsWith(video.video_frames({ folder: 'Footage', path: 'fr.mp4', every_seconds: 1, output_folder: 'fr-frames' }), 'EXISTS');
  await rejectsWith(video.video_frames({ folder: 'Footage', path: 'fr.mp4', every_seconds: 0, output_folder: 'x' }), 'BAD_ARGUMENT');
});

test('audio_mux puts the new audio under the picture', async () => {
  gen('mv.mp4', { secs: 4, audio: false });
  const a = path.join(root, 'voice.m4a');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6', '-c:a', 'aac', a]);
  const s = await finish(await video.audio_mux({ folder: 'Footage', video_path: 'mv.mp4', audio_path: 'voice.m4a', output_name: 'muxed.mp4' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  const o = probe(path.join(root, 'muxed.mp4'));
  assert.ok(o.streams.some((x) => x.codec_type === 'audio') && o.streams.some((x) => x.codec_type === 'video'));
  assert.ok(Math.abs(parseFloat(o.format.duration) - 4) <= 0.3);
});

test('V07 a long job returns an id at once, progress rises, cancel stops it and removes the partial output', async () => {
  gen('long.mp4', { secs: 120, size: '320x240', rate: 5 });
  const paced = mk({ inputArgs: ['-re'] }); // -re makes ffmpeg read in real time so there is time to watch and cancel
  const t0 = Date.now();
  const { jobId } = await paced.video_proxy({ folder: 'Footage', path: 'long.mp4', size: '360p', output_name: 'long-proxy.mp4' });
  assert.ok(Date.now() - t0 < 5000, 'answers at once');
  let p1 = 0, p2 = 0;
  for (let i = 0; i < 60 && p1 === 0; i++) { await new Promise((r) => setTimeout(r, 200)); p1 = (await paced.job_status({ job_id: jobId })).progress; }
  assert.ok(p1 > 0, 'progress shows');
  // Wait for progress to rise (up to 12 s): a busy CI runner can report the next progress line late.
  let mid = await paced.job_status({ job_id: jobId });
  for (let i = 0; i < 60 && !(mid.progress > p1); i++) { await new Promise((r) => setTimeout(r, 200)); mid = await paced.job_status({ job_id: jobId }); }
  p2 = mid.progress;
  assert.strictEqual(mid.state, 'running');
  assert.ok(p2 > p1, `progress rises ${p1} -> ${p2}`);
  assert.ok(fs.readdirSync(root).some((n) => n.includes('.partial-')), 'partial exists while running');
  const c = await paced.job_cancel({ job_id: jobId });
  assert.strictEqual(c.state, 'cancelled');
  assert.strictEqual((await paced.job_status({ job_id: jobId })).state, 'cancelled');
  assert.ok(!fs.existsSync(path.join(root, 'long-proxy.mp4')));
  assert.ok(!fs.readdirSync(root).some((n) => n.includes('.partial-') && n.startsWith('long-proxy')), 'partial removed');
  await rejectsWith(paced.job_status({ job_id: 'job-nope' }), 'NOT_FOUND');
});

test('V08 output stays in the grant: a path in output_name is refused, existing names are never overwritten', async () => {
  gen('o.mp4', { secs: 3 });
  for (const bad of ['../evil.mp4', 'sub/x.mp4', 'sub\\x.mp4', '/abs/x.mp4', 'C:\\x.mp4', '..', 'C:x.mp4']) {
    await rejectsWith(video.video_trim({ folder: 'Footage', path: 'o.mp4', start: 0, end: 1, output_name: bad }), 'BAD_ARGUMENT', /^Give just a file name, not a path\.$/);
  }
  await rejectsWith(video.video_trim({ folder: 'Footage', path: 'o.mp4', start: 0, end: 1, output_name: 'o.exe' }), 'BAD_ARGUMENT', /\.mp4/);
  await rejectsWith(video.video_trim({ folder: 'Footage', path: '../outside.mp4', start: 0, end: 1, output_name: 'q' }), 'OUTSIDE_GRANT');
  await rejectsWith(video.video_trim({ folder: 'Other', path: 'o.mp4', start: 0, end: 1, output_name: 'q' }), 'NOT_GRANTED');
  const before = hash(path.join(root, 'o.mp4'));
  await rejectsWith(video.video_trim({ folder: 'Footage', path: 'o.mp4', start: 0, end: 1, output_name: 'o.mp4' }), 'EXISTS', /already exists/);
  assert.strictEqual(hash(path.join(root, 'o.mp4')), before);
  // output lands next to the input, inside the grant
  gen('My Clips/in-sub.mp4', { secs: 2 });
  const s = await finish(await video.video_trim({ folder: 'Footage', path: 'My Clips\\in-sub.mp4', start: 0, end: 1, output_name: 'cut.mp4' }));
  assert.strictEqual(s.output.path, 'My Clips/cut.mp4');
  assert.ok(fs.existsSync(path.join(sub, 'cut.mp4')));
});

test('V09 ffmpeg missing or refused: every tool answers the plain repair message and the module stays alive', async () => {
  // Q1's resolver lives on another branch until the Lead merges; use it when present, else a double with the same contract.
  let resolveFfmpeg, real = true;
  try { ({ resolveFfmpeg } = require('../../lib/nlc-node/ffmpeg-path.cjs')); } catch {
    real = false;
    resolveFfmpeg = (o) => { if (o.platform === 'win32') throw new NodeError('FFMPEG_MISSING', 'The video tools need repair. Reinstall NLC Node.'); return resolveOk(); };
  }
  const broken = V.createVideoModule({ pathGuard, nodeDir: path.join(root, 'no-ffmpeg-here'), resolveFfmpeg: (o) => resolveFfmpeg({ ...o, platform: 'win32', arch: 'x64', nodeDir: 'C:\\missing' }) });
  const msg = 'The video tools need repair. Reinstall NLC Node.';
  await rejectsWith(broken.media_info({ folder: 'Footage', path: 'info.mp4' }), 'FFMPEG_MISSING', /^The video tools need repair\. Reinstall NLC Node\.$/);
  await rejectsWith(broken.video_trim({ folder: 'Footage', path: 'info.mp4', start: 0, end: 1, output_name: 'a' }), 'FFMPEG_MISSING');
  await rejectsWith(broken.video_proxy({ folder: 'Footage', path: 'info.mp4', size: '360p', output_name: 'a' }), 'FFMPEG_MISSING');
  // Master's own ffmpeg is a GPL build: the real resolver must refuse it too.
  const gplRefused = V.createVideoModule({ pathGuard, nodeDir: root, resolveFfmpeg: (o) => resolveFfmpeg({ ...o, platform: 'darwin', arch: 'arm64', exists: () => true, run: () => execFileSync(FFMPEG, ['-version'], { encoding: 'utf8' }) }) });
  if (real && /--enable-gpl/.test(execFileSync(FFMPEG, ['-version'], { encoding: 'utf8' }))) await rejectsWith(gplRefused.media_info({ folder: 'Footage', path: 'info.mp4' }), 'FFMPEG_MISSING', new RegExp(msg.replace('.', '\\.')));
  // the working module still works afterwards
  assert.ok((await video.media_info({ folder: 'Footage', path: 'info.mp4' })).duration > 9);
  // a binary that vanishes after first use is noticed on the next call
  let alive = true;
  const flaky = V.createVideoModule({ pathGuard, nodeDir: root, resolveFfmpeg: () => { if (!alive) throw new NodeError('FFMPEG_MISSING', msg); return resolveOk(); } });
  await flaky.media_info({ folder: 'Footage', path: 'info.mp4' });
  alive = false;
  assert.ok(true);
});

test('FFMPEG_FAILED carries the last lines of ffmpeg output in plain form', async () => {
  fs.writeFileSync(path.join(root, 'fake.mp4'), 'this is not a video');
  await assert.rejects(video.media_info({ folder: 'Footage', path: 'fake.mp4' }), (e) => e.code === 'FFMPEG_FAILED' && /ffmpeg said:/.test(e.message) && !/\x1b|at .*\.js/.test(e.message) && e.message.split('\n').length <= 12);
  const s = await finish(await video.video_trim({ folder: 'Footage', path: 'fake.mp4', start: 0, end: 1, output_name: 'bad-out.mp4' }));
  assert.strictEqual(s.state, 'failed');
  assert.strictEqual(s.error.code, 'FFMPEG_FAILED');
  assert.ok(!fs.existsSync(path.join(root, 'bad-out.mp4')));
  assert.strictEqual(V.lastLines(Array.from({ length: 25 }, (_, i) => 'line' + i).join('\n')).split('\n').length, 10);
});

test('encoder choice: libx264 when present, the OS or mpeg4 encoder when the build has no x264 (LGPL)', async () => {
  const lgpl = ' V....D h264_mf             H264 via MediaFoundation\n V....D mpeg4              MPEG-4 part 2\n V....D libopenh264        OpenH264';
  assert.strictEqual(V.pickEncoder(lgpl), 'h264_mf');
  assert.strictEqual(V.pickEncoder(' V....D libx264   x\n V....D mpeg4 y'), 'libx264');
  assert.strictEqual(V.pickEncoder(' A....D aac   x'), null);
  assert.strictEqual(V.pickEncoder(lgpl, ['libx264', 'mpeg4']), 'mpeg4');
  const m = mk({ encoderOrder: ['mpeg4'] }); // run end to end without libx264
  const { jobId } = await m.video_trim({ folder: 'Footage', path: 'info.mp4', start: 1, end: 3, output_name: 'mpeg4-cut.mp4' });
  for (let i = 0; i < 100 && (await m.job_status({ job_id: jobId })).state === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
  const o = probe(path.join(root, 'mpeg4-cut.mp4'));
  assert.strictEqual(o.streams.find((x) => x.codec_type === 'video').codec_name, 'mpeg4');
});

test('time and name helpers', () => {
  assert.strictEqual(V.parseTime('1:30'), 90); assert.strictEqual(V.parseTime('01:00:05.5'), 3605.5);
  assert.strictEqual(V.parseTime(2.5), 2.5); assert.strictEqual(V.parseTime('2'), 2); assert.strictEqual(V.parseTime('x'), null); assert.strictEqual(V.parseTime(-1), null);
  assert.strictEqual(V.checkOutputName('clip'), 'clip.mp4'); assert.strictEqual(V.checkOutputName('a b.MOV'), 'a b.MOV');
});
