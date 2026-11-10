'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { renderBundle } = require('../../scripts/nlc-node/bundle-core.cjs');
const { generateReleaseManifest, verifyReleaseManifest, writeReleaseManifest } = require('../../scripts/nlc-node/generate-release-manifest.cjs');
const { protectedReleaseCredential, publishVerifiedRelease } = require('../../scripts/nlc-node/publish-release.cjs');
const { verifyBoundaries, verifyCandidatePaths } = require('../../scripts/nlc-node/verify-boundaries.cjs');
const { assertBuildRuntime, platformTarget, readRelease } = require('../../scripts/nlc-node/build-sea.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const updatePublicKey = crypto.generateKeyPairSync('ed25519').publicKey
  .export({ format: 'der', type: 'spki' }).toString('base64');

test('the SEA bundle includes the NLC Node runtime and all local dependencies', () => {
  const bundle = renderBundle({ updatePublicKey });
  assert.match(bundle, /__NLC_NODE_VERSION__ = "0\.1\.0"/);
  assert.match(bundle, /__nlcRequire\("runtime\.cjs"\)/);
  assert.match(bundle, /__nlcEntry\.run\(\)/);
  assert.match(bundle, /NLC Node could not start\.\\n/);
  assert.doesNotMatch(bundle, /NLC Node could not start: \$\{error\.message\}/);
  assert.match(bundle, /invocationShouldExit\(process\.argv\.slice\(2\)\)/);
  assert.match(bundle, /if \(__nlcExitAfterRun\) process\.exit\(process\.exitCode \|\| 0\)/);
  assert.match(bundle, /if \(__nlcExitAfterRun\) process\.exit\(1\)/);
  for (const module of ['diagnostics.cjs', 'launch-protocol.cjs', 'module-host.cjs', 'loopback-server.cjs', 'ready-state.cjs']) {
    assert.match(bundle, new RegExp(module.replace('.', '\\.')));
  }
});

test('release manifests contain only complete HTTPS artifacts with checksums', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-release-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const artifact = path.join(temp, 'NLC-Node-Setup-x64.exe');
  fs.writeFileSync(artifact, 'verified artifact', 'utf8');
  const manifest = generateReleaseManifest({
    version: '0.1.0',
    artifacts: [{ filePath: artifact, platform: 'windows', architecture: 'x64', version: '0.1.0', url: 'https://downloads.example.test/NLC-Node-Setup-x64.exe', verified: true }],
  });
  assert.equal(manifest.schemaVersion, 'nlc-node.release/v1');
  assert.equal(manifest.artifacts[0].filename, 'NLC-Node-Setup-x64.exe');
  assert.match(manifest.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyReleaseManifest({ manifest, artifactDirectory: temp }), true);
  assert.throws(() => verifyReleaseManifest({
    manifest: { ...manifest, artifacts: [{ ...manifest.artifacts[0], filename: '../outside.exe' }] },
    artifactDirectory: temp,
  }), /filename is invalid/);
  assert.throws(() => verifyReleaseManifest({
    manifest: { ...manifest, artifacts: [{ ...manifest.artifacts[0], size: manifest.artifacts[0].size + 1 }] },
    artifactDirectory: temp,
  }), /size does not match/);
  fs.writeFileSync(artifact, 'tampered artifact', 'utf8');
  assert.throws(() => verifyReleaseManifest({ manifest, artifactDirectory: temp }), /checksum does not match/);
  const outputPath = path.join(temp, 'release.json');
  writeReleaseManifest({ outputPath, version: '0.1.0', artifacts: [{ filePath: artifact, platform: 'windows', architecture: 'x64', version: '0.1.0', url: 'https://downloads.example.test/NLC-Node-Setup-x64.exe', verified: true }] });
  assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).version, '0.1.0');
  assert.throws(() => generateReleaseManifest({
    version: '0.1.0',
    artifacts: [
      { filePath: artifact, platform: 'windows', architecture: 'x64', version: '0.1.0', url: 'https://downloads.example.test/a.exe', verified: true },
      { filePath: artifact, platform: 'windows', architecture: 'x64', version: '0.1.0', url: 'https://downloads.example.test/b.exe', verified: true },
    ],
  }), /duplicate/);
});

test('SEA builds fail closed when the pinned Node runtime is not present', () => {
  const release = readRelease();
  assert.doesNotThrow(() => assertBuildRuntime(release, release.build.nodeVersion));
  assert.throws(() => assertBuildRuntime(release, '22.0.0'), /requires Node/);
  assert.equal(platformTarget('win32', 'x64'), 'windows-x64');
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const postjectLock = packageLock.packages['node_modules/postject'];
  assert.equal(packageJson.devDependencies.postject, release.build.postjectVersion);
  assert.equal(postjectLock.version, release.build.postjectVersion);
  assert.match(postjectLock.integrity, /^sha512-/);
  assert.match(read('scripts/nlc-node/build-sea.cjs'), /assertPostjectInstall/);
  assert.doesNotMatch(read('scripts/nlc-node/build-sea.cjs'), /NLC_NODE_POSTJECT_BIN/);
});

test('release activation fails closed without protected authority or verified staged assets', async () => {
  assert.throws(() => protectedReleaseCredential({}), /requires a protected/);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-publisher-'));
  const artifact = path.join(temp, 'artifact');
  fs.writeFileSync(artifact, 'verified artifact', 'utf8');
  const manifest = generateReleaseManifest({
    version: '0.1.0',
    artifacts: [{ filePath: artifact, platform: 'windows', architecture: 'x64', version: '0.1.0', url: 'https://downloads.example.test/artifact', verified: true }],
  });
  let published = false;
  await assert.rejects(publishVerifiedRelease({
    manifest,
    sourceArtifactDirectory: temp,
    authorityProvider: async () => ({
      stage: async () => ({ id: 'staged-release', immutable: true }),
      readStagedArtifact: async () => Buffer.from('altered artifact'),
      publish: async () => { published = true; },
    }),
  }), /does not match/);
  assert.equal(published, false);
  const result = await publishVerifiedRelease({
    manifest,
    sourceArtifactDirectory: temp,
    authorityProvider: async () => ({
      stage: async () => ({ id: 'immutable-release', immutable: true }),
      readStagedArtifact: async () => fs.readFileSync(artifact),
      publish: async () => ({ published: true }),
    }),
  });
  assert.deepEqual(result, { published: true });
  fs.rmSync(temp, { recursive: true, force: true });
});

test('the NLC Node contract documents the stable future-module boundary', () => {
  const contract = read('features/nlc-node/contract.md');
  assert.match(contract, /Later NLC capabilities attach through the NLC Node module contract/);
  assert.match(contract, /stable module contract/);
  assert.match(contract, /Phase 6 — Customer-installation diagnostics proof/);
  for (const criterion of ['SC-015', 'SC-016', 'SC-017', 'SC-018']) {
    assert.match(contract, new RegExp(criterion));
  }
  assert.doesNotMatch(read('lib/nlc-node/index.cjs'), /NLC Video|NLC Electron/);
});
