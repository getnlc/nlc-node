'use strict';
// File-tool proof for macOS/Linux (NOT a unit test; mirrors windows-proof.cjs): runs the real NLC Node app against the real customer-server side
// (backend + /node-ws + pairing routes) and drives it through the real gateway MCP server over stdio, the way
// an agent does, on a real macOS/Linux machine. It makes ONE test folder under Documents, a temp state/home folder for the
// Node (so NLC Trash lands in a TEST home, never the real one) and removes all of it at the end.
//
//   node tests/nlc-node/e2e/posix-proof.cjs [--transcript <file>]
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

async function main() {
  say(`NLC Node file-tool proof starts. Node ${process.version}, ${os.platform()} ${os.release()} ${os.arch()}, user ${os.userInfo().username}`);
  const base = fs.realpathSync(process.env.NLC_PROOF_ROOT || process.env.RUNNER_TEMP || os.tmpdir());
  const testFolder = fs.mkdtempSync(path.join(base, 'NLC-Node-Test-'));
  const tempDir = fs.mkdtempSync(path.join(base, 'nlc-node-posixproof-'));
  const footage = path.join(testFolder, 'Footage');
  const outsideDir = path.join(testFolder, 'outside-secret');
  const stateRoot = path.join(tempDir, 'state');
  const homeDir = path.join(tempDir, 'home'); // TEST home: NLC Trash lands here, never in the real one
  say(`Test folder (will be removed): ${testFolder}`);
  say(`Temp folder (will be removed): ${tempDir}`);
  say(`Test home for NLC Trash: ${homeDir}`);
  fs.mkdirSync(footage, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET OUTSIDE THE FOLDER');
  const secretPath = path.join(outsideDir, 'secret.txt');

  let vps = null; let app = null; let mcp = null;
  try {
    vps = await startCustomerServer(tempDir);
    app = createNodeApp({
      stateRoot, homeDir, origin: vps.origin, env: {}, machineName: `${os.platform()} (proof)`, reportedOs: process.platform === 'linux' ? 'darwin' : process.platform, // the server only knows Windows and Mac; Linux is a local rehearsal
     
      // Real file rules are used; only the folder picker is faked. macOS uses the real Keychain; Linux has no sign-in store, so a pass-through one stands in there (X02 then is skipped).
      ...(process.platform === 'linux' ? { protector: { protect: async (b) => Buffer.from(b), unprotect: async (b) => Buffer.from(b) } } : {}),
      addFolder: async () => ({ status: 'added', grant: await app.grants.add(footage) }),
      resolveFfmpeg: () => ({ ffmpeg: '', ffprobe: '', version: 'none' }),
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
    if (process.platform === 'linux') say('SKIP X02: Linux has no sign-in store in this build (UNVERIFIED here; proven on macOS/Windows)'); else check('X02', 'the machine token is stored sealed, not as readable text on disk', sealedBytes.length > 0 && !/[0-9a-f]{64}/i.test(sealedBytes.toString('latin1')) && !/[0-9a-f]{64}/i.test(sealedBytes.toString('base64')), `node-token.bin ${sealedBytes.length} bytes`);
    const added = JSON.parse((await windowCall('POST', '/v1/window/folders/add', {})).text);
    check('G01', 'Add folder (picker faked) shares Footage and the dashboard sees it', added.ok === true && /Footage is shared/.test(added.message));
    await until(() => vps.backend.listMachines('owner')[0]?.folders.some((f) => f.label === 'Footage'), 'dashboard sees folder');

    // ---- the agent: the real gateway MCP server over stdio ----
    const { Client } = await import(pathToFileURL(resolveSdkFallbackImportPath('client/index.js', { fromDir: __dirname })).href);
    const { StdioClientTransport } = await import(pathToFileURL(resolveSdkFallbackImportPath('client/stdio.js', { fromDir: __dirname })).href);
    mcp = new Client({ name: 'posix-proof-agent', version: '1' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, NLC_SESSION_ID: 'posixproof', NLC_UI_PORT: String(vps.port) }, stderr: 'pipe' }));
    const call = async (name, args = {}) => {
      const r = await mcp.callTool({ name, arguments: args });
      const text = r.content[0].text;
      let json = null; try { json = JSON.parse(text); } catch { /* plain sentence */ }
      return { error: !!r.isError, text, json };
    };
    const tools = await mcp.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    check('T01', 'the agent sees the file tools list, read_text, write_text, edit, rename, move, copy, search, delete, trash_list, trash_restore, log_recent', ['list', 'read_text', 'write_text', 'edit', 'rename', 'move', 'copy', 'search', 'delete', 'trash_list', 'trash_restore', 'log_recent'].every((n) => toolNames.includes(n)), toolNames.join(','));
    const status = await call('computer_status');
    check('C01b', 'agent computer_status lists the computer and its shared folder', !status.error && status.json.machines[0].connected === true && status.json.machines[0].folders.map((f) => f.label).join() === 'Footage');

    // ---- F01 list ----
    const expected = new Map();
    for (let i = 1; i <= 7; i += 1) { fs.writeFileSync(path.join(footage, `file${i}.txt`), 'x'.repeat(i * 10)); }
    fs.writeFileSync(path.join(footage, 'file with spaces.txt'), 'spaces');
    fs.writeFileSync(path.join(footage, 'café résumé.txt'), 'accents');
    fs.writeFileSync(path.join(footage, '\u{1F3AC} clip.txt'), 'emoji');
    for (const d of ['Day 1', 'Day 2', 'Raw']) fs.mkdirSync(path.join(footage, d));
    for (const n of fs.readdirSync(footage)) { const st = fs.statSync(path.join(footage, n)); expected.set(n, { type: st.isDirectory() ? 'folder' : 'file', size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs }); }
    const listed = await call('list', { folder: 'Footage' });
    const got = new Map((listed.json.entries || []).map((e) => [e.name, e]));
    let f01 = got.size === expected.size;
    for (const [n, e] of expected) { const g = got.get(n); if (!g || g.type !== e.type || g.size !== e.size || Math.abs(Date.parse(g.modified) - e.mtime) > 2000) f01 = false; }
    check('F01', `list returns the exact ${expected.size} names (spaces, accents, emoji), types, sizes, modified times`, f01);

    // ---- F02..F07 ----
    const read = await call('read_text', { folder: 'Footage', path: 'café résumé.txt' });
    check('F02', 'read_text returns the accented file exactly', !read.error && read.text.includes('accents'), short(read.text, 80));
    const w1 = await call('write_text', { folder: 'Footage', path: 'Day 1/notes.txt', content: 'one', mode: 'create' });
    const w2 = await call('write_text', { folder: 'Footage', path: 'Day 1/notes.txt', content: 'two', mode: 'create' });
    await call('write_text', { folder: 'Footage', path: 'Day 1/notes.txt', content: ' more', mode: 'append' });
    check('F03', 'write_text create makes the file, create again says it exists, append appends',
      !w1.error && w2.error && /already exists/.test(w2.text) && fs.readFileSync(path.join(footage, 'Day 1', 'notes.txt'), 'utf8') === 'one more');
    await call('write_text', { folder: 'Footage', path: 'Day 1/dup.txt', content: 'abc abc', mode: 'create' });
    const amb = await call('edit', { folder: 'Footage', path: 'Day 1/dup.txt', find: 'abc', replace: 'X' });
    const one = await call('edit', { folder: 'Footage', path: 'Day 1/notes.txt', find: 'more', replace: 'MORE' });
    await call('edit', { folder: 'Footage', path: 'Day 1/dup.txt', find: 'abc', replace: 'X', which: 'all' });
    check('F04', 'edit: two matches is refused and changes nothing; unique match edits only that text; all changes all',
      amb.error && /matched 2 times/.test(amb.text) && !one.error && fs.readFileSync(path.join(footage, 'Day 1', 'notes.txt'), 'utf8') === 'one MORE' && fs.readFileSync(path.join(footage, 'Day 1', 'dup.txt'), 'utf8') === 'X X');
    const renamedOver = await call('rename', { folder: 'Footage', path: 'Day 1/dup.txt', new_name: 'notes.txt' });
    const renamedOk = await call('rename', { folder: 'Footage', path: 'Day 1/dup.txt', new_name: 'dup2.txt' });
    const badName = await call('rename', { folder: 'Footage', path: 'Day 1/dup2.txt', new_name: 'a/b.txt' });
    check('F05', 'rename onto an existing name is refused, a plain rename works, a name with a slash is refused',
      renamedOver.error && /already exists/.test(renamedOver.text) && !renamedOk.error && badName.error && fs.existsSync(path.join(footage, 'Day 1', 'dup2.txt')));
    const mv = await call('move', { folder: 'Footage', path: 'Day 1/dup2.txt', to_folder: 'Footage', to_path: 'Day 2/dup2.txt' });
    const cp = await call('copy', { folder: 'Footage', path: 'Day 1', to_folder: 'Footage', to_path: 'Raw/Day 1 copy' });
    check('F06', 'move works, and copy of a folder copies its contents',
      !mv.error && fs.existsSync(path.join(footage, 'Day 2', 'dup2.txt')) && !cp.error && fs.existsSync(path.join(footage, 'Raw', 'Day 1 copy', 'notes.txt')));
    const srch = await call('search', { folder: 'Footage', name_contains: 'DUP2' });
    const srchAccent = await call('search', { folder: 'Footage', name_contains: 'rÉsumÉ' });
    check('F07', 'search finds files by name part, case-insensitively, in subfolders',
      (srch.json.entries || []).some((e) => e.name === 'dup2.txt') && (srchAccent.json.entries || []).length >= 1);
    const variants = ['file1.txt', 'Footage/file1.txt', '/file1.txt', './file1.txt', footage + '/file1.txt', 'Day 1/../file1.txt'];
    const variantResults = [];
    for (const v of variants) { const r = await call('read_text', { folder: 'footage', path: v }); variantResults.push(!r.error && r.text.includes('xxxxxxxxxx')); }
    check('F08', 'all the ways an agent may type the same path reach the same file (relative, folder-name prefix, leading slash, ./, full path, dot-dot inside)', variantResults.every(Boolean), variantResults.join(','));

    // ---- S01 outside the grant, including REAL symlinks ----
    const dirLink = path.join(footage, 'link-out');
    const fileLink = path.join(footage, 'link-secret.txt');
    const dangling = path.join(footage, 'link-dangling.txt');
    fs.symlinkSync(outsideDir, dirLink, 'dir');
    fs.symlinkSync(secretPath, fileLink, 'file');
    fs.symlinkSync(path.join(outsideDir, 'not-yet.txt'), dangling, 'file');
    const attempts = [
      ['dot-dot traversal', '../outside-secret/secret.txt'],
      ['absolute path outside', secretPath],
      ['file:// style', 'file://' + secretPath],
      ['through the folder symlink (read)', 'link-out/secret.txt'],
      ['file symlink pointing outside (read)', 'link-secret.txt'],
      ['dot-dot after symlink', 'link-out/../file1.txt/../../outside-secret/secret.txt'],
    ];
    let s01 = true;
    for (const [label, p] of attempts) {
      const r = await call('read_text', { folder: 'Footage', path: p });
      const refused = r.error && !/TOP SECRET/.test(r.text);
      if (!refused) s01 = false;
      say(`  S01 attempt: ${label}: ${refused ? 'refused' : 'NOT REFUSED'} -> "${short(r.text, 90)}"`);
    }
    const wj = await call('write_text', { folder: 'Footage', path: 'link-out/injected.txt', content: 'x' });
    const wd = await call('write_text', { folder: 'Footage', path: 'link-dangling.txt', content: 'x', mode: 'overwrite' });
    const wf = await call('write_text', { folder: 'Footage', path: 'link-secret.txt', content: 'OVERWRITTEN', mode: 'overwrite' });
    const dj = await call('delete', { folder: 'Footage', path: 'link-out/secret.txt' });
    const lj = await call('list', { folder: 'Footage', path: 'link-out' });
    const listTop = await call('list', { folder: 'Footage' });
    const linkEntry = (listTop.json.entries || []).find((e) => e.name === 'link-out');
    say(`  S01: write via dir symlink -> "${short(wj.text, 90)}"; write via dangling -> "${short(wd.text, 90)}"; overwrite file symlink -> "${short(wf.text, 90)}"; delete via symlink -> "${short(dj.text, 90)}"; list of symlink -> "${short(lj.text, 90)}"; listing shows it as type ${linkEntry && linkEntry.type}`);
    check('S01', 'traversal, absolute, folder symlink (read, write, delete, list), file symlink (read, overwrite) and a dangling symlink to outside are all refused; the symlink is listed by name as link-outside; nothing outside changed',
      s01 && wj.error && wd.error && wf.error && dj.error && lj.error && linkEntry && linkEntry.type === 'link-outside'
      && fs.readFileSync(secretPath, 'utf8') === 'TOP SECRET OUTSIDE THE FOLDER' && fs.readdirSync(outsideDir).join() === 'secret.txt');
    const inside = await call('list', { folder: 'FOOTAGE', path: 'Day 1/../Day 1' });
    check('S02', 'dot-dot games inside the folder (Day 1/../Day 1) still resolve inside', !inside.error);

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
  } finally {
    // ---- cleanup: literal paths printed above; links are removed first so nothing outside is ever followed ----
    try { if (mcp) await mcp.close(); } catch { /* ignore */ }
    try { if (app) await app.stop(); } catch { /* ignore */ }
    try { if (vps) await vps.stop(); } catch { /* ignore */ }
    for (const l of ['link-out', 'link-secret.txt', 'link-dangling.txt']) { try { fs.unlinkSync(path.join(footage, l)); } catch { /* ignore */ } }
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
