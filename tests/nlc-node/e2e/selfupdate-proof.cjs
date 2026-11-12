'use strict';
// NLC Node self-update proof (NOT a unit test). Runs ONLY on a clean GitHub Actions runner (macOS or Windows). It installs an
// "old" NLC Node with the exact line a customer pastes, against the real server side (download routes, pairing, node socket,
// update notice) on a local port. It then publishes a newer build on that server (the same payload with one more file in it, so
// its checksum differs) and does nothing else: the Node must notice by itself when it signs in again, fetch and check the new
// build, put it in place, restart quietly and come back connected.
//   node tests/nlc-node/e2e/selfupdate-proof.cjs --artifacts <folder holding the built payloads> [--transcript <file>]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

if (process.env.CI !== 'true' || !process.env.GITHUB_ACTIONS) {
  console.error('This proof installs NLC Node on the machine it runs on. It only runs on a GitHub Actions runner.');
  process.exit(2);
}
const root = path.resolve(__dirname, '../../..');
const uiRequire = createRequire(path.join(root, 'ui', 'package.json'));
const NAMES = require(path.join(root, 'lib/nlc-node/artifact-names.cjs'));
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
  while (Date.now() < end) { const v = await cond(); if (v) return v; await sleep(500); }
  throw new Error('timed out waiting for ' + label);
}
const tail = (s, n = 1200) => String(s).trim().slice(-n);

