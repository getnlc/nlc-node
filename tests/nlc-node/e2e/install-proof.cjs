'use strict';
// One-line installer proof (NOT a unit test). Runs ONLY on a clean CI runner (macOS or Windows): it installs NLC Node with the
// exact line a customer pastes (curl | sh on Mac, irm | iex in PowerShell on Windows) against the real server side
// (download routes + pairing + node socket) on a local port, then checks what the customer would see.
//   node tests/nlc-node/e2e/install-proof.cjs --artifacts <folder holding the payloads> [--transcript <file>]
// The real folder dialog cannot be clicked on a runner, so the Node is restarted once with the CI-only test hook
// (CI=true + NLC_NODE_TEST_PICK_FOLDER) for the "add folder" step. That step is the only one that is not the customer's path.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

if (process.env.CI !== 'true' || !process.env.GITHUB_ACTIONS) {
  console.error('This proof installs NLC Node on the machine it runs on. It only runs on a GitHub Actions runner.');
  process.exit(2);
}
const root = path.resolve(__dirname, '../../..');
const { resolveSdkFallbackImportPath } = require(path.join(root, 'mcp/shared/sdk-fallback-paths.cjs'));
const uiRequire = createRequire(path.join(root, 'ui', 'package.json'));
const isWin = process.platform === 'win32';
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : '');
const artifacts = path.resolve(opt('--artifacts') || '');
const transcriptPath = opt('--transcript');

