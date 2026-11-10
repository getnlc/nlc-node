'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { MODULE_API_VERSION, NODE_API_VERSION } = require('./identity.cjs');
const { resolveStateRoot, ensureStateRoot } = require('./local-state.cjs');
const { startLoopbackServer } = require('./loopback-server.cjs');
const { ModuleHost } = require('./module-host.cjs');

const DIAGNOSTICS_SCHEMA_VERSION = 'nlc-node.diagnostics/v1';
const DIAGNOSTICS_REPORT_FILENAME = 'NLC-Node-Diagnostics.json';
const REQUIRED_CHECK_IDS = Object.freeze([
  'identity',
  'module-contract',
  'module-health',
  'loopback-binding',
  'unauthenticated-rejection',
  'authenticated-identity',
  'authenticated-modules',
  'installed-artifacts',
  'controlled-shutdown',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function diagnosticsReportPath(stateRoot = resolveStateRoot()) {
  return path.join(stateRoot, DIAGNOSTICS_REPORT_FILENAME);
}

function defaultArtifactPaths(execPath = process.execPath) {
  const artifacts = [{ role: 'host', filePath: execPath }];
  const launcherPath = path.join(path.dirname(execPath), process.platform === 'win32' ? 'NLC Node.exe' : 'NLC Node');
  if (fs.existsSync(launcherPath)) artifacts.push({ role: 'launcher', filePath: launcherPath });
  return artifacts;
}

function artifactEvidence(artifactPaths) {
  if (!Array.isArray(artifactPaths) || artifactPaths.length < 2) {
    throw new Error('NLC Node diagnostics require the installed host and launcher.');
  }
  const roles = new Set();
  return artifactPaths.map(({ role, filePath }) => {
    if (typeof role !== 'string' || !/^[a-z][a-z-]{1,31}$/.test(role) || roles.has(role)) {
      throw new Error('NLC Node diagnostic artifact roles must be unique.');
    }
    roles.add(role);
    const bytes = fs.readFileSync(filePath);
    return Object.freeze({
      role,
      filename: path.basename(filePath),
      size: bytes.length,
      sha256: sha256(bytes),
    });
  });
}

function fixtureDescriptor(id, dependsOn, events) {
  return Object.freeze({
    manifest: Object.freeze({
      apiVersion: MODULE_API_VERSION,
      id,
      version: '1.0.0',
      dependsOn: Object.freeze([...dependsOn]),
    }),
    create() {
      return Object.freeze({
        start() { events.push(`start:${id}`); },
        health() { return Object.freeze({ state: 'ready' }); },
        stop() { events.push(`stop:${id}`); },
      });
    },
  });
}

function requestJson({ host, port, pathname, token = '' }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host,
      port,
      path: pathname,
      method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        try {
          resolve(Object.freeze({
            statusCode: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }));
        } catch {
          reject(new Error('NLC Node diagnostic response was not valid JSON.'));
        }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('NLC Node diagnostic request timed out.')));
    request.once('error', reject);
    request.end();
  });
}

function makeReport({ version, proofId, generatedAt, result, artifacts, checks, platform, architecture, nodeVersion }) {
  const body = {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    proofId,
    generatedAt,
    result,
    product: Object.freeze({ id: 'nlc-node', apiVersion: NODE_API_VERSION, version }),
    environment: Object.freeze({ platform, architecture, nodeVersion }),
    artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze({ ...artifact }))),
    checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
    privacy: Object.freeze({
      remoteAccessUsed: false,
      credentialsIncluded: false,
      localPathsIncluded: false,
    }),
  };
  return Object.freeze({ ...body, contentSha256: sha256(JSON.stringify(body)) });
}

function writeDiagnosticsReport(report, stateRoot = resolveStateRoot()) {
  const destination = diagnosticsReportPath(ensureStateRoot(stateRoot));
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.rmSync(destination, { force: true });
  fs.renameSync(temporary, destination);
  return destination;
}

function verifyDiagnosticsReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('NLC Node diagnostic report must be an object.');
  }
  if (report.schemaVersion !== DIAGNOSTICS_SCHEMA_VERSION) {
    throw new Error('NLC Node diagnostic report schema is invalid.');
  }
  const { contentSha256, ...body } = report;
  if (typeof contentSha256 !== 'string' || contentSha256 !== sha256(JSON.stringify(body))) {
    throw new Error('NLC Node diagnostic report content hash does not match.');
  }
  if (report.result !== 'pass') throw new Error('NLC Node diagnostics did not pass.');
  if (!Array.isArray(report.checks)) throw new Error('NLC Node diagnostic checks are missing.');
  const checks = new Map(report.checks.map((check) => [check.id, check.status]));
  for (const id of REQUIRED_CHECK_IDS) {
    if (checks.get(id) !== 'pass') throw new Error(`NLC Node diagnostic check did not pass: ${id}`);
  }
  const serialized = JSON.stringify(report);
  if (/Bearer|authorization|["']token["']|[A-Za-z]:\\Users\\|\/Users\/|\/home\//i.test(serialized)) {
    throw new Error('NLC Node diagnostic report contains private connection data or local paths.');
  }
  return true;
}

