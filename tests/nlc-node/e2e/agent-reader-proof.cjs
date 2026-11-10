'use strict';
// "Agent reader" proof (NOT a unit test). Runs ONLY on a clean CI runner (macOS or Windows).
// A scripted reader is given exactly ONE thing, the link the dashboard hands out (https://<NLC>/node?link=...), and nothing else:
// it reads the page, follows install.json for this computer's OS step by step, checks the SHA-256 shown on the page against the
// real download, runs the page's own install command, confirms success with the page's own check, pairs with the link, and
// lists a shared folder through the real gateway MCP server. Finally it removes everything with the page's own removal command.
// It does not use any file of this repository except to start the real server side the link points at.
//   node tests/nlc-node/e2e/agent-reader-proof.cjs --artifacts <folder holding the payloads> [--transcript <file>]
// A real Claude or Codex given the same link is a separate, parked step (needs a subscription sign-in): see BUILD-LINK.md.
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
async function until(cond, label, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await cond(); if (v) return v; await sleep(250); }
  throw new Error('timed out waiting for ' + label);
}
const tail = (s, n = 1500) => String(s).trim().slice(-n);

const home = os.homedir();
const stateRoot = isWin ? path.join(process.env.LOCALAPPDATA, 'NLC Node') : path.join(home, 'Library', 'Application Support', 'NLC Node');
const appRoot = isWin ? path.join(process.env.LOCALAPPDATA, 'Programs', 'NLC Node') : path.join(stateRoot, 'app');
const hostPath = isWin ? path.join(appRoot, 'NLC Node Host.exe') : path.join(appRoot, 'NLC Node.app', 'Contents', 'MacOS', 'NLC Node Host');
const readJson = (name) => { try { return JSON.parse(fs.readFileSync(path.join(stateRoot, name), 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readyPid = () => { const r = readJson('ready.json'); return r && r.state === 'ready' && alive(r.pid) ? r.pid : 0; };

// ---- the customer's NLC (real server side) ----
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
  registerNodeDownloadRoutes({ app, artifactDir: artifacts, env: { NLC_NODE_BUILD: 'ci' } });
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

// ---- the reader: a small checker for the part of JSON Schema the page's schema uses ----
function validate(value, schema, where = 'install.json') {
  const errors = [];
  const types = [].concat(schema.type || []);
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types.length && !types.includes(typeOf(value))) return [`${where}: expected ${types.join('/')}, got ${typeOf(value)}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: ${JSON.stringify(value)} not allowed`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${where}: bad format`);
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${where}: missing ${key}`);
    for (const [key, sub] of Object.entries(schema.properties || {})) if (key in value) errors.push(...validate(value[key], sub, `${where}.${key}`));
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') for (const [key, v] of Object.entries(value)) errors.push(...validate(v, schema.additionalProperties, `${where}.${key}`));
  }
  if (typeOf(value) === 'array' && schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items, `${where}[${i}]`)));
  return errors;
}

// Runs a command string from the page the way a customer's assistant would: in the computer's own shell, as the user.
function runPageCommand(command, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, NLC_NODE_NO_OPEN: '1', ...extraEnv };
    let program; let args;
    if (isWin) { delete env.PSModulePath; program = 'powershell.exe'; args = ['-NoProfile', '-NonInteractive', '-Command', command]; }
    else { program = 'sh'; args = ['-c', command]; }
    const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 240000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
function show(label, r) {
  say(`${label}: exit ${r.status}`);
  for (const l of tail(r.stdout, 1500).split(/\r?\n/)) if (l.trim()) say(`    | ${l}`);
  for (const l of tail(r.stderr, 600).split(/\r?\n/)) if (l.trim()) say(`    ! ${l}`);
}
function stopHost() { if (fs.existsSync(hostPath)) spawnSync(hostPath, ['--stop'], { timeout: 60000, windowsHide: true }); }