const home = os.homedir();
const stateRoot = isWin ? path.join(process.env.LOCALAPPDATA, 'NLC Node') : path.join(home, 'Library', 'Application Support', 'NLC Node');
const appRoot = isWin ? path.join(process.env.LOCALAPPDATA, 'Programs', 'NLC Node') : path.join(stateRoot, 'app');
const hostPath = isWin ? path.join(appRoot, 'NLC Node Host.exe') : path.join(appRoot, 'NLC Node.app', 'Contents', 'MacOS', 'NLC Node Host');
const markerInApp = isWin ? path.join(appRoot, 'build-b.txt') : path.join(appRoot, 'NLC Node.app', 'Contents', 'Resources', 'build-b.txt');
const readJson = (name) => { try { return JSON.parse(fs.readFileSync(path.join(stateRoot, name), 'utf8')); } catch { return null; } };
const readBuild = () => { try { return fs.readFileSync(path.join(stateRoot, 'installed-build.txt'), 'utf8').trim(); } catch { return ''; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readyPid = () => { const r = readJson('ready.json'); return r && r.state === 'ready' && alive(r.pid) ? r.pid : 0; };
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const payloadFile = isWin ? NAMES.PAYLOAD_NAMES['windows-x64'] : NAMES.PAYLOAD_NAMES[`macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`];

async function startServer(dir, served) {
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
  const downloads = registerNodeDownloadRoutes({ app, artifactDir: served, env: {} });
  const server = http.createServer(app);
  const wsHandler = createNodeWebSocketHandler({ backend, updateNotice: downloads.updateNotice });
  const sockets = new Set();
  const signIns = [];
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://x').pathname === '/node-ws') { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); signIns.push(Date.now()); wsHandler.handleUpgrade(request, socket, head); } else socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    backend, origin: `http://127.0.0.1:${port}`, signIns,
    // What a network drop does to the Node's line: the Node signs in again by itself.
    dropLine() { for (const s of sockets) s.destroy(); },
    async dashboard(method, route, body) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'x-test-owner': 'owner', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    async stop() { wsHandler.close(); backend.close(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
}

function pasteLine(origin, { link = '', uninstall = false } = {}) {
  const query = link ? `?link=${encodeURIComponent(link)}` : '';
  return new Promise((resolve) => {
    const env = { ...process.env, NLC_NODE_NO_OPEN: '1' };
    let command; let args;
    if (isWin) {
      if (uninstall) env.NLC_NODE_UNINSTALL = '1';
      command = 'powershell.exe';
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

// A newer published build: the same payload with one more file inside, so its checksum differs and the swap is visible.
function makeNewerBuild(oldPayload, newPayload) {
  const work = fs.mkdtempSync(path.join(path.dirname(newPayload), 'newer-'));
  const tar = isWin ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  const unpack = spawnSync(tar, [isWin ? '-xf' : '-xzf', oldPayload, '-C', work], { encoding: 'utf8' });
  if (unpack.status !== 0) throw new Error('could not unpack the old payload: ' + tail(unpack.stderr));
  const marker = isWin ? path.join(work, 'build-b.txt') : path.join(work, 'NLC Node.app', 'Contents', 'Resources', 'build-b.txt');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, 'newer build\n');
  const pack = isWin ? spawnSync(tar, ['-a', '-cf', newPayload, '-C', work, '.'], { encoding: 'utf8' }) : spawnSync(tar, ['-czf', newPayload, '-C', work, '.'], { encoding: 'utf8' });
  if (pack.status !== 0) throw new Error('could not pack the newer payload: ' + tail(pack.stderr));
  fs.rmSync(work, { recursive: true, force: true });
}
function publish(served, file, bytesPath) {
  fs.copyFileSync(bytesPath, path.join(served, `${file}.part`));
  // On Windows another program (a virus scan, a download that has only just closed) can hold either file for a moment: ask again for a few seconds before giving up.
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(path.join(served, `${file}.part`), path.join(served, file)); break; } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  fs.writeFileSync(path.join(served, `${file}.sha256`), `${sha256File(path.join(served, file))}  ${file}\n`);
}

async function main() {
  say(`NLC Node self-update proof. Node ${process.version}, ${os.platform()} ${os.release()} ${os.arch()}, payload ${payloadFile}`);
  check('S00', 'this is a clean machine: no NLC Node installed yet', !fs.existsSync(appRoot) && !fs.existsSync(stateRoot));
  const base = fs.realpathSync(process.env.RUNNER_TEMP || os.tmpdir());
  const tempDir = fs.mkdtempSync(path.join(base, 'nlc-selfupdate-proof-'));
  const served = path.join(tempDir, 'served');
  fs.mkdirSync(served);
  for (const f of fs.readdirSync(artifacts)) fs.copyFileSync(path.join(artifacts, f), path.join(served, f));
  const shaA = fs.readFileSync(path.join(served, `${payloadFile}.sha256`), 'utf8').trim().split(/\s+/)[0];
  let vps = null;
  try {
    vps = await startServer(tempDir, served);
    say(`Server side (real routes and update notice) on ${vps.origin}; old build ${shaA.slice(0, 12)}`);
    const link = (await vps.dashboard('POST', '/api/node/pair/code')).json.link;
    const run1 = await pasteLine(vps.origin, { link });
    say(`install of the old build: exit ${run1.status}`);
    check('S01', 'the old build installs with the customer line and runs', run1.status === 0 && readyPid() > 0, tail(run1.stdout + run1.stderr, 600));
    check('S02', 'the install recorded which build it put in place', readBuild() === shaA, `installed-build.txt = ${readBuild().slice(0, 12)}`);
    await until(() => vps.backend.listMachines('owner').some((m) => m.connected), 'old build connected', 60000);
    const oldPid = readyPid();
    check('S03', 'the old build is paired and connected', oldPid > 0, `pid ${oldPid}`);
    // The restart supervision is in place right after the first install, before any update: a task that is missing later was either never registered or lost to the update, and this tells the two apart.
    if (isWin) {
      const sup0 = spawnSync('schtasks.exe', ['/Query', '/TN', 'NLC Node'], { encoding: 'utf8' });
      check('S03b', 'right after the first install the restart supervision task is registered', sup0.status === 0, tail(sup0.stdout + sup0.stderr, 200));
    } else {
      check('S03b', 'right after the first install the restart supervisor job file is in place', fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.nlc.node.supervisor.plist')));
    }
    // Signed in on the current build: no update starts.
    await sleep(4000);
    check('S04', 'while the published build is the installed one, nothing is updated', !fs.existsSync(path.join(stateRoot, 'update-attempt.json')) && readyPid() === oldPid);

    // ---- publish a newer build; do nothing to the computer ----
    const newerPayload = path.join(tempDir, isWin ? 'newer-payload.zip' : 'newer-payload.tar.gz'); // bsdtar picks the archive kind from the name
    makeNewerBuild(path.join(served, payloadFile), newerPayload);
    publish(served, payloadFile, newerPayload);
    const shaB = fs.readFileSync(path.join(served, `${payloadFile}.sha256`), 'utf8').trim().split(/\s+/)[0];
    check('S05', 'a newer build is now published on the server', shaB !== shaA, `new build ${shaB.slice(0, 12)}`);
    // On Windows, watch the whole desktop for any window that appears while the update runs. A control window is opened first,
    // so a watcher that is blind to windows shows up as a failure instead of a false "no window".
    let watcher = null;
    if (isWin) {
      const watchLog = path.join(tempDir, 'windows-shown.log');
      const stopFile = path.join(tempDir, 'windows-shown.stop');
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'window-watch.ps1'), '-Out', watchLog, '-StopFile', stopFile, '-Seconds', '900'], { stdio: 'ignore', windowsHide: true });
      const readLog = () => { try { return fs.readFileSync(watchLog, 'utf8'); } catch { return ''; } };
      await until(() => /READY\|True/.test(readLog()), 'the window watcher to be ready', 60000);
      const control = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'window-control.ps1')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
      let controlSaid = ''; control.stdout.on('data', (c) => { controlSaid += c; }); control.stderr.on('data', (c) => { controlSaid += c; });
      await until(() => /NLC-CONTROL/.test(readLog()), 'the watcher to see the control window', 30000).catch(() => {});
      check('W0', 'the window watcher sees a window that is deliberately shown (so "no window" below means something)', /NLC-CONTROL/.test(readLog()), `${tail(readLog(), 400)} ${controlSaid ? 'control said: ' + tail(controlSaid, 300) : ''}`);
      spawn('cmd.exe', ['/c', 'start "NLC-CONSOLE-CONTROL" ping -n 4 127.0.0.1'], { stdio: 'ignore', windowsHide: false });
      await sleep(3000);
      say(`  (info) the watcher ${/NLC-CONSOLE-CONTROL/.test(readLog()) ? 'also sees' : 'does not see'} a deliberately shown console window`);
      watcher = { child, stopFile, readLog };
    }
    const signInsBefore = vps.signIns.length;
    vps.dropLine();
    await until(() => vps.signIns.length > signInsBefore, 'the Node signs in again', 60000);
    say('The Node signed in again by itself. Waiting for it to update itself.');
    await until(() => readBuild() === shaB, 'installed-build.txt to name the newer build', 240000);
    check('S06', 'the installed build is now the newer one', readBuild() === shaB);
    const newPid = await until(() => { const p = readyPid(); return p && p !== oldPid ? p : 0; }, 'the new Node to be running', 120000);
    check('S07', 'a new Node process runs and the old one is gone', newPid > 0 && !alive(oldPid), `old ${oldPid}, new ${newPid}`);
    check('S08', 'the newer payload really is what is in place', fs.existsSync(markerInApp), markerInApp);
    await until(() => vps.backend.listMachines('owner').some((m) => m.connected), 'connected after the update', 90000);
    check('S09', 'it came back connected with the same pairing, with no new code or link', vps.backend.listMachines('owner').filter((m) => m.connected).length === 1);
    if (watcher) {
      await sleep(8000); // anything the update still does at its very end
      fs.writeFileSync(watcher.stopFile, 'stop');
      await until(() => /DONE/.test(watcher.readLog()), 'the window watcher to finish', 30000).catch(() => {});
      const shown = watcher.readLog().split(/\r?\n/).filter((l) => l && !/^(READY|DONE)/.test(l) && !/NLC-(CONSOLE-)?CONTROL/.test(l));
      for (const l of shown) say(`  (window shown) ${l}`);
      const NOISY = /^(powershell|pwsh|cmd|conhost|wscript|cscript|schtasks|tar|curl|openconsole|windowsterminal|nlc node.*)$/i;
      const flagged = shown.filter((l) => { const parts = l.split('|'); return parts[3] === 'ConsoleWindowClass' || NOISY.test(parts[2] || ''); });
      check('W1', 'no window of any kind appeared, not even a brief console flash, while Node updated itself', flagged.length === 0, `${shown.length} other window(s) logged, ${flagged.length} from the update`);
    }
    const attempt = readJson('update-attempt.json');
    check('S10', 'the update was recorded against the announced build', attempt && attempt.sha256 === shaB);
    if (isWin) {
      const gone = spawnSync('schtasks.exe', ['/Query', '/TN', 'NLC Node Update'], { encoding: 'utf8' });
      check('S11', 'the one-time update task cleaned itself up', gone.status !== 0, tail(gone.stdout + gone.stderr, 200));
      const sup = spawnSync('schtasks.exe', ['/Query', '/TN', 'NLC Node'], { encoding: 'utf8' });
      check('S12', 'the restart supervision task is registered after the update', sup.status === 0, tail(sup.stdout + sup.stderr, 200));
      if (sup.status !== 0) {
        const adapters = require(path.join(root, 'lib/nlc-node/platform-adapters.cjs'));
        const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout;
        const sid = (who.match(/S-\d(?:-\d+)+/) || [''])[0];
        const plan = adapters.windowsSupervisorPlan({ executablePath: hostPath, userSid: sid });
        const xmlFile = path.join(tempDir, 'diag-task.xml');
        fs.writeFileSync(xmlFile, Buffer.from('\ufeff' + plan.document, 'utf16le'));
        const made = spawnSync('schtasks.exe', ['/Create', '/TN', 'NLC Node Diag', '/XML', xmlFile, '/F'], { encoding: 'utf8' });
        say(`  (diagnosis) schtasks /Create with the Host's own plan: exit ${made.status} ${tail(made.stdout + made.stderr, 600)}`);
        spawnSync('schtasks.exe', ['/Delete', '/TN', 'NLC Node Diag', '/F'], { encoding: 'utf8' });
      }
    } else {
      const job = spawnSync('launchctl', ['list'], { encoding: 'utf8' });
      const jobGone = await until(() => !/com\.nlc\.node\.update/.test(spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout), 'the update job to finish', 60000).catch(() => false);
      check('S11', 'the one-time update job cleaned itself up', Boolean(jobGone), job.stdout.split('\n').filter((x) => /nlc/i.test(x)).join(' | '));
      const plist = path.join(home, 'Library', 'LaunchAgents', 'com.nlc.node.supervisor.plist');
      const lint = fs.existsSync(plist) ? spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' }) : { status: 1, stdout: 'missing' };
      check('S12', 'the restart supervisor is installed as a valid launchd job', lint.status === 0, tail(lint.stdout + lint.stderr, 200));
    }

    // ---- restarts by itself: kill the Node hard and let the supervisor bring it back ----
    process.kill(newPid, 'SIGKILL');
    await until(() => !alive(newPid), 'the Node to be killed', 20000);
    if (isWin) spawnSync('schtasks.exe', ['/Run', '/TN', 'NLC Node'], { encoding: 'utf8' });
    else spawnSync('launchctl', ['kickstart', `gui/${process.getuid()}/com.nlc.node.supervisor`], { encoding: 'utf8' });
    const revived = await until(() => { const p = readyPid(); return p && p !== newPid ? p : 0; }, 'the supervisor to start the Node again', 90000).catch(() => 0);
    check('S13', 'a Node that was killed is started again by the restart supervisor (the check the scheduler makes every 5 minutes, run now)', revived > 0, `pid ${revived}`);
    await until(() => vps.backend.listMachines('owner').some((m) => m.connected), 'connected after the restart', 90000).catch(() => {});
    check('S14', 'and it is connected again', vps.backend.listMachines('owner').some((m) => m.connected));

    const run9 = await pasteLine(vps.origin, { uninstall: true });
    check('S15', 'uninstall removes it, supervisor included', run9.status === 0 && !fs.existsSync(appRoot) && !fs.existsSync(stateRoot), tail(run9.stdout + run9.stderr, 300));
  } catch (error) {
    failures += 1;
    say(`FAIL: ${error && error.stack ? error.stack : error}`);
    say(`state folder now: ${fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot).join(', ') : '(none)'}; ready.json: ${JSON.stringify(readJson('ready.json'))}; installed-build: ${readBuild().slice(0, 12)}`);
    for (const name of ['update/run-update.ps1', 'update/run-update.vbs', 'update/run-update.sh', 'update/update.log']) { try { say(`${name}: ${fs.readFileSync(path.join(stateRoot, name), 'utf8').slice(-3000)}`); } catch { say(`${name}: (not there)`); } }
    if (isWin) { const q = spawnSync('schtasks.exe', ['/Query', '/TN', 'NLC Node Update', '/V', '/FO', 'LIST'], { encoding: 'utf8' }); say(`update task: ${tail(q.stdout + q.stderr, 900)}`); const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process | Where-Object { $_.Name -match "NLC|wscript|powershell" } | Select-Object Name, Id | Format-Table -HideTableHeaders | Out-String'], { encoding: 'utf8' }); say(`processes: ${tail(ps.stdout, 500)}`); }
    else { const l = spawnSync('launchctl', ['list'], { encoding: 'utf8' }); say(`launchctl: ${tail(l.stdout.split('\n').filter((x) => /nlc/i.test(x)).join('\n'), 500)}`); }
  } finally {
    try { if (fs.existsSync(hostPath)) spawnSync(hostPath, ['--stop'], { timeout: 60000, windowsHide: true }); } catch { /* best effort */ }
    if (vps) await vps.stop().catch(() => {});
    say(failures ? `RESULT: ${failures} check(s) FAILED` : 'RESULT: all checks passed');
    if (transcriptPath) fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
    process.exit(failures ? 1 : 0);
  }
}
main();
