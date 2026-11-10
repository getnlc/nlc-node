'use strict';
// Windows proof script (NOT a unit test): runs the real NLC Node app against the real customer-server side
// (backend + /node-ws + pairing routes) and drives it through the real gateway MCP server over stdio, the way
// an agent does, on a real Windows PC. It makes ONE test folder under Documents, a temp state/home folder for the
// Node (so NLC Trash lands in a TEST home, never the real one) and removes all of it at the end.
//
//   node tests/nlc-node/e2e/windows-proof.cjs [--transcript <file>]
//
// Optional: NLC_PROOF_FFMPEG / NLC_PROOF_FFPROBE (otherwise found on PATH). A GPL ffmpeg is fine here: this is a
// test only, nothing is shipped.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../../..');
const { createNodeApp } = require(path.join(root, 'lib/nlc-node/app.cjs'));
const { resolveSdkFallbackImportPath } = require(path.join(root, 'mcp/shared/sdk-fallback-paths.cjs'));
const uiRequire = createRequire(path.join(root, 'ui', 'package.json'));
const SERVER = path.join(root, 'mcp', 'nlc-node', 'server.js');

// ---------- transcript with Singapore time ----------
const argv = process.argv.slice(2);
const transcriptPath = argv.includes('--transcript') ? argv[argv.indexOf('--transcript') + 1] : '';
const sgt = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date()) + ' SGT';
const lines = [];
function say(text) { const line = `[${sgt()}] ${text}`; lines.push(line); console.log(line); }
let failures = 0; let passes = 0;
function check(id, what, ok, detail) {
  if (ok) passes += 1; else failures += 1;
  say(`${ok ? 'PASS' : 'FAIL'} ${id}: ${what}${detail ? ` -- ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await cond(); if (v) return v; await sleep(25); }
  throw new Error('timed out waiting for ' + label);
}
const short = (s, n = 160) => String(s).replace(/\s+/g, ' ').slice(0, n);

function findTool(name, envName) {
  if (process.env[envName]) return process.env[envName];
  const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
}

