'use strict';
// The running NLC Node: puts the pieces together (shared folders, path guard, file/trash/log/video modules,
// command dispatcher, the line to the customer's NLC server, the Node window, the tray indicator file).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModuleHost } = require('./module-host.cjs');
const { createGrants } = require('./grants.cjs');
const { createPathGuard } = require('./path-guard.cjs');
const { createDispatcher } = require('./dispatcher.cjs');
const { createConnection, createTokenStore, NETWORK_MESSAGE } = require('./connection.cjs');
const { createWindow } = require('./window.cjs');
const { createLaunchController } = require('./launch-protocol.cjs');
const { ensurePrivateToken, ensureStateRoot, resolveStateRoot } = require('./local-state.cjs');
const { selectPlatformAdapter } = require('./platform-adapters.cjs');
const { resolveFfmpeg: defaultResolveFfmpeg } = require('./ffmpeg-path.cjs');
const files = require('./modules/files.cjs');
const trash = require('./modules/trash.cjs');
const actionLog = require('./modules/action-log.cjs');
const { videoDescriptor } = require('./modules/video.cjs');
const { createCentralConnector } = require('./central.cjs');
const { createServerPairings, serverKey } = require('./server-pairings.cjs');
const { createSelfUpdater } = require('./self-update.cjs');
const { speechDescriptor } = require('./modules/speech.cjs');
const { resolveWhisper: defaultResolveWhisper } = require('./whisper-path.cjs');

const INDICATOR_FILE = 'indicator.json';
const ORIGIN_FILE = 'origin.txt';
const INDICATOR_EVERY_MS = 20000;
const NO_ORIGIN_MESSAGE = 'This copy of NLC Node does not know where to connect. Download it again from your NLC dashboard.';