async function collectDiagnostics({
  version,
  artifactPaths = defaultArtifactPaths(),
  proofId = crypto.randomUUID(),
  now = () => new Date().toISOString(),
  platform = process.platform,
  architecture = process.arch,
  nodeVersion = process.versions.node,
} = {}) {
  const checks = [];
  const events = [];
  const token = crypto.randomBytes(32).toString('base64url');
  let artifacts = [];
  let failed = false;
  let host = null;
  let server = null;

  async function check(id, operation) {
    if (failed) return;
    try {
      await operation();
      checks.push(Object.freeze({ id, status: 'pass' }));
    } catch {
      failed = true;
      checks.push(Object.freeze({ id, status: 'fail', code: 'NLC_NODE_DIAGNOSTIC_CHECK_FAILED' }));
    }
  }

  try {
    await check('identity', async () => {
      host = new ModuleHost({ version });
      const identity = host.identity();
      if (identity.id !== 'nlc-node' || identity.apiVersion !== NODE_API_VERSION || identity.version !== version) {
        throw new Error('identity mismatch');
      }
    });
    await check('module-contract', async () => {
      await host.register(fixtureDescriptor('diagnostics-foundation', [], events));
      await host.register(fixtureDescriptor('diagnostics-extension', ['diagnostics-foundation'], events));
      await host.start();
      const snapshot = host.snapshot();
      if (snapshot.lifecycle !== 'running' || snapshot.modules.some((module) => module.lifecycle !== 'ready')) {
        throw new Error('module lifecycle mismatch');
      }
      if (events.join(',') !== 'start:diagnostics-foundation,start:diagnostics-extension') {
        throw new Error('module startup order mismatch');
      }
    });
    await check('module-health', async () => {
      const health = await host.health();
      if (health.lifecycle !== 'running' || health.modules.some((module) => module.lifecycle !== 'ready' || module.health.state !== 'ready')) {
        throw new Error('module health mismatch');
      }
    });
    await check('loopback-binding', async () => {
      server = await startLoopbackServer({
        host: '127.0.0.1',
        port: 0,
        token,
        getIdentity: () => host.identity(),
        getModules: () => host.snapshot().modules,
        getReadiness: () => ({ state: host.lifecycle === 'running' ? 'ready' : 'not-ready' }),
      });
      if (server.host !== '127.0.0.1') throw new Error('non-loopback binding');
      const health = await requestJson({ host: server.host, port: server.port, pathname: '/health' });
      if (health.statusCode !== 200 || health.body.state !== 'ready') throw new Error('health response mismatch');
    });
    await check('unauthenticated-rejection', async () => {
      const response = await requestJson({ host: server.host, port: server.port, pathname: '/v1/modules' });
      if (response.statusCode !== 401 || response.body.error !== 'unauthorized' || response.body.modules !== undefined) {
        throw new Error('unauthenticated module data exposure');
      }
    });
    await check('authenticated-identity', async () => {
      const response = await requestJson({ host: server.host, port: server.port, pathname: '/v1/identity', token });
      if (response.statusCode !== 200 || response.body.id !== 'nlc-node' || response.body.version !== version) {
        throw new Error('authenticated identity mismatch');
      }
    });
    await check('authenticated-modules', async () => {
      const response = await requestJson({ host: server.host, port: server.port, pathname: '/v1/modules', token });
      const ids = Array.isArray(response.body.modules) ? response.body.modules.map((module) => module.id) : [];
      if (response.statusCode !== 200 || ids.join(',') !== 'diagnostics-foundation,diagnostics-extension') {
        throw new Error('authenticated module response mismatch');
      }
    });
    await check('installed-artifacts', async () => {
      artifacts = artifactEvidence(artifactPaths);
      if (!artifacts.some((artifact) => artifact.role === 'host') || !artifacts.some((artifact) => artifact.role === 'launcher')) {
        throw new Error('installed artifact evidence is incomplete');
      }
    });
    await check('controlled-shutdown', async () => {
      await server.close();
      server = null;
      await host.stop();
      if (host.lifecycle !== 'stopped') throw new Error('host did not stop');
      if (events.join(',') !== 'start:diagnostics-foundation,start:diagnostics-extension,stop:diagnostics-extension,stop:diagnostics-foundation') {
        throw new Error('module shutdown order mismatch');
      }
    });
  } finally {
    if (server) await server.close().catch(() => {});
    if (host && host.lifecycle !== 'stopped') await host.stop().catch(() => {});
  }

  return makeReport({
    version,
    proofId,
    generatedAt: now(),
    result: failed ? 'fail' : 'pass',
    artifacts,
    checks,
    platform,
    architecture,
    nodeVersion,
  });
}

async function runDiagnostics(options = {}) {
  const stateRoot = options.stateRoot || resolveStateRoot();
  const report = await collectDiagnostics(options);
  const reportPath = writeDiagnosticsReport(report, stateRoot);
  if (report.result !== 'pass') {
    const error = new Error('NLC Node diagnostics failed.');
    error.code = 'NLC_NODE_DIAGNOSTICS_FAILED';
    error.reportPath = reportPath;
    throw error;
  }
  return Object.freeze({ report, reportPath });
}

module.exports = {
  DIAGNOSTICS_REPORT_FILENAME,
  DIAGNOSTICS_SCHEMA_VERSION,
  REQUIRED_CHECK_IDS,
  collectDiagnostics,
  defaultArtifactPaths,
  diagnosticsReportPath,
  runDiagnostics,
  verifyDiagnosticsReport,
  writeDiagnosticsReport,
};