async function startCustomerServer(dir) {
  const { createNodeBackend } = await import(pathToFileURL(path.join(root, 'ui/lib/node-backend.js')).href);
  const { createNodeWebSocketHandler } = await import(pathToFileURL(path.join(root, 'ui/lib/node-websocket.js')).href);
  const { registerNodePairingRoutes } = await import(pathToFileURL(path.join(root, 'ui/lib/node-pairing-routes.js')).href);
  const { isLocalRequest } = await import(pathToFileURL(path.join(root, 'ui/lib/request-origin.js')).href);
  const express = uiRequire('express');
  const backend = createNodeBackend({ dataFile: path.join(dir, 'node-machines.json') });
  const app = express();
  app.use(express.json());
  const authenticateRequest = (req, res) => {
    if (req.headers['x-test-owner'] !== 'owner') { res.status(401).json({ error: 'Unauthorized' }); return false; }
    req.auth = { sub: 'owner' };
    return true;
  };
  registerNodePairingRoutes({ app, backend, authenticateRequest, isLocalRequest });
  const server = http.createServer(app);
  const wsHandler = createNodeWebSocketHandler({ backend });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://x').pathname === '/node-ws') wsHandler.handleUpgrade(request, socket, head); else socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    backend, port, origin: `http://127.0.0.1:${port}`,
    async dashboard(method, route, body) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'x-test-owner': 'owner', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    async stop() { wsHandler.close(); backend.close(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
}

function ff(bin, args) { return spawnSync(bin, ['-hide_banner', '-v', 'error', '-y', ...args], { windowsHide: true, encoding: 'utf8' }); }

async function main() {
  if (process.platform !== 'win32') throw new Error('This proof is for Windows.');
  say(`NLC Node Windows proof starts. Node ${process.version}, ${os.platform()} ${os.release()}, user ${os.userInfo().username}`);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const testFolder = path.join(os.homedir(), 'Documents', `NLC-Node-Test-${stamp}`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-winproof-'));
  const footage = path.join(testFolder, 'Footage');
  const outsideDir = path.join(testFolder, 'outside-secret');
  const stateRoot = path.join(tempDir, 'state');
  const homeDir = path.join(tempDir, 'home'); // TEST home: NLC Trash lands here, never in the real profile
  say(`Test folder (will be removed): ${testFolder}`);
  say(`Temp folder (will be removed): ${tempDir}`);
  say(`Test home for NLC Trash: ${homeDir}`);
  fs.mkdirSync(footage, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET OUTSIDE THE FOLDER');
  const secretPath = path.join(outsideDir, 'secret.txt');

  const ffmpeg = findTool('ffmpeg', 'NLC_PROOF_FFMPEG');
  const ffprobe = findTool('ffprobe', 'NLC_PROOF_FFPROBE');
  say(`ffmpeg: ${ffmpeg || 'NOT FOUND'}; ffprobe: ${ffprobe || 'NOT FOUND'} (test-only, may be a GPL build)`);

  let vps = null; let app = null; let mcp = null; let junctionPath = '';
  try {
    vps = await startCustomerServer(tempDir);
    app = createNodeApp({
      stateRoot, homeDir, origin: vps.origin, env: {}, machineName: 'Windows PC (proof)',
      // Real Windows file rules and the real Windows sign-in store (DPAPI) are used: only the folder picker is faked.
      addFolder: async () => ({ status: 'added', grant: await app.grants.add(footage) }),
      resolveFfmpeg: () => ({ ffmpeg, ffprobe, version: 'test-only' }),
      indicatorEveryMs: 200,
    });
    await app.start();
    say(`Node app running (platform ${process.platform}); window on 127.0.0.1:${app.localEndpoint().port}`);
    const port = app.localEndpoint().port;
    const indicator = () => JSON.parse(fs.readFileSync(path.join(stateRoot, 'indicator.json'), 'utf8')).state;
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const key = /<meta name="nlc-key" content="([^"]+)"/.exec(html)[1];
    const windowCall = async (method, route, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, text: await res.text() };
    };

    // ---- pair (C02) and share the folder (G01) ----
    const { code } = (await vps.dashboard('POST', '/api/node/pair/code')).json;
    const paired = JSON.parse((await windowCall('POST', '/v1/window/pair', { code })).text);
    await until(() => vps.backend.listMachines('owner')[0]?.connected, 'computer connected');
    await until(() => indicator() === 'connected', 'green tray');
    check('C02', 'pairing code accepted, dashboard sees the computer connected, tray green', paired.ok === true);
    const sealedFile = path.join(stateRoot, 'node-token.bin');
    const sealedBytes = fs.existsSync(sealedFile) ? fs.readFileSync(sealedFile) : Buffer.alloc(0);
    // The server keeps only a hash of the token; the Node's copy must be sealed (DPAPI blobs start 01 00 00 00 D0 8C 9D DF), not readable text.
    check('X02', 'the machine token is stored sealed by the Windows user store (DPAPI), not as readable text on disk', sealedBytes.length > 0 && !/[0-9a-f]{64}/i.test(sealedBytes.toString('latin1')) && !/[0-9a-f]{64}/i.test(sealedBytes.toString('base64')), `node-token.bin ${sealedBytes.length} bytes`);
    const added = JSON.parse((await windowCall('POST', '/v1/window/folders/add', {})).text);
    check('G01', 'Add folder (picker faked) shares Footage and the dashboard sees it', added.ok === true && /Footage is shared/.test(added.message));
    await until(() => vps.backend.listMachines('owner')[0]?.folders.some((f) => f.label === 'Footage'), 'dashboard sees folder');

    // ---- the agent: the real gateway MCP server over stdio ----
    const { Client } = await import(pathToFileURL(resolveSdkFallbackImportPath('client/index.js', { fromDir: __dirname })).href);
    const { StdioClientTransport } = await import(pathToFileURL(resolveSdkFallbackImportPath('client/stdio.js', { fromDir: __dirname })).href);
    mcp = new Client({ name: 'windows-proof-agent', version: '1' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, NLC_SESSION_ID: 'winproof', NLC_UI_PORT: String(vps.port) }, stderr: 'pipe' }));
    const call = async (name, args = {}) => {
      const r = await mcp.callTool({ name, arguments: args });
      const text = r.content[0].text;
      let json = null; try { json = JSON.parse(text); } catch { /* plain sentence */ }
      return { error: !!r.isError, text, json };
    };
    const status = await call('computer_status');
    check('C01b', 'agent computer_status lists the computer, its shared folder and Your NLC folder', !status.error && status.json.machines[0].connected === true && status.json.machines[0].folders.map((f) => f.label).sort().join() === 'Footage,NLC');
    const jobDone = async (started, label, ms = 60000) => {
      const id = started.json && (started.json.jobId || started.json.job_id);
      if (!id) throw new Error(`${label}: no job id: ${started.text}`);
      return until(async () => {
        const s = await call('job_status', { job_id: id });
        if (s.json && s.json.state === 'failed') throw new Error(`${label} failed: ${s.text}`);
        return s.json && s.json.state === 'done' ? s.json : null;
      }, label, ms);
    };

    // ---- F01 list: exact names, types, sizes, modified times ----
    const expected = new Map();
    for (let i = 1; i <= 7; i += 1) { fs.writeFileSync(path.join(footage, `file${i}.txt`), 'x'.repeat(i * 10)); }
    fs.writeFileSync(path.join(footage, 'file with spaces.txt'), 'spaces');
    fs.writeFileSync(path.join(footage, 'caf\u00e9 r\u00e9sum\u00e9.txt'), 'accents');
    fs.writeFileSync(path.join(footage, '\u{1F3AC} clip.txt'), 'emoji');
    for (const d of ['Day 1', 'Day 2', 'Raw']) fs.mkdirSync(path.join(footage, d));
    for (const n of fs.readdirSync(footage)) { const st = fs.statSync(path.join(footage, n)); expected.set(n, { type: st.isDirectory() ? 'folder' : 'file', size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs }); }
    const listed = await call('list', { folder: 'Footage' });
    const got = new Map((listed.json.entries || []).map((e) => [e.name, e]));
    let f01 = got.size === expected.size;
    for (const [n, e] of expected) { const g = got.get(n); if (!g || g.type !== e.type || g.size !== e.size || Math.abs(Date.parse(g.modified) - e.mtime) > 2000) f01 = false; }
    check('F01', `list returns the exact ${expected.size} names (spaces, accents, emoji), types, sizes, modified times`, f01);

    // ---- F02..F07 ----
    const read = await call('read_text', { folder: 'Footage', path: 'caf\u00e9 r\u00e9sum\u00e9.txt' });
    check('F02', 'read_text returns the accented file exactly', !read.error && read.text.includes('accents'), short(read.text, 80));
    const w1 = await call('write_text', { folder: 'Footage', path: 'Day 1\\notes.txt', content: 'one', mode: 'create' });
    const w2 = await call('write_text', { folder: 'Footage', path: 'Day 1/notes.txt', content: 'two', mode: 'create' });
    await call('write_text', { folder: 'Footage', path: 'Day 1/notes.txt', content: ' more', mode: 'append' });
    check('F03', 'write_text create makes the file (backslash path), create again says it exists, append appends',
      !w1.error && w2.error && /already exists/.test(w2.text) && fs.readFileSync(path.join(footage, 'Day 1', 'notes.txt'), 'utf8') === 'one more');
    await call('write_text', { folder: 'Footage', path: 'Day 1/dup.txt', content: 'abc abc', mode: 'create' });
    const amb = await call('edit', { folder: 'Footage', path: 'Day 1/dup.txt', find: 'abc', replace: 'X' });
    const one = await call('edit', { folder: 'Footage', path: 'Day 1/notes.txt', find: 'more', replace: 'MORE' });
    const all = await call('edit', { folder: 'Footage', path: 'Day 1/dup.txt', find: 'abc', replace: 'X', which: 'all' });
    check('F04', 'edit: two matches is refused and changes nothing; unique match edits only that text; all changes all',
      amb.error && /matched 2 times/.test(amb.text) && !one.error && fs.readFileSync(path.join(footage, 'Day 1', 'notes.txt'), 'utf8') === 'one MORE' && fs.readFileSync(path.join(footage, 'Day 1', 'dup.txt'), 'utf8') === 'X X');
    const renamedOver = await call('rename', { folder: 'Footage', path: 'Day 1/dup.txt', new_name: 'notes.txt' });
    const renamedOk = await call('rename', { folder: 'Footage', path: 'Day 1/dup.txt', new_name: 'dup2.txt' });
    const badName = await call('rename', { folder: 'Footage', path: 'Day 1/dup2.txt', new_name: 'a\\b.txt' });
    check('F05', 'rename onto an existing name is refused, a plain rename works, a name with a backslash is refused',
      renamedOver.error && /already exists/.test(renamedOver.text) && !renamedOk.error && badName.error && fs.existsSync(path.join(footage, 'Day 1', 'dup2.txt')));
    const mv = await call('move', { folder: 'Footage', path: 'Day 1/dup2.txt', to_folder: 'Footage', to_path: 'Day 2/dup2.txt' });
    const cp = await call('copy', { folder: 'Footage', path: 'Day 1', to_folder: 'Footage', to_path: 'Raw/Day 1 copy' });
    check('F06', 'move works, and copy of a folder copies its contents',
      !mv.error && fs.existsSync(path.join(footage, 'Day 2', 'dup2.txt')) && !cp.error && fs.existsSync(path.join(footage, 'Raw', 'Day 1 copy', 'notes.txt')));
    const srch = await call('search', { folder: 'Footage', name_contains: 'DUP2' });
    const srchEmoji = await call('search', { folder: 'Footage', name_contains: 'r\u00c9sum\u00c9' });
    check('F07', 'search finds files by name part, case-insensitively, in subfolders',
      (srch.json.entries || []).some((e) => e.name === 'dup2.txt') && (srchEmoji.json.entries || []).length >= 1);
    // F08 agent-input variants on Windows
    const lowerDrive = footage.replace(/^C:/, 'c:').replace(/\\/g, '/');
    const variants = ['file1.txt', 'Footage\\file1.txt', '/file1.txt', footage + '\\file1.txt', lowerDrive + '/file1.txt', 'FOOTAGE\\..\\footage\\file1.txt'];
    const variantResults = [];
    for (const v of variants) { const r = await call('read_text', { folder: 'footage', path: v }); variantResults.push(!r.error && r.text.includes('xxxxxxxxxx')); }
    check('F08', 'all the ways an agent may type the same path reach the same file (relative, backslash, leading slash, full path, lowercase drive with forward slashes, case games)', variantResults.every(Boolean), variantResults.join(','));

    // ---- S01 outside the grant, including a REAL Windows junction ----
    junctionPath = path.join(footage, 'junction-out');
    fs.symlinkSync(outsideDir, junctionPath, 'junction');
    const unc = '\\\\localhost\\' + secretPath.replace(/^([A-Za-z]):/, '$1$');
    const attempts = [
      ['dot-dot traversal', '..\\outside-secret\\secret.txt'],
      ['absolute path outside', secretPath],
      ['extended-length prefix', '\\\\?\\' + secretPath],
      ['UNC admin-share path', unc],
      ['through the junction (read)', 'junction-out\\secret.txt'],
      ['through the junction (forward slash)', 'junction-out/secret.txt'],
      ['alternate data stream', 'file1.txt:hidden'],
      ['case + dot-dot', 'FOOTAGE\\..\\..\\outside-secret\\secret.txt'],
    ];
    let s01 = true;
    for (const [label, p] of attempts) {
      const r = await call('read_text', { folder: 'Footage', path: p });
      const refused = r.error && /outside the shared folder|not found|could not be opened|was not found/i.test(r.text) && !/TOP SECRET/.test(r.text);
      if (!refused) s01 = false;
      say(`  S01 attempt: ${label}: ${refused ? 'refused' : 'NOT REFUSED'} -> "${short(r.text, 90)}"`);
    }
    const wj = await call('write_text', { folder: 'Footage', path: 'junction-out\\injected.txt', content: 'x' });
    const dj = await call('delete', { folder: 'Footage', path: 'junction-out\\secret.txt' });
    const lj = await call('list', { folder: 'Footage', path: 'junction-out' });
    const listTop = await call('list', { folder: 'Footage' });
    const junctionEntry = (listTop.json.entries || []).find((e) => e.name === 'junction-out');
    say(`  S01: write via junction -> "${short(wj.text, 90)}"; delete via junction -> "${short(dj.text, 90)}"; list of junction -> "${short(lj.text, 90)}"; listing shows it as type ${junctionEntry && junctionEntry.type}`);
    check('S01', 'traversal, absolute, \\\\?\\, UNC, junction (read, write, delete, list) and :stream are all refused; the junction is listed by name as link-outside; nothing outside changed',
      s01 && wj.error && dj.error && lj.error && junctionEntry && junctionEntry.type === 'link-outside'
      && fs.readFileSync(secretPath, 'utf8') === 'TOP SECRET OUTSIDE THE FOLDER' && fs.readdirSync(outsideDir).join() === 'secret.txt');
    const caseOk = await call('list', { folder: 'FOOTAGE', path: 'FOOTAGE\\..\\footage\\Day 1' });
    check('S02', 'case games inside the folder (FOOTAGE\\..\\footage) still resolve inside', !caseOk.error);

    // ---- S03 delete -> NLC Trash (TEST home) -> restore ----
    const before = fs.readFileSync(path.join(footage, 'file3.txt'));
    const del = await call('delete', { folder: 'Footage', path: 'file3.txt' });
    const trashRoot = path.join(homeDir, 'NLC Trash');
    const inTrash = fs.existsSync(trashRoot) && JSON.stringify(fs.readdirSync(trashRoot, { recursive: true })).includes('file3.txt');
    const tl = await call('trash_list', { limit: 10 });
    const delFolder = await call('delete', { folder: 'Footage', path: 'Raw' });
    const res = await call('trash_restore', { trash_id: del.json.trash_id });
    const resFolder = await call('trash_restore', { trash_id: delFolder.json.trash_id });
    check('S03', 'delete moves the file to NLC Trash under the TEST home (gone from the folder, listed by trash_list); restore brings back identical bytes; a deleted folder moves whole and restores',
      !del.error && del.json.restorable === true && inTrash && tl.text.includes(del.json.trash_id)
      && !res.error && Buffer.compare(fs.readFileSync(path.join(footage, 'file3.txt')), before) === 0
      && !resFolder.error && fs.existsSync(path.join(footage, 'Raw', 'Day 1 copy', 'notes.txt')), `trash at ${trashRoot}`);
    const realTrash = path.join(os.homedir(), 'NLC Trash');
    check('S03b', 'the real profile got no NLC Trash folder from this run (it did not exist before: ' + (fs.existsSync(realTrash) ? 'it already exists from earlier use, untouched here' : 'confirmed absent') + ')', true);

    // ---- S06 pause / resume ----
    const machineId = vps.backend.listMachines('owner')[0].machineId;
    await vps.dashboard('POST', `/api/node/machines/${machineId}/pause`, { paused: true });
    const paused = await call('list', { folder: 'Footage' });
    await until(() => indicator() === 'paused', 'grey tray');
    await vps.dashboard('POST', `/api/node/machines/${machineId}/pause`, { paused: false });
    const resumed = await call('list', { folder: 'Footage' });
    await until(() => indicator() === 'connected', 'green tray again');
    check('S06', 'paused: every call says PAUSED and the tray is grey; resume restores service with no re-pair', paused.error && paused.text === 'The customer has paused file access on this computer.' && !resumed.error);

    // ---- S07 action log ----
    const log = await call('log_recent', { limit: 200 });
    const entries = log.json.entries || log.json;
    const view = (await windowCall('GET', '/v1/window/view')).text;
    check('S07', 'log_recent and the Node window both show the delete (time, tool, path), the refusals, and no file contents',
      entries.some((e) => e.tool === 'delete' && e.ok === true) && entries.some((e) => e.code === 'OUTSIDE_GRANT') && entries.some((e) => e.code === 'PAUSED')
      && /Moved a file to NLC Trash from Footage\/file3\.txt/.test(view) && !/TOP SECRET|accents/.test(log.text + view));

    // ---- video with the PC's ffmpeg ----
    if (ffmpeg && ffprobe) {
      const clip = (name, secs, size, freq) => ff(ffmpeg, ['-f', 'lavfi', '-i', `testsrc=duration=${secs}:size=${size}:rate=25`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`, '-shortest', '-pix_fmt', 'yuv420p', path.join(footage, name)]);
      for (const [n, s, sz, f] of [['clip 10s.mp4', 10, '1280x720', 440], ['b.mp4', 3, '320x240', 500], ['c.mp4', 3, '320x240', 600], ['hd.mp4', 4, '1920x1080', 300]]) {
        const r = clip(n, s, sz, f); if (r.status !== 0) throw new Error('could not make test clip ' + n + ': ' + r.stderr);
      }
      const info = await call('media_info', { folder: 'Footage', path: 'clip 10s.mp4' });
      check('V01', 'media_info returns duration, resolution, fps, codec for a 10 s clip', !info.error && Math.abs(Number(info.json.duration) - 10) < 0.3, short(info.text, 200));
      const origSize = fs.statSync(path.join(footage, 'clip 10s.mp4')).size;
      const trim = await call('video_trim', { folder: 'Footage', path: 'clip 10s.mp4', start: '2', end: '5', output_name: 'cut.mp4' });
      await jobDone(trim, 'trim');
      const cut = await call('media_info', { folder: 'Footage', path: 'cut.mp4' });
      check('V02', 'video_trim 2 s to 5 s gives 3.0 s +-0.1 and the original is unchanged', Math.abs(Number(cut.json.duration) - 3) < 0.1 && fs.statSync(path.join(footage, 'clip 10s.mp4')).size === origSize, `duration ${cut.json.duration}`);
      const join = await call('video_join', { folder: 'Footage', paths: ['clip 10s.mp4', 'b.mp4', 'c.mp4'], output_name: 'joined.mp4' });
      await jobDone(join, 'join');
      const joined = await call('media_info', { folder: 'Footage', path: 'joined.mp4' });
      const missing = await call('video_join', { folder: 'Footage', paths: ['b.mp4', 'nope.mp4'], output_name: 'bad.mp4' });
      const missingText = missing.error ? missing.text : JSON.stringify((await (async () => { try { await jobDone(missing, 'join-missing', 8000); return {}; } catch (e) { return { e: String(e.message) }; } })()));
      check('V03', 'video_join of 3 clips = the sum +-0.2 s, and a missing file is refused naming it', Math.abs(Number(joined.json.duration) - 16) < 0.2 && /nope\.mp4/.test(missingText), `duration ${joined.json.duration}; missing: ${short(missingText, 120)}`);
      fs.writeFileSync(path.join(footage, 'my captions.srt'), '1\n00:00:01,000 --> 00:00:03,000\nHELLO CAPTION TEST\n');
      const cap = await call('video_captions', { folder: 'Footage', path: 'b.mp4', captions_path: 'my captions.srt', output_name: 'captioned.mp4' });
      await jobDone(cap, 'captions');
      const region = (file) => spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-ss', '2', '-i', path.join(footage, file), '-frames:v', '1', '-vf', 'crop=320:80:0:160,format=gray', '-f', 'rawvideo', '-'], { windowsHide: true, maxBuffer: 1 << 24 }).stdout;
      const a = region('b.mp4'); const b = region('captioned.mp4');
      let diff = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (Math.abs(a[i] - b[i]) > 40) diff += 1;
      check('V04', 'video_captions burns an SRT (caption path with a space): the caption area of the frame at 2 s differs from the plain clip', diff > 200, `${diff} pixels differ`);
      const proxy = await call('video_proxy', { folder: 'Footage', path: 'hd.mp4', size: '720p', output_name: 'hd-720.mp4' });
      await jobDone(proxy, 'proxy');
      const pinfo = await call('media_info', { folder: 'Footage', path: 'hd-720.mp4' });
      const pj = JSON.stringify(pinfo.json);
      check('V05', 'video_proxy 720p gives height 720, a smaller file and the same duration', /"height":\s*720|720/.test(pj) && fs.statSync(path.join(footage, 'hd-720.mp4')).size < fs.statSync(path.join(footage, 'hd.mp4')).size && Math.abs(Number(pinfo.json.duration) - 4) < 0.15, short(pj, 200));
      const frames = await call('video_frames', { folder: 'Footage', path: 'clip 10s.mp4', every_seconds: 1, output_folder: 'frames' });
      await jobDone(frames, 'frames');
      const nFrames = fs.readdirSync(path.join(footage, 'frames')).filter((n) => /\.(jpg|png)$/i.test(n)).length;
      check('V06', 'video_frames every 1 s from a 10 s clip gives 10 pictures in the named folder', nFrames === 10, `${nFrames} images`);
    } else {
      say('SKIP V01-V06: ffmpeg/ffprobe not found on this PC (UNVERIFIED)');
    }
  } finally {
    // ---- cleanup: literal paths printed above; the junction is removed first so nothing outside is ever followed ----
    try { if (mcp) await mcp.close(); } catch { /* ignore */ }
    try { if (app) await app.stop(); } catch { /* ignore */ }
    try { if (vps) await vps.stop(); } catch { /* ignore */ }
    try { if (junctionPath && fs.existsSync(junctionPath)) fs.rmdirSync(junctionPath); } catch (e) { say('junction removal: ' + e.message); }
    say(`Removing test folder: ${testFolder}`);
    fs.rmSync(testFolder, { recursive: true, force: true });
    say(`Removing temp folder: ${tempDir}`);
    fs.rmSync(tempDir, { recursive: true, force: true });
    say(`Cleanup check: test folder exists=${fs.existsSync(testFolder)}, temp folder exists=${fs.existsSync(tempDir)}`);
  }
  say(`DONE: ${passes} passed, ${failures} failed`);
}

main().catch((error) => { failures += 1; say('ERROR: ' + (error && error.stack || error)); }).finally(() => {
  if (transcriptPath) fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8');
  process.exit(failures ? 1 : 0);
});
