'use strict';
// Drives the speech module the way the agent does: real ffmpeg makes the 16 kHz wav, a FAKE whisper CLI (same flags)
// stands in for the real program so the job flow, SRT format, confinement, EXISTS, cancel and repair message are proven anywhere.
// The real whisper.cpp binary is exercised only when TEST_WHISPER_CLI, TEST_WHISPER_MODEL and TEST_WHISPER_SAMPLE are set (S14).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { NodeError } = require('../../lib/nlc-node/errors.cjs');
const S = require('../../lib/nlc-node/modules/speech.cjs');

const FFMPEG = process.env.TEST_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.TEST_FFPROBE || 'ffprobe';
const FAKE = path.join(__dirname, 'fixtures', 'fake-whisper-cli.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-speech-grant-'));
const models = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-speech-models-'));
const logFile = path.join(os.tmpdir(), 'nlc-speech-log-' + process.pid + '.jsonl');
fs.mkdirSync(path.join(root, 'My Talks'));

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
const resolveFfmpeg = () => ({ ffmpeg: FFMPEG, ffprobe: FFPROBE, version: 'test' });
const resolveFake = () => ({ whisper: process.execPath, prefixArgs: [FAKE], dir: path.dirname(FAKE) });
// A tiny model table so no real 148 MB file is needed. 'en' and 'multi' mirror the shipped table's shape.
const modelBytes = { en: Buffer.from('fake english model'), multi: Buffer.from('fake multilingual model') };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const modelTable = {
  en: { file: 'ggml-base.en.bin', url: 'https://huggingface.co/x/ggml-base.en.bin', sha256: sha(modelBytes.en), size: modelBytes.en.length },
  multi: { file: 'ggml-base.bin', url: 'https://huggingface.co/x/ggml-base.bin', sha256: sha(modelBytes.multi), size: modelBytes.multi.length },
};
function fakeFetch(calls) {
  return async (url) => {
    calls.push(String(url));
    const b = String(url).endsWith('.en.bin') ? modelBytes.en : modelBytes.multi;
    return new Response(b, { status: 200 });
  };
}
const mk = (extra = {}) => S.createSpeechModule({ pathGuard, resolveFfmpeg, resolveWhisper: resolveFake, nodeDir: root, modelsDir: models, models: modelTable, fetchImpl: fakeFetch([]), ...extra });
let speech = mk();

