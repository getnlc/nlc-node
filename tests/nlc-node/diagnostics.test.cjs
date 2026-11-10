'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DIAGNOSTICS_REPORT_FILENAME,
  DIAGNOSTICS_SCHEMA_VERSION,
  REQUIRED_CHECK_IDS,
  collectDiagnostics,
  runDiagnostics,
  verifyDiagnosticsReport,
} = require('../../lib/nlc-node/index.cjs');
const { hasDiagnosticsArgument, run } = require('../../lib/nlc-node/runtime.cjs');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixtureInstallation(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-diagnostics-'));
  const stateRoot = path.join(root, 'state');
  const hostPath = path.join(root, 'NLC Node Host.exe');
  const launcherPath = path.join(root, 'NLC Node.exe');
  fs.writeFileSync(hostPath, 'host executable', 'utf8');
  fs.writeFileSync(launcherPath, 'launcher executable', 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    stateRoot,
    hostPath,
    launcherPath,
    artifactPaths: [
      { role: 'host', filePath: hostPath },
      { role: 'launcher', filePath: launcherPath },
    ],
  };
}

test('one diagnostic run exercises the module contract and emits a redacted, checksum-bound proof report', async (t) => {
  const fixture = fixtureInstallation(t);
  const result = await runDiagnostics({
    version: '1.2.3',
    stateRoot: fixture.stateRoot,
    artifactPaths: fixture.artifactPaths,
    proofId: '00000000-0000-4000-8000-000000000001',
    now: () => '2026-07-23T12:00:00.000Z',
    platform: 'win32',
    architecture: 'x64',
    nodeVersion: '22.22.3',
  });

  assert.equal(result.report.schemaVersion, DIAGNOSTICS_SCHEMA_VERSION);
  assert.equal(result.report.result, 'pass');
  assert.deepEqual(result.report.checks.map((check) => check.id), REQUIRED_CHECK_IDS);
  assert.equal(result.report.checks.every((check) => check.status === 'pass'), true);
  assert.equal(result.report.privacy.remoteAccessUsed, false);
  assert.equal(result.report.privacy.credentialsIncluded, false);
  assert.equal(result.report.privacy.localPathsIncluded, false);
  assert.equal(result.report.artifacts.find((artifact) => artifact.role === 'host').sha256, sha256(fixture.hostPath));
  assert.equal(result.report.artifacts.find((artifact) => artifact.role === 'launcher').sha256, sha256(fixture.launcherPath));
  assert.equal(result.reportPath, path.join(fixture.stateRoot, DIAGNOSTICS_REPORT_FILENAME));
  assert.equal(verifyDiagnosticsReport(result.report), true);

  const saved = JSON.parse(fs.readFileSync(result.reportPath, 'utf8'));
  assert.equal(verifyDiagnosticsReport(saved), true);
  const serialized = JSON.stringify(saved);
  assert.doesNotMatch(serialized, /Bearer|authorization|token/i);
  assert.doesNotMatch(serialized, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serialized, /127\.0\.0\.1:\d+/);
});

test('diagnostic report verification rejects changed evidence', async (t) => {
  const fixture = fixtureInstallation(t);
  const report = await collectDiagnostics({
    version: '1.2.3',
    artifactPaths: fixture.artifactPaths,
    proofId: '00000000-0000-4000-8000-000000000002',
    now: () => '2026-07-23T12:00:00.000Z',
  });
  assert.equal(verifyDiagnosticsReport(report), true);
  assert.throws(() => verifyDiagnosticsReport({ ...report, result: 'fail' }), /content hash does not match/);
  assert.throws(() => verifyDiagnosticsReport({
    ...report,
    checks: report.checks.map((check) => check.id === 'module-contract' ? { ...check, status: 'fail' } : check),
  }), /content hash does not match/);
});

test('a failed diagnostic check produces a redacted failure report instead of pretending to pass', async (t) => {
  const fixture = fixtureInstallation(t);
  const missingPath = path.join(fixture.root, 'missing.exe');
  const report = await collectDiagnostics({
    version: '1.2.3',
    artifactPaths: [
      { role: 'host', filePath: fixture.hostPath },
      { role: 'launcher', filePath: missingPath },
    ],
  });
  assert.equal(report.result, 'fail');
  assert.deepEqual(report.checks.at(-1), {
    id: 'installed-artifacts',
    status: 'fail',
    code: 'NLC_NODE_DIAGNOSTIC_CHECK_FAILED',
  });
  assert.doesNotMatch(JSON.stringify(report), new RegExp(missingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.throws(() => verifyDiagnosticsReport(report), /did not pass/);
});

test('the packaged runtime recognizes diagnostic mode and exits after writing its report', async (t) => {
  const fixture = fixtureInstallation(t);
  assert.equal(hasDiagnosticsArgument(['--diagnose']), true);
  assert.equal(hasDiagnosticsArgument([]), false);
  const result = await run({
    version: '1.2.3',
    stateRoot: fixture.stateRoot,
    argumentsList: ['--diagnose'],
    diagnosticsOptions: {
      artifactPaths: fixture.artifactPaths,
      proofId: '00000000-0000-4000-8000-000000000003',
      now: () => '2026-07-23T12:00:00.000Z',
    },
  });
  assert.equal(result.report.result, 'pass');
  assert.equal(fs.existsSync(path.join(fixture.stateRoot, DIAGNOSTICS_REPORT_FILENAME)), true);
  assert.equal(fs.existsSync(path.join(fixture.stateRoot, 'instance.lock')), false);
});