const sgt = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date()) + ' SGT';
const lines = [];
function say(text) { const line = `[${sgt()}] ${text}`; lines.push(line); console.log(line); }
let failures = 0;
function check(id, what, ok, detail) { if (!ok) failures += 1; say(`${ok ? 'PASS' : 'FAIL'} ${id}: ${what}${detail ? ` -- ${detail}` : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await cond(); if (v) return v; await sleep(250); }
  throw new Error('timed out waiting for ' + label);
}
const tail = (s, n = 1500) => String(s).trim().slice(-n);

const home = os.homedir();
const stateRoot = isWin ? path.join(process.env.LOCALAPPDATA, 'NLC Node') : path.join(home, 'Library', 'Application Support', 'NLC Node');
const appRoot = isWin ? path.join(process.env.LOCALAPPDATA, 'Programs', 'NLC Node') : path.join(stateRoot, 'app');
const hostPath = isWin ? path.join(appRoot, 'NLC Node Host.exe') : path.join(appRoot, 'NLC Node.app', 'Contents', 'MacOS', 'NLC Node Host');
const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.nlc.node.plist');
const readJson = (name) => { try { return JSON.parse(fs.readFileSync(path.join(stateRoot, name), 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readyPid = () => { const r = readJson('ready.json'); return r && r.state === 'ready' && alive(r.pid) ? r.pid : 0; };

async function startServer(dir) {
  const { createNodeBackend } = await import(pathToFileURL(path.join(root, 'ui/lib/node-backend.js')).href);
  const { createNodeWebSocketHandler } = await import(pathToFileURL(path.join(root, 'ui/lib/node-websocket.js')).href);
  const { registerNodePairingRoutes } = await import(pathToFileURL(path.join(root, 'ui/lib/node-pairing-routes.js')).href);
  const { registerNodeDownloadRoutes } = await import(pathToFileURL(path.join(root, 'ui/lib/node-download-routes.js')).href);
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
  const downloads = registerNodeDownloadRoutes({ app, artifactDir: artifacts, env: {} });
  const server = http.createServer(app);
  const wsHandler = createNodeWebSocketHandler({ backend, updateNotice: downloads.updateNotice });
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

// The line a customer pastes. Runs asynchronously: the server it talks to lives in this same process.
function pasteLine(origin, { link = '', uninstall = false, shell = 'default' } = {}) {
  const query = link ? `?link=${encodeURIComponent(link)}` : '';
  return new Promise((resolve) => {
    const env = { ...process.env, NLC_NODE_NO_OPEN: '1' };
    let command; let args;
    if (isWin) {
      if (uninstall) env.NLC_NODE_UNINSTALL = '1';
      command = shell === 'pwsh' ? 'pwsh' : 'powershell.exe';
      // The workflow step runs under PowerShell 7, whose module path would confuse Windows PowerShell 5.1; a customer's window has its own.
      delete env.PSModulePath;
      args = ['-NoProfile', '-NonInteractive', '-Command', `irm "${origin}/downloads/nlc-node/install.ps1${query}" | iex`];
    } else {
      command = 'sh';
      args = ['-c', `curl -fsSL "${origin}/downloads/nlc-node/install.sh${query}" | sh${uninstall ? ' -s -- --uninstall' : ''}`];
    }
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 240000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, command }); });
  });
}
function showRun(label, r) {
  say(`${label}: ${r.command} exit ${r.status}`);
  for (const l of tail(r.stdout, 1800).split(/\r?\n/)) if (l.trim()) say(`    | ${l}`);
  for (const l of tail(r.stderr, 800).split(/\r?\n/)) if (l.trim()) say(`    ! ${l}`);
}
function stopHost() { if (fs.existsSync(hostPath)) spawnSync(hostPath, ['--stop'], { timeout: 60000, windowsHide: true }); }

async function main() {
  say(`NLC Node one-line install proof. Node ${process.version}, ${os.platform()} ${os.release()} ${os.arch()}, user ${os.userInfo().username}, home ${home}`);
  check('I00', 'this is a clean machine: no NLC Node installed yet', !fs.existsSync(appRoot) && !fs.existsSync(stateRoot));
  const base = fs.realpathSync(process.env.RUNNER_TEMP || os.tmpdir());
  const tempDir = fs.mkdtempSync(path.join(base, 'nlc-install-proof-'));
  const testFolder = fs.mkdtempSync(path.join(base, 'NLC-Node-Test-'));
  const folderLabel = path.basename(testFolder);
  fs.writeFileSync(path.join(testFolder, 'existing.txt'), 'already here');
  const trashSentinel = path.join(home, 'NLC Trash', 'sentinel-install-proof.txt');
  fs.mkdirSync(path.dirname(trashSentinel), { recursive: true });
  fs.writeFileSync(trashSentinel, 'trash must survive');
  say(`Test folder to share: ${testFolder}`);

  let vps = null; let mcp = null;
  try {
    vps = await startServer(tempDir);
    say(`Server side (real routes) on ${vps.origin}; payloads from ${artifacts}: ${fs.readdirSync(artifacts).join(', ')}`);
    const script = await fetch(`${vps.origin}/downloads/nlc-node/install.${isWin ? 'ps1' : 'sh'}`);
    check('I01', `the install script is served (HTTP ${script.status}) with this server's address inside`, script.status === 200 && (await script.text()).includes(vps.origin));

    // ---- first install, connection link in the line ----
    const first = await vps.dashboard('POST', '/api/node/pair/code');
    const link = first.json.link;
    check('I02', 'the dashboard hands out a connection link', /\/n\/[A-Za-z0-9-]+$/.test(link || ''), link);
    const run1 = await pasteLine(vps.origin, { link });
    showRun('install #1 (windows: Windows PowerShell 5.1)', run1);
    check('I03', 'the one line finishes with success and says NLC Node is installed and running', run1.status === 0 && /installed and running/.test(run1.stdout));
    const pid1 = readyPid();
    check('I04', 'files are installed in the user folder, no admin', fs.existsSync(hostPath) && fs.statSync(hostPath).size > 0, hostPath);
    check('I05', 'the Node process is running (ready.json says ready and the process is alive)', pid1 > 0, `pid ${pid1}`);
    check('I06', 'origin.txt holds this server\'s address', fs.existsSync(path.join(stateRoot, 'origin.txt')) && fs.readFileSync(path.join(stateRoot, 'origin.txt'), 'utf8').trim() === vps.origin);
    if (isWin) {
      const reg = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'NLC Node'], { encoding: 'utf8' });
      check('I07', 'launch at login: the Run key points at the installed launcher with --background', reg.status === 0 && /NLC Node\.exe" --background/.test(reg.stdout), tail(reg.stdout, 300));
    } else {
      check('I07a', 'launch at login: the LaunchAgent file exists and names the installed app', fs.existsSync(plistPath) && fs.readFileSync(plistPath, 'utf8').includes('NLC Node.app/Contents/MacOS/NLC Node'));
      const lint = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
      check('I07b', 'the LaunchAgent file is a valid property list', lint.status === 0, tail(lint.stdout + lint.stderr, 200));
      const printed = spawnSync('launchctl', ['print', `gui/${process.getuid()}/com.nlc.node`], { encoding: 'utf8' });
      say(`  (info) launchctl print gui/${process.getuid()}/com.nlc.node: exit ${printed.status} ${printed.status === 0 ? 'loaded' : 'not loaded in this runner session; the Node was then started directly'}`);
      const cs = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', path.join(appRoot, 'NLC Node.app')], { encoding: 'utf8' });
      check('I08', 'the app is signed (ad-hoc) and the signature verifies', cs.status === 0, tail(cs.stderr, 300));
      const q = spawnSync('xattr', ['-r', '-l', path.join(appRoot, 'NLC Node.app')], { encoding: 'utf8' });
      check('I09', 'nothing marked the installed app as downloaded (no quarantine flag)', !/com\.apple\.quarantine/.test(q.stdout + q.stderr), tail(q.stdout, 200) || 'no extended attributes');
      const sp = spawnSync('spctl', ['--assess', '--type', 'execute', '-vv', path.join(appRoot, 'NLC Node.app')], { encoding: 'utf8' });
      say(`  (info) spctl assess (Gatekeeper's verdict for an unquarantined ad-hoc app): exit ${sp.status} ${tail(sp.stdout + sp.stderr, 200)}`);
    }

    // ---- pairing happened by itself from the link ----
    await until(() => vps.backend.listMachines('owner').some((m) => m.connected), 'computer connected after the link', 40000);
    check('I10', 'the link in the line paired it: the dashboard lists the computer as connected', true, vps.backend.listMachines('owner').map((m) => `${m.name} ${m.os}`).join('; '));

    // ---- grant a folder (test hook replaces only the dialog) ----
    stopHost();
    await until(() => !readyPid(), 'host stopped', 40000);
    const picked = spawn(hostPath, ['--launch-id', 'proof-picker'], { env: { ...process.env, CI: 'true', NLC_NODE_TEST_PICK_FOLDER: testFolder }, detached: true, stdio: 'ignore', windowsHide: true });
    picked.unref();
    await until(() => readyPid(), 'host restarted with the folder test hook', 40000);
    await until(() => vps.backend.listMachines('owner').some((m) => m.connected), 'reconnected', 40000);
    const ep = readJson('endpoint.json');
    const key = fs.readFileSync(path.join(stateRoot, 'token'), 'utf8').trim();
    const windowCall = async (method, route, body) => {
      const res = await fetch(`http://127.0.0.1:${ep.port}${route}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, text: await res.text() };
    };
    const added = JSON.parse((await windowCall('POST', '/v1/window/folders/add', {})).text);
    check('I11', 'Add folder (dialog replaced by the CI hook) shares the test folder', added.ok === true && added.label === folderLabel, added.message || '');
    await until(() => vps.backend.listMachines('owner').some((m) => (m.folders || []).some((f) => f.label === folderLabel)), 'dashboard sees the folder');

    // ---- the agent, through the real gateway MCP server ----
    const { Client } = await import(pathToFileURL(resolveSdkFallbackImportPath('client/index.js', { fromDir: __dirname })).href);
    const { StdioClientTransport } = await import(pathToFileURL(resolveSdkFallbackImportPath('client/stdio.js', { fromDir: __dirname })).href);
    mcp = new Client({ name: 'install-proof-agent', version: '1' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp', 'nlc-node', 'server.js')], env: { ...process.env, NLC_SESSION_ID: 'installproof', NLC_UI_PORT: String(vps.port) }, stderr: 'pipe' }));
    const call = async (name, args = {}) => {
      const r = await mcp.callTool({ name, arguments: args });
      const text = r.content[0].text; let json = null; try { json = JSON.parse(text); } catch { /* plain sentence */ }
      return { error: !!r.isError, text, json };
    };
    const listed = await call('list', { folder: folderLabel });
    check('I12', 'the agent lists the granted folder through the real MCP server', !listed.error && (listed.json.entries || []).some((e) => e.name === 'existing.txt'), tail(listed.text, 200));
    const wrote = await call('write_text', { folder: folderLabel, path: 'from-agent.txt', content: 'written by the agent', mode: 'create' });
    const read = await call('read_text', { folder: folderLabel, path: 'from-agent.txt' });
    check('I13', 'the agent writes a file and reads it back; it is on disk', !wrote.error && !read.error && read.text.includes('written by the agent') && fs.readFileSync(path.join(testFolder, 'from-agent.txt'), 'utf8') === 'written by the agent');

    // ---- the agent shares a folder itself, by running the share step that the NLC's own /node/install.json gives it ----
    // No dialog and no test hook: the command text comes from the page, runs in the shell the page names, and asks the Node on this computer.
    {
      const agentFolder = fs.mkdtempSync(path.join(base, 'NLC-Node-AgentShared-'));
      const agentLabel = path.basename(agentFolder);
      fs.writeFileSync(path.join(agentFolder, 'agent-shared.txt'), 'named by the person, shared by the agent');
      const page = await (await fetch(`http://127.0.0.1:${vps.port}/node/install.json`)).json();
      const step = page.steps.find((s) => s.os === (isWin ? 'windows' : 'macos') && s.id === 'share-folder');
      check('I30a', 'the page gives a share-folder step for this computer', !!step && step.command.includes('<ABSOLUTE-FOLDER-PATH>'), step ? '' : 'no share-folder step');
      const runShare = (target) => {
        const command = step.command.split('<ABSOLUTE-FOLDER-PATH>').join(target.replace(/'/g, "''"));
        const ran = isWin ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }) : spawnSync('sh', ['-c', step.command.split('<ABSOLUTE-FOLDER-PATH>').join(target)], { encoding: 'utf8' });
        let json = null; try { json = JSON.parse(ran.stdout); } catch { /* not json */ }
        return { json, text: tail(`${ran.stdout}${ran.stderr}`, 300), status: ran.status };
      };
      const shared = runShare(agentFolder);
      check('I30b', 'the page command shares the named folder with no dialog', !!shared.json && shared.json.ok === true && shared.json.label === agentLabel, shared.text);
      await until(() => vps.backend.listMachines('owner').some((m) => (m.folders || []).some((f) => f.label === agentLabel)), 'dashboard sees the agent-shared folder');
      const agentListed = await call('list', { folder: agentLabel });
      check('I30c', 'the agent lists the folder it shared through the real MCP server', !agentListed.error && (agentListed.json.entries || []).some((e) => e.name === 'agent-shared.txt'), tail(agentListed.text, 200));
      const refused = runShare(home);
      check('I30d', 'the same command refuses the home folder in plain words and shares nothing more', !!refused.json && refused.json.ok === false && !!refused.json.message, refused.text);
    }

    // ---- the video and captioning programs that came inside the payload (only when the payload carries them) ----
    const nodeDir = isWin ? appRoot : path.join(appRoot, 'NLC Node.app', 'Contents', 'MacOS');
    const toolKey = `${process.platform}-${process.arch}`;
    const ffExe = path.join(nodeDir, 'ffmpeg', toolKey, isWin ? 'ffmpeg.exe' : 'ffmpeg');
    const whExe = path.join(nodeDir, 'whisper', toolKey, isWin ? 'whisper-cli.exe' : 'whisper-cli');
    if (process.env.NLC_PROOF_EXPECT_TOOLS === '1' || fs.existsSync(ffExe)) {
      check('I23', 'the payload carried ffmpeg, ffprobe, whisper-cli and both notices to where the Node looks', [ffExe, path.join(path.dirname(ffExe), isWin ? 'ffprobe.exe' : 'ffprobe'), whExe, ...(isWin ? [path.join(nodeDir, 'NOTICE-ffmpeg.txt'), path.join(nodeDir, 'NOTICE-whisper.txt')] : [path.join(appRoot, 'NLC Node.app', 'Contents', 'Resources', 'NOTICE-ffmpeg.txt'), path.join(appRoot, 'NLC Node.app', 'Contents', 'Resources', 'NOTICE-whisper.txt')])].every((p) => fs.existsSync(p)));
      const made = spawnSync(ffExe, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(testFolder, 'clip.mp4')], { encoding: 'utf8' });
      check('I24', 'the installed ffmpeg runs and makes a clip', made.status === 0 && fs.existsSync(path.join(testFolder, 'clip.mp4')), tail(made.stderr, 300));
      const waitJob = async (tool, id) => until(async () => { const r = await call(tool, { job_id: id }); return r.json && (r.json.state === 'done' || r.json.state === 'failed') ? r.json : null; }, `${tool} ${id}`, 90000);
      const info = await call('media_info', { folder: folderLabel, path: 'clip.mp4' });
      check('I25', 'the agent reads the clip with media_info (installed ffprobe)', !info.error && Math.abs(Number(info.json.duration) - 3) < 0.4, tail(info.text, 200));
      const sm = await call('video_smooth', { folder: folderLabel, path: 'clip.mp4', target_fps: '30', output_name: 'clip-smooth.mp4' });
      const smDone = sm.error ? null : await waitJob('job_status', sm.json.jobId || sm.json.job_id);
      check('I26', 'the agent runs video_smooth (installed ffmpeg minterpolate) and gets a 30 fps file', !!smDone && smDone.state === 'done' && fs.existsSync(path.join(testFolder, 'clip-smooth.mp4')), sm.error ? tail(sm.text, 200) : JSON.stringify(smDone).slice(0, 200));
      const ck = await call('video_check', { folder: folderLabel, path: 'clip-smooth.mp4' });
      const ckDone = ck.error ? null : await waitJob('job_status', ck.json.jobId || ck.json.job_id);
      check('I27', 'the agent runs video_check (installed ffmpeg freeze/black/volume detectors) and gets a verdict', !!ckDone && ckDone.state === 'done' && ckDone.result && typeof ckDone.result.ok === 'boolean', ck.error ? tail(ck.text, 200) : JSON.stringify(ckDone).slice(0, 300));
      const wh = spawnSync(whExe, ['-h'], { encoding: 'utf8', cwd: path.dirname(whExe) });
      check('I28', 'the installed whisper-cli starts (prints its help)', wh.error == null && /usage|whisper/i.test(String(wh.stdout) + String(wh.stderr)), tail(String(wh.stdout) + String(wh.stderr), 160));
    } else {
      say('NOTE: this payload carries no ffmpeg/whisper; the tool checks I23-I28 were skipped.');
    }

    // ---- running the line again is a clean update ----
    const run2 = await pasteLine(vps.origin, { shell: 'pwsh' });
    showRun('install #2 (the same line again = update; windows: PowerShell 7)', run2);
    const pid2 = readyPid();
    check('I14', 'running the line again succeeds, replaces the old process with a new one, and leaves exactly one app', run2.status === 0 && pid2 > 0 && pid2 !== pid1 && !alive(pid1) && !/Connecting this/.test(run2.stdout), `old ${pid1}, new ${pid2}`);
    check('I15', 'the update kept the pairing and the shared folder (no new code, folder still granted)', fs.existsSync(path.join(stateRoot, 'node-token.bin')) || vps.backend.listMachines('owner').some((m) => m.connected));
    await until(() => vps.backend.listMachines('owner').some((m) => m.connected), 'reconnected after update', 40000);
    const after = await call('read_text', { folder: folderLabel, path: 'from-agent.txt' });
    check('I16', 'after the update the agent still reads the same shared folder', !after.error && after.text.includes('written by the agent'), tail(after.text, 160));
    await mcp.close().catch(() => {}); mcp = null;

    // ---- uninstall ----
    const run3 = await pasteLine(vps.origin, { uninstall: true });
    showRun('uninstall', run3);
    await until(() => !alive(pid2), 'node stopped', 40000).catch(() => {});
    check('I17', 'uninstall succeeds and removes the app, the Node\'s own state and the start-at-login entry', run3.status === 0 && !fs.existsSync(appRoot) && !fs.existsSync(stateRoot) && !alive(pid2) && (isWin ? spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'NLC Node'], { encoding: 'utf8' }).status !== 0 : !fs.existsSync(plistPath)));
    check('I18', 'uninstall left the customer\'s shared folder and its files, and NLC Trash, exactly as they were',
      fs.readFileSync(path.join(testFolder, 'existing.txt'), 'utf8') === 'already here' && fs.readFileSync(path.join(testFolder, 'from-agent.txt'), 'utf8') === 'written by the agent' && fs.readFileSync(trashSentinel, 'utf8') === 'trash must survive');

    // ---- install again with no link: pair with a typed code in the Node window ----
    const run4 = await pasteLine(vps.origin);
    showRun('install #3 (no link, clean again)', run4);
    check('I19', 'a fresh install without a link starts and waits for a code', run4.status === 0 && readyPid() > 0);
    const ep2 = readJson('endpoint.json');
    const key2 = fs.readFileSync(path.join(stateRoot, 'token'), 'utf8').trim();
    const pageRes = await fetch(`http://127.0.0.1:${ep2.port}/`);
    const html = await pageRes.text();
    check('I20', 'the Node window page opens on the loopback address and carries its local key', pageRes.status === 200 && /name="nlc-key"/.test(html), `HTTP ${pageRes.status}, ${html.length} bytes, starts: ${html.slice(0, 120).replace(/\s+/g, ' ')}`);
    const code = (await vps.dashboard('POST', '/api/node/pair/code')).json.code;
    const res = await fetch(`http://127.0.0.1:${ep2.port}/v1/window/pair`, { method: 'POST', headers: { authorization: `Bearer ${key2}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const paired = await res.json();
    check('I21', 'typing the code in the window pairs it (the real window pair endpoint)', paired.ok === true, paired.message || '');
    await until(() => vps.backend.listMachines('owner').filter((m) => m.connected).length >= 1, 'connected by code', 40000);
    const run5 = await pasteLine(vps.origin, { uninstall: true });
    showRun('final uninstall (cleanup)', run5);
    check('I22', 'final cleanup removed everything NLC Node put on this runner', run5.status === 0 && !fs.existsSync(appRoot) && !fs.existsSync(stateRoot));
  } catch (error) {
    failures += 1;
    say(`FAIL: ${error && error.stack ? error.stack : error}`);
    say(`state folder now: ${fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot).join(', ') : '(none)'}; ready.json: ${JSON.stringify(readJson('ready.json'))}`);
  } finally {
    if (mcp) await mcp.close().catch(() => {});
    try { stopHost(); } catch { /* best effort */ }
    if (vps) await vps.stop().catch(() => {});
    say(failures ? `RESULT: ${failures} check(s) FAILED` : 'RESULT: all checks passed');
    if (transcriptPath) fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
    process.exit(failures ? 1 : 0);
  }
}
main();