async function main() {
  say(`Agent-reader proof. Node ${process.version}, ${os.platform()} ${os.release()} ${os.arch()}`);
  const osName = isWin ? 'windows' : 'macos';
  check('A00', 'clean machine: no NLC Node installed yet', !fs.existsSync(appRoot) && !fs.existsSync(stateRoot));
  const base = fs.realpathSync(process.env.RUNNER_TEMP || os.tmpdir());
  const tempDir = fs.mkdtempSync(path.join(base, 'nlc-agent-reader-'));
  const testFolder = fs.mkdtempSync(path.join(base, 'NLC-Node-Test-'));
  const folderLabel = path.basename(testFolder);
  fs.writeFileSync(path.join(testFolder, 'existing.txt'), 'already here');
  const trashSentinel = path.join(home, 'NLC Trash', 'sentinel-agent-reader.txt');
  fs.mkdirSync(path.dirname(trashSentinel), { recursive: true });
  fs.writeFileSync(trashSentinel, 'trash must survive');

  let vps = null; let mcp = null;
  try {
    vps = await startServer(tempDir);
    // The customer presses "Add a computer" in My computer; the dashboard shows the assistant link. That string is all the reader gets.
    const pair = await vps.dashboard('POST', '/api/node/pair/code');
    const theLink = `${vps.origin}/node?link=${encodeURIComponent(pair.json.link)}`;
    say(`The one link handed to the reader: ${theLink}`);

    // ---- read the page ----
    const pageRes = await fetch(theLink);
    const html = await pageRes.text();
    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    const ld = ldMatch ? JSON.parse(ldMatch[1]) : null;
    check('A01', 'the link opens a page that names what it is and who makes it (SoftwareApplication, FTay Consulting Sdn Bhd)', pageRes.status === 200 && ld && ld['@type'] === 'SoftwareApplication' && ld.publisher.name === 'FTay Consulting Sdn Bhd' && html.includes('Ask the user before you run anything'), `HTTP ${pageRes.status}, ${html.length} bytes`);
    const hrefMatch = html.match(/href="([^"]*install\.json[^"]*)"/);
    check('A02', 'the page points to its machine-readable description (install.json) carrying the same link', !!hrefMatch && /link=/.test(hrefMatch[1]), hrefMatch ? hrefMatch[1] : 'no link found');
    const jsonUrl = new URL(hrefMatch[1].replace(/&amp;/g, '&'), theLink).href;
    const doc = await (await fetch(jsonUrl)).json();
    const schema = await (await fetch(doc.$schema)).json();
    const problems = validate(doc, schema);
    check('A03', 'install.json is valid against the schema the page itself points to', problems.length === 0, problems.slice(0, 3).join('; '));
    check('A04', 'status is ready, publisher named, no administrator rights needed', doc.status === 'ready' && doc.publisher.name === 'FTay Consulting Sdn Bhd' && doc.requires.admin_rights === false);
    const llms = await (await fetch(`${vps.origin}/node/llms.txt?link=${encodeURIComponent(pair.json.link)}`)).text();
    const installStep = doc.steps.find((s) => s.os === osName && s.id === 'install');
    check('A05', 'llms.txt says the same install command as install.json', llms.includes(installStep.command));

    // ---- the reader's own policy: it asks its user before installing (answered yes here) ----
    say(`Reader asks the user: "${doc.ask_user_first[0]}" -> user: yes (scripted)`);

    // ---- verify the download against the page ----
    const payloadFile = isWin ? 'payload-win-x64.zip' : (os.arch() === 'arm64' ? 'payload-macos-arm64.tar.gz' : 'payload-macos-x64.tar.gz');
    const route = isWin ? 'win-x64.zip' : (os.arch() === 'arm64' ? 'mac-arm64.tar.gz' : 'mac-x64.tar.gz');
    const wanted = doc.verify.sha256[payloadFile];
    const bytes = Buffer.from(await (await fetch(`${vps.origin}/downloads/nlc-node/payload/${route}`)).arrayBuffer());
    const got = crypto.createHash('sha256').update(bytes).digest('hex');
    check('A06', 'the SHA-256 shown on the page equals the SHA-256 of the real download', !!wanted && wanted === got, `${payloadFile} ${got.slice(0, 16)}...`);
    const hashStep = doc.steps.find((s) => s.os === osName && s.id === 'check-download');
    const hashRun = await runPageCommand(hashStep.command);
    check('A07', 'the page\'s own check-download command prints the same checksum', hashRun.status === 0 && hashRun.stdout.trim().split(/\s+/)[0] === wanted, tail(hashRun.stdout, 100));

    // ---- install with the page's command ----
    const run1 = await runPageCommand(installStep.command);
    show('install (the page\'s command)', run1);
    check('A08', 'the page\'s install command succeeds and prints what the page said to expect', run1.status === 0 && /NLC Node is installed and running\./.test(run1.stdout) && /Connected\./.test(run1.stdout));

    // ---- confirm with the page's own check ----
    const confirmStep = doc.steps.find((s) => s.os === osName && s.id === 'confirm-running');
    const conf = await runPageCommand(confirmStep.command);
    show('confirm-running (the page\'s check)', conf);
    check('A09', 'the page\'s own running-check answers ready', conf.status === 0 && conf.stdout.includes('ready'), tail(conf.stdout, 100));
    const pid = readyPid();
    check('A10', `the process named on the page is running (${isWin ? 'NLC Node Host.exe' : 'NLC Node Host'})`, pid > 0 && fs.existsSync(hostPath), `pid ${pid}`);
    await until(() => vps.backend.listMachines('owner').some((m) => m.connected), 'computer connected after the link');
    check('A11', 'pairing happened from the link alone: the dashboard lists the computer as connected', true, vps.backend.listMachines('owner').map((m) => `${m.name} ${m.os}`).join('; '));

    // ---- the customer adds a folder (the CI hook replaces only the folder dialog) ----
    stopHost();
    await until(() => !readyPid(), 'host stopped');
    spawn(hostPath, ['--launch-id', 'agent-reader-picker'], { env: { ...process.env, CI: 'true', NLC_NODE_TEST_PICK_FOLDER: testFolder }, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await until(() => readyPid(), 'host restarted');
    await until(() => vps.backend.listMachines('owner').some((m) => m.connected), 'reconnected');
    const ep = readJson('endpoint.json');
    const key = fs.readFileSync(path.join(stateRoot, 'token'), 'utf8').trim();
    const addRes = await fetch(`http://127.0.0.1:${ep.port}/v1/window/folders/add`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}' });
    const added = await addRes.json();
    check('A12', 'Add folder (dialog replaced by the CI hook) shares the test folder', added.ok === true && added.label === folderLabel);
    await until(() => vps.backend.listMachines('owner').some((m) => (m.folders || []).some((f) => f.label === folderLabel)), 'dashboard sees folder');

    // ---- list the granted folder through the real gateway MCP server ----
    const { Client } = await import(pathToFileURL(resolveSdkFallbackImportPath('client/index.js', { fromDir: __dirname })).href);
    const { StdioClientTransport } = await import(pathToFileURL(resolveSdkFallbackImportPath('client/stdio.js', { fromDir: __dirname })).href);
    mcp = new Client({ name: 'agent-reader', version: '1' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp', 'nlc-node', 'server.js')], env: { ...process.env, NLC_SESSION_ID: 'agentreader', NLC_UI_PORT: String(vps.port) }, stderr: 'pipe' }));
    const listed = await mcp.callTool({ name: 'list', arguments: { folder: folderLabel } });
    const listedText = listed.content[0].text;
    check('A13', 'the NLC assistant lists the shared folder through the real gateway MCP server', !listed.isError && listedText.includes('existing.txt'), tail(listedText, 160));
    await mcp.close().catch(() => {}); mcp = null;

    // ---- remove with the page's own command ----
    const removal = doc.uninstall.steps.find((s) => s.os === osName);
    const run2 = await runPageCommand(removal.command);
    show('uninstall (the page\'s command)', run2);
    await until(() => !alive(pid), 'node stopped').catch(() => {});
    check('A14', 'the page\'s removal command removes the app, its state and the process', run2.status === 0 && !fs.existsSync(appRoot) && !fs.existsSync(stateRoot) && !alive(pid));
    check('A15', 'removal left the customer\'s folder and NLC Trash exactly as they were', fs.readFileSync(path.join(testFolder, 'existing.txt'), 'utf8') === 'already here' && fs.readFileSync(trashSentinel, 'utf8') === 'trash must survive');
  } catch (error) {
    failures += 1;
    say(`FAIL: ${error && error.stack ? error.stack : error}`);
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