// The origin of the customer's NLC server: given directly, or one line in origin.txt, or NLC_NODE_ORIGIN.
function readOrigin(stateRoot, explicit, env) {
  if (explicit) return String(explicit).trim();
  if (env && env.NLC_NODE_ORIGIN) return String(env.NLC_NODE_ORIGIN).trim();
  try { return fs.readFileSync(path.join(stateRoot, ORIGIN_FILE), 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

// Modules get what they need (the path guard, the state folder) through their create() context.
function withContext(descriptor, extra) {
  return { manifest: descriptor.manifest, create: (context) => descriptor.create({ ...context, ...extra }) };
}

function createNodeApp({
  version = '0.1.0',
  stateRoot = resolveStateRoot(),
  platform = process.platform,           // file rules (path style, forbidden folders)
  reportedOs = platform,                 // what the server is told: 'win32' or 'darwin'
  homeDir = os.homedir(),
  nodeDir = path.dirname(process.execPath),
  origin = '',
  env = process.env,
  machineName = os.hostname(),
  protector = null,
  addFolder = null,
  resolveFfmpeg = null,
  resolveWhisper = null,
  speechOptions = {},                    // tests only: model table and download function for the speech module
  launchId,
  events = null,
  fetchImpl, WebSocketImpl,
  indicatorEveryMs = INDICATOR_EVERY_MS,
  keepaliveMs,
  askRetryMs,
  healthCheckIntervalMs,
  centralOptions = {},
} = {}) {
  ensureStateRoot(stateRoot);
  const grants = createGrants({ stateDir: stateRoot, platform, homeDir, protectedRoots: [stateRoot] });
  const pathGuard = createPathGuard({ grants, platform });
  const host = new ModuleHost({ version });
  const ffmpegResolver = resolveFfmpeg || ((options = {}) => defaultResolveFfmpeg({ platform, nodeDir: options.nodeDir || nodeDir }));
  const whisperResolver = resolveWhisper || ((options = {}) => defaultResolveWhisper({ platform, nodeDir: options.nodeDir || nodeDir }));
  const descriptors = [
    withContext(files, { pathGuard }),
    withContext(trash, { pathGuard, homeDir }),
    withContext(actionLog, { stateDir: stateRoot }),
    videoDescriptor({ pathGuard, resolveFfmpeg: ffmpegResolver, nodeDir }),
    speechDescriptor({ pathGuard, resolveFfmpeg: ffmpegResolver, resolveWhisper: whisperResolver, nodeDir, modelsDir: path.join(stateRoot, 'models'), ...speechOptions }),
  ];
  // Video tools take up to 10 minutes to answer (the dispatcher's default for them); everything else 30 s.
  const dispatcher = createDispatcher({ host: { instances: () => host.instances() }, grants });

  const central = createCentralConnector({ homeDir, nodeDir, ...centralOptions });
  const originUrl = readOrigin(stateRoot, origin, env);
  // A newer published build named by the server this computer is paired with: the Node updates itself (self-update.cjs).
  function updateHooks(address) {
    const updater = createSelfUpdater({ stateRoot, origin: address, platform: reportedOs });
    return { buildProvider: () => updater.installedBuild(), onUpdateNotice: (notice) => { updater.handleNotice(notice).catch(() => {}); } };
  }
  function buildConnection(address) {
    const sealer = protector || selectPlatformAdapter({ platform }).credentialProtector;
    return createConnection({
      origin: address,
      tokenStore: createTokenStore({ stateRoot, protector: sealer }),
      dispatcher, machineName, os: reportedOs, version, events, ...updateHooks(address),
      stateProvider: () => ({ paused: grants.isPaused(), folders: grants.list().map((g) => ({ label: g.label, path: g.path })) }),
      onStatus: () => writeIndicator(), autoRequest: true,
      ...(fetchImpl ? { fetchImpl } : {}), ...(WebSocketImpl ? { WebSocketImpl } : {}), ...(keepaliveMs ? { keepaliveMs } : {}), ...(askRetryMs ? { askRetryMs } : {}),
    });
  }
  let connection = originUrl ? buildConnection(originUrl) : null;


  const servers = createServerPairings({
    stateRoot,
    legacyEntry: connection ? { origin: originUrl, connection, grants, dispatcher } : null,
    async createEntry(serverOrigin, serverRoot) {
      ensureStateRoot(serverRoot);
      const ownGrants = createGrants({ stateDir: serverRoot, platform, homeDir, protectedRoots: [stateRoot] });
      const effectiveGrants = Object.freeze({
        list: () => ownGrants.list(),
        isPaused: () => grants.isPaused() || ownGrants.isPaused(),
        setPaused: value => ownGrants.setPaused(value),
      });
      const scopedGuard = createPathGuard({ grants: effectiveGrants, platform });
      const instances = [
        files.create({ pathGuard: scopedGuard }),
        trash.create({ pathGuard: scopedGuard, homeDir: serverRoot }),
        actionLog.create({ stateDir: serverRoot }),
        videoDescriptor({ pathGuard: scopedGuard, resolveFfmpeg: ffmpegResolver, nodeDir }).create({}),
        speechDescriptor({ pathGuard: scopedGuard, resolveFfmpeg: ffmpegResolver, resolveWhisper: whisperResolver, nodeDir, modelsDir: path.join(stateRoot, 'models'), ...speechOptions }).create({}),
      ];
      await host.register({
        manifest: { apiVersion: files.manifest.apiVersion, id: 'server-' + serverKey(serverOrigin), version: '1.0.0', dependsOn: [] },
        create: () => ({
          tools: Object.assign({}, ...instances.map(instance => instance.tools || {})),
          async start() { for (const instance of instances) await instance.start(); },
          async health() { return { ok: true, modules: await Promise.all(instances.map(instance => instance.health())) }; },
          async stop() { for (const instance of [...instances].reverse()) await instance.stop(); },
        }),
      });
      const scopedDispatcher = createDispatcher({ host: instances, grants: effectiveGrants });
      const sealer = protector || selectPlatformAdapter({ platform }).credentialProtector;
      const scopedConnection = createConnection({
        origin: serverOrigin, tokenStore: createTokenStore({ stateRoot: serverRoot, protector: sealer }),
        dispatcher: scopedDispatcher, machineName, os: reportedOs, version, events, ...updateHooks(serverOrigin),
        stateProvider: () => ({ paused: effectiveGrants.isPaused(), folders: effectiveGrants.list().map(g => ({ label: g.label, path: g.path })) }),
        onStatus: () => writeIndicator(),
        ...(fetchImpl ? { fetchImpl } : {}), ...(WebSocketImpl ? { WebSocketImpl } : {}), ...(keepaliveMs ? { keepaliveMs } : {}), ...(askRetryMs ? { askRetryMs } : {}),
      });
      ownGrants.onChange(() => { writeIndicator(); scopedConnection.publishState(); });
      return { connection: scopedConnection, grants: ownGrants, effectiveGrants, dispatcher: scopedDispatcher };
    },
  });
  function status() {
    const current = servers.list();
    if (current.some(server => server.status === 'connected')) return 'connected';
    return connection ? connection.status() : current[0]?.status || 'unpaired';
  }
  // The three states the tray shows (green, grey, red).
  function indicatorState() {
    if (status() === 'connected') return grants.isPaused() ? 'paused' : 'connected';
    return 'offline';
  }
  let indicatorTimer = null;
  function writeIndicator(forced) {
    try { writeJsonAtomic(path.join(stateRoot, INDICATOR_FILE), { state: forced || indicatorState() }); } catch { /* the tray treats a stale file as offline */ }
  }
  grants.onChange(() => { writeIndicator(); servers.publishState(); });

  const connectionState = {
    getState() {
      const s = status();
      if (s === 'unpaired') return 'unpaired';
      if (s === 'disconnected') return 'disconnected';
      if (s === 'asking' || s === 'denied' || s === 'expired') return s;
      if (s === 'replaced') return 'replaced';
      return s === 'connected' ? (grants.isPaused() ? 'paused' : 'connected') : 'offline';
    },
    // `pair(code)` uses the address this copy already knows; `pair(code, { origin })` comes from a connection link
    // and carries the customer's NLC address, which is remembered once the code worked.
    async pair(code, options) {
      const target = options?.origin || connection?.diagnostics().origin || originUrl;
      if (!target) throw Object.assign(new Error(NO_ORIGIN_MESSAGE), { code: 'NO_ORIGIN' });
      if (!connection && servers.list().length === 0) {
        const initial = buildConnection(target);
        const result = await initial.pair(code);
        connection = initial;
        servers.adopt(target, { connection, grants, dispatcher });
        fs.writeFileSync(path.join(stateRoot, ORIGIN_FILE), target + '\n', { encoding: 'utf8', mode: 0o600 });
        writeIndicator();
        return result;
      }
      return servers.pair(target, code);
    },
    // Ask the NLC named in this download to link this computer; the owner presses Allow in NLC Central.
    async requestLink() {
      if (!connection) throw Object.assign(new Error(NO_ORIGIN_MESSAGE), { code: 'NO_ORIGIN' });
      return connection.requestLink();
    },
    onChange() {},
  };
  const logReader = { tools: { log_recent: async (args, call) => {
    const instance = host.instances().find((i) => i && i.tools && i.tools.log_recent);
    return instance ? instance.tools.log_recent(args, call) : { entries: [] };
  } } };
  // Test hook for the install proof on a build machine, where nobody can click a folder dialog: only honoured when CI=true.
  const testFolder = env && env.CI === 'true' ? String(env.NLC_NODE_TEST_PICK_FOLDER || '') : '';
  const defaultAddFolder = testFolder
    ? async () => ({ status: 'added', grant: await grants.add(testFolder) })
    : async () => require('./picker.cjs').pickAndShare({ grants, platform });
  const win = createWindow({ grants, actionLog: logReader, connectionState, machineName, addFolder: addFolder || defaultAddFolder });

  // The window is served at "/" for the tray; the local key rides inside the page, never in an address.
  function windowPage(url) {
    const pathname = String(url).split('?')[0].split('#')[0];
    if (pathname !== '/') return win.windowPage(url);
    const page = win.windowPage('/window');
    if (!page) return null;
    const key = ensurePrivateToken(stateRoot);
    return { type: page.type, body: page.body.replace('</head>', `<meta name="nlc-key" content="${key}">\n</head>`) };
  }


  async function windowApi(method, url, body) {
    if (!url.startsWith('/v1/window/servers')) return win.windowApi(method, url, body);
    try {
      if (method === 'GET' && url === '/v1/window/servers') return { json: { servers: servers.list() } };
      if (method !== 'POST') return { status: 405, json: { error: 'Use the server actions returned by the server list.' } };
      if (url === '/v1/window/servers/pair') return { json: await servers.pair(body.origin, body.code) };
      if (url === '/v1/window/servers/grant') return { json: await servers.grant(body.origin, body.path) };
      if (url === '/v1/window/servers/revoke-grant') return { json: servers.revokeGrant(body.origin, body.label) };
      if (url === '/v1/window/servers/pause') return { json: { paused: servers.setPaused(body.origin, body.paused) } };
      if (url === '/v1/window/servers/disconnect') { await servers.disconnect(body.origin); return { json: { ok: true } }; }
      return { status: 404, json: { error: 'Choose pair, grant, revoke-grant, pause or disconnect.' } };
    } catch (error) { return { status: error.status || 400, json: { error: String(error.message || 'That server action could not be completed.') } }; }
  }

  const controller = createLaunchController({
    version, stateRoot, modules: descriptors, host, connector: central, windowPage, windowApi,
    ...(launchId ? { launchId } : {}), ...(healthCheckIntervalMs ? { healthCheckIntervalMs } : {}),
  });

  return Object.freeze({
    grants, pathGuard, host, dispatcher, servers, get connection() { return connection; }, controller,
    async start() {
      const started = await controller.start();
      if (started.reused) return started;
      writeIndicator();
      indicatorTimer = setInterval(() => writeIndicator(), indicatorEveryMs);
      if (indicatorTimer.unref) indicatorTimer.unref();
      await servers.start();
      return started;
    },
    async stop() {
      if (indicatorTimer) clearInterval(indicatorTimer);
      indicatorTimer = null;
      await servers.stop();
      writeIndicator('offline');
      return controller.stop();
    },
    localEndpoint: () => controller.localEndpoint(),
    readyState: () => controller.readyState(),
    status,
  });
}

module.exports = { createNodeApp, INDICATOR_FILE, ORIGIN_FILE, NO_ORIGIN_MESSAGE };