function gen(rel, { secs = 4, audio = true, video = true } = {}) {
  const out = path.join(root, rel);
  const args = ['-v', 'error', '-y'];
  if (video) args.push('-f', 'lavfi', '-i', `testsrc=size=160x120:rate=10:duration=${secs}`);
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`);
  if (video) args.push('-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac');
  args.push('-shortest', out);
  execFileSync(FFMPEG, args);
  return out;
}
async function finish(mod, res, ms = 60000) {
  assert.ok(res.jobId, 'a job id comes back at once');
  const end = Date.now() + ms;
  for (;;) {
    const s = await mod.captions_status({ job_id: res.jobId });
    if (s.state !== 'running') return s;
    if (Date.now() > end) throw new Error('job did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const runs = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => { try { fs.rmSync(logFile, { force: true }); } catch { /* ignore */ } process.env.FAKE_WHISPER_LOG = logFile; delete process.env.FAKE_WHISPER_MODE; };
const rejectsWith = (p, code, re) => assert.rejects(p, (e) => e instanceof NodeError && e.code === code && (!re || re.test(e.message)), `${code} ${re || ''}`);
const leftovers = () => fs.readdirSync(root).filter((n) => /partial/.test(n));
const SRT = /^1\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\n.+\n\n2\n/;

test('S01 captions_from_audio: 16 kHz mono wav goes to whisper, an SRT and a transcript land next to the input', async () => {
  reset(); gen('talk.mp4');
  const s = await finish(speech, await speech.captions_from_audio({ folder: 'Footage', path: 'talk.mp4', language: 'en', output_name: 'talk-captions' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  assert.strictEqual(s.output.path, 'talk-captions.srt');
  assert.strictEqual(s.output.transcript_path, 'talk-captions.txt');
  const srt = fs.readFileSync(path.join(root, 'talk-captions.srt'), 'utf8');
  assert.match(srt, SRT, srt);
  assert.match(fs.readFileSync(path.join(root, 'talk-captions.txt'), 'utf8'), /Hello from NLC/);
  const r = runs();
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual([r[0].wav.riff, r[0].wav.channels, r[0].wav.rate], [true, 1, 16000]);
  assert.ok(r[0].modelExists);
  assert.strictEqual(r[0].args[r[0].args.indexOf('-m') + 1], path.join(models, 'ggml-base.en.bin'));
  assert.strictEqual(r[0].args[r[0].args.indexOf('-l') + 1], 'en');
  assert.deepStrictEqual(leftovers(), [], 'no partial files left');
});

test('S02 language and style choose the model and the flags', async () => {
  reset(); gen('lang.mp4');
  await finish(speech, await speech.captions_from_audio({ folder: 'Footage', path: 'lang.mp4', language: 'auto', output_name: 'a1.srt' }));
  await finish(speech, await speech.captions_from_audio({ folder: 'Footage', path: 'lang.mp4', language: 'English', style: 'words', output_name: 'a2' }));
  await finish(speech, await speech.captions_from_audio({ folder: 'Footage', path: 'lang.mp4', output_name: 'a3' })); // defaults
  const [auto, words, def] = runs();
  assert.strictEqual(auto.args[auto.args.indexOf('-l') + 1], 'auto');
  assert.ok(auto.args[auto.args.indexOf('-m') + 1].endsWith('ggml-base.bin'), 'auto needs the multilingual model');
  const ml = (r) => r.args[r.args.indexOf('-ml') + 1];
  assert.strictEqual(ml(words), '1'); assert.ok(words.args.includes('-sow'));
  assert.strictEqual(words.args[words.args.indexOf('-l') + 1], 'en');
  assert.notStrictEqual(ml(def), '1'); assert.ok(def.args.includes('-sow'));
  assert.strictEqual(def.args[def.args.indexOf('-l') + 1], 'auto', 'default language is auto');
  assert.match(fs.readFileSync(path.join(root, 'a2.srt'), 'utf8'), /Hello\n/);
});

test('S03 an unknown language is refused in plain words; names and codes are accepted in any case', async () => {
  gen('l2.mp4');
  await rejectsWith(speech.captions_from_audio({ folder: 'Footage', path: 'l2.mp4', language: 'klingon', output_name: 'x' }), 'BAD_ARGUMENT', /auto, en/);
  await rejectsWith(speech.captions_from_audio({ folder: 'Footage', path: 'l2.mp4', style: 'karaoke', output_name: 'x' }), 'BAD_ARGUMENT', /phrases, words/);
  assert.strictEqual(S.normaliseLanguage('FR'), 'fr');
  assert.strictEqual(S.normaliseLanguage(' Spanish '), 'es');
  assert.strictEqual(S.normaliseLanguage(undefined), 'auto');
  assert.strictEqual(S.normaliseLanguage('zh-CN'), 'zh');
  assert.strictEqual(S.normaliseLanguage('xx'), null);
});

test('S04 confinement: outside the grant, not shared, missing file, and output names that are paths', async () => {
  gen('c.mp4');
  await rejectsWith(speech.captions_from_audio({ folder: 'Footage', path: '../secret.mp4', output_name: 'o' }), 'OUTSIDE_GRANT');
  await rejectsWith(speech.captions_from_audio({ folder: 'Other', path: 'c.mp4', output_name: 'o' }), 'NOT_GRANTED');
  await rejectsWith(speech.captions_from_audio({ folder: 'Footage', path: 'nope.mp4', output_name: 'o' }), 'NOT_FOUND', /nope\.mp4/);
  for (const bad of ['../o.srt', 'sub/o.srt', 'C:\\o.srt', 'o.mp4', 'o.txt', '', '..', 'a|b']) {
    await rejectsWith(speech.captions_from_audio({ folder: 'Footage', path: 'c.mp4', output_name: bad }), 'BAD_ARGUMENT');
  }
  assert.strictEqual(fs.existsSync(path.join(root, '..', 'o.srt')), false);
});

test('S05 the result is written beside the input, in its subfolder', async () => {
  reset(); gen(path.join('My Talks', 'sub.mp4'));
  const s = await finish(speech, await speech.captions_from_audio({ folder: 'Footage', path: 'My Talks/sub.mp4', output_name: 'sub' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  assert.strictEqual(s.output.path, 'My Talks/sub.srt');
  assert.ok(fs.existsSync(path.join(root, 'My Talks', 'sub.srt')) && fs.existsSync(path.join(root, 'My Talks', 'sub.txt')));
});

test('S06 EXISTS: never overwrites the captions or the transcript, also while another job holds the name', async () => {
  reset(); gen('e.mp4');
  fs.writeFileSync(path.join(root, 'keep.srt'), 'MINE');
  await rejectsWith(speech.captions_from_audio({ folder: 'Footage', path: 'e.mp4', output_name: 'keep' }), 'EXISTS', /keep\.srt/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'keep.srt'), 'utf8'), 'MINE');
  fs.writeFileSync(path.join(root, 'only-txt.txt'), 'MINE2');
  await rejectsWith(speech.captions_from_audio({ folder: 'Footage', path: 'e.mp4', output_name: 'only-txt' }), 'EXISTS', /only-txt\.txt/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'only-txt.txt'), 'utf8'), 'MINE2');
  process.env.FAKE_WHISPER_MODE = 'slow';
  const first = await speech.captions_from_audio({ folder: 'Footage', path: 'e.mp4', output_name: 'dup' });
  await rejectsWith(speech.captions_from_audio({ folder: 'Footage', path: 'e.mp4', output_name: 'dup' }), 'EXISTS');
  await speech.captions_cancel({ job_id: first.jobId });
});

test('S07 progress rises while whisper works, cancel stops it and leaves no files behind', async () => {
  reset(); gen('slow.mp4');
  process.env.FAKE_WHISPER_MODE = 'slow';
  const t0 = Date.now();
  const res = await speech.captions_from_audio({ folder: 'Footage', path: 'slow.mp4', language: 'en', output_name: 'slow-out' });
  assert.ok(Date.now() - t0 < 5000, 'job id comes back at once');
  let seen = 0; const end = Date.now() + 20000;
  while (Date.now() < end) { seen = (await speech.captions_status({ job_id: res.jobId })).progress; if (seen > 0.2) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(seen > 0.2, 'progress rose to ' + seen);
  const c = await speech.captions_cancel({ job_id: res.jobId });
  assert.strictEqual(c.state, 'cancelled');
  assert.strictEqual((await speech.captions_status({ job_id: res.jobId })).state, 'cancelled');
  assert.strictEqual(fs.existsSync(path.join(root, 'slow-out.srt')), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'slow-out.txt')), false);
  assert.deepStrictEqual(leftovers(), []);
  await rejectsWith(speech.captions_status({ job_id: 'job-nope' }), 'NOT_FOUND');
});

test('S08 only one captioning job at a time (BUSY)', async () => {
  reset(); gen('b.mp4');
  process.env.FAKE_WHISPER_MODE = 'slow';
  const a = await speech.captions_from_audio({ folder: 'Footage', path: 'b.mp4', output_name: 'busy1' });
  await rejectsWith(speech.captions_from_audio({ folder: 'Footage', path: 'b.mp4', output_name: 'busy2' }), 'BUSY');
  await speech.captions_cancel({ job_id: a.jobId });
});

test('S09 missing captioning tool: the repair message from the tool, the module stays alive and notices a repair', async () => {
  reset(); gen('m.mp4');
  let broken = true;
  const m = mk({ resolveWhisper: () => { if (broken) throw new NodeError('FFMPEG_MISSING', 'x'); return resolveFake(); } });
  await rejectsWith(m.captions_from_audio({ folder: 'Footage', path: 'm.mp4', output_name: 'm1' }), 'FFMPEG_MISSING', /^The captioning tool needs repair\. Reinstall NLC Node\.$/);
  broken = false;
  const s = await finish(m, await m.captions_from_audio({ folder: 'Footage', path: 'm.mp4', output_name: 'm1' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  const gone = mk({ resolveWhisper: () => ({ whisper: path.join(root, 'no-such-whisper'), dir: root }) });
  const r = await finish(gone, await gone.captions_from_audio({ folder: 'Footage', path: 'm.mp4', output_name: 'm2' }));
  assert.strictEqual(r.state, 'failed');
  assert.strictEqual(r.error.message, 'The captioning tool needs repair. Reinstall NLC Node.');
  const noFfmpeg = mk({ resolveFfmpeg: () => { throw new NodeError('FFMPEG_MISSING', 'The video tools need repair. Reinstall NLC Node.'); } });
  await rejectsWith(noFfmpeg.captions_from_audio({ folder: 'Footage', path: 'm.mp4', output_name: 'm3' }), 'FFMPEG_MISSING');
});

test('S10 a failing whisper run reports its last lines and leaves nothing behind', async () => {
  reset(); gen('f.mp4');
  process.env.FAKE_WHISPER_MODE = 'fail';
  const s = await finish(speech, await speech.captions_from_audio({ folder: 'Footage', path: 'f.mp4', output_name: 'fail-out' }));
  assert.strictEqual(s.state, 'failed');
  assert.strictEqual(s.error.code, 'FFMPEG_FAILED');
  assert.match(s.error.message, /^The captioning tool could not finish\. It said:\n[\s\S]*failed to initialize whisper context/);
  assert.strictEqual(fs.existsSync(path.join(root, 'fail-out.srt')), false);
  assert.deepStrictEqual(leftovers(), []);
});

test('S11 a file with no sound fails in plain words; silence gives a done job that says no speech was found', async () => {
  reset(); gen('mute.mp4', { audio: false });
  const s = await finish(speech, await speech.captions_from_audio({ folder: 'Footage', path: 'mute.mp4', output_name: 'mute-out' }));
  assert.strictEqual(s.state, 'failed');
  assert.match(s.error.message, /no sound/i);
  assert.strictEqual(runs().length, 0, 'whisper was not started');
  gen('quiet.mp4');
  process.env.FAKE_WHISPER_MODE = 'silent';
  const q = await finish(speech, await speech.captions_from_audio({ folder: 'Footage', path: 'quiet.mp4', output_name: 'quiet-out' }));
  assert.strictEqual(q.state, 'done');
  assert.match(q.note, /No speech was found/);
});

test('S12 audio-only input works', async () => {
  reset(); gen('voice.m4a', { video: false });
  const s = await finish(speech, await speech.captions_from_audio({ folder: 'Footage', path: 'voice.m4a', language: 'en', output_name: 'voice' }));
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  assert.match(fs.readFileSync(path.join(root, 'voice.srt'), 'utf8'), SRT);
});

test('S13 the model is fetched once from the pinned address, hash-checked, and kept; a wrong hash is refused and nothing is kept', async () => {
  reset(); gen('mf.mp4');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-speech-models2-'));
  const calls = [];
  const m = mk({ modelsDir: dir, fetchImpl: fakeFetch(calls) });
  const s1 = await finish(m, await m.captions_from_audio({ folder: 'Footage', path: 'mf.mp4', language: 'en', output_name: 'mf1' }));
  assert.strictEqual(s1.state, 'done', JSON.stringify(s1));
  assert.deepStrictEqual(calls, [modelTable.en.url]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ggml-base.en.bin'), 'utf8'), 'fake english model');
  await finish(m, await m.captions_from_audio({ folder: 'Footage', path: 'mf.mp4', language: 'en', output_name: 'mf2' }));
  assert.strictEqual(calls.length, 1, 'no second download');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-speech-models3-'));
  const bad = mk({ modelsDir: dir2, fetchImpl: async () => new Response(Buffer.from('tampered tampered '), { status: 200 }) });
  const s2 = await finish(bad, await bad.captions_from_audio({ folder: 'Footage', path: 'mf.mp4', language: 'en', output_name: 'mf3' }));
  assert.strictEqual(s2.state, 'failed');
  assert.match(s2.error.message, /speech model/i);
  assert.deepStrictEqual(fs.readdirSync(dir2), [], 'nothing kept');
  const down = mk({ modelsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-speech-models4-')), fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  const s3 = await finish(down, await down.captions_from_audio({ folder: 'Footage', path: 'mf.mp4', language: 'en', output_name: 'mf4' }));
  assert.strictEqual(s3.state, 'failed');
  assert.match(s3.error.message, /internet connection/i);
  assert.strictEqual(fs.existsSync(path.join(root, 'mf4.srt')), false);
});

test('S14 a model entry that is unpinned or from another host is never downloaded', async () => {
  reset(); gen('mu.mp4');
  const calls = [];
  for (const entry of [
    { ...modelTable.en, sha256: null },
    { ...modelTable.en, url: 'https://evil.example.com/ggml-base.en.bin' },
    { ...modelTable.en, url: 'http://huggingface.co/x/ggml-base.en.bin' },
  ]) {
    const m = mk({ modelsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-speech-models5-')), models: { ...modelTable, en: entry }, fetchImpl: fakeFetch(calls) });
    const s = await finish(m, await m.captions_from_audio({ folder: 'Footage', path: 'mu.mp4', language: 'en', output_name: 'mu' + Math.random().toString(36).slice(2, 6) }));
    assert.strictEqual(s.state, 'failed');
    assert.match(s.error.message, /speech model/i);
  }
  assert.strictEqual(calls.length, 0, 'no download was attempted');
});

test('S15 the shipped model table is pinned, over https from huggingface.co, and English-only vs multilingual', () => {
  assert.strictEqual(S.MODELS.en.file, 'ggml-base.en.bin');
  assert.strictEqual(S.MODELS.multi.file, 'ggml-base.bin');
  for (const m of Object.values(S.MODELS)) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.url.startsWith('https://huggingface.co/ggerganov/whisper.cpp/'));
    assert.ok(m.size > 100e6 && m.size < 200e6);
  }
  const d = S.speechDescriptor({ pathGuard, resolveFfmpeg, resolveWhisper: resolveFake, nodeDir: root, modelsDir: models });
  assert.strictEqual(d.manifest.id, 'speech');
  const inst = d.create();
  assert.deepStrictEqual(Object.keys(inst.tools).sort(), ['captions_cancel', 'captions_from_audio', 'captions_status']);
});

test('S16 REAL whisper.cpp binary on real speech (runs only when TEST_WHISPER_CLI, TEST_WHISPER_MODEL, TEST_WHISPER_SAMPLE are set)', { skip: !(process.env.TEST_WHISPER_CLI && process.env.TEST_WHISPER_MODEL && process.env.TEST_WHISPER_SAMPLE) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-speech-real-'));
  const modelBuf = fs.readFileSync(process.env.TEST_WHISPER_MODEL);
  fs.copyFileSync(process.env.TEST_WHISPER_MODEL, path.join(dir, 'ggml-base.en.bin'));
  const real = mk({ modelsDir: dir, resolveWhisper: () => ({ whisper: process.env.TEST_WHISPER_CLI, dir: path.dirname(process.env.TEST_WHISPER_CLI) }),
    models: { ...modelTable, en: { ...modelTable.en, sha256: sha(modelBuf), size: modelBuf.length } } });
  fs.copyFileSync(process.env.TEST_WHISPER_SAMPLE, path.join(root, 'real-speech.wav'));
  const s = await finish(real, await real.captions_from_audio({ folder: 'Footage', path: 'real-speech.wav', language: 'en', output_name: 'real-speech' }), 120000);
  assert.strictEqual(s.state, 'done', JSON.stringify(s));
  const srt = fs.readFileSync(path.join(root, 'real-speech.srt'), 'utf8');
  assert.match(srt, /\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}/);
  assert.match(srt, /country/i);
  const w = await finish(real, await real.captions_from_audio({ folder: 'Footage', path: 'real-speech.wav', language: 'en', style: 'words', output_name: 'real-words' }), 120000);
  assert.strictEqual(w.state, 'done', JSON.stringify(w));
  assert.ok((fs.readFileSync(path.join(root, 'real-words.srt'), 'utf8').match(/-->/g) || []).length > 15, 'word level gives many short cues');
});
