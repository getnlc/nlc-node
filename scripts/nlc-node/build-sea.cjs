'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { writeBundle } = require('./bundle-core.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const releasePath = path.join(projectRoot, 'installer', 'nlc-node', 'release.json');
const seaConfigPath = path.join(projectRoot, 'installer', 'nlc-node', 'sea-config.json');
const packageLockPath = path.join(projectRoot, 'package-lock.json');
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function readRelease() {
  return JSON.parse(fs.readFileSync(releasePath, 'utf8'));
}

function platformTarget(platform, architecture) {
  const normalizedPlatform = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform;
  return `${normalizedPlatform}-${architecture}`;
}

function currentTarget() {
  return platformTarget(process.platform, process.arch);
}

function targetPlatform(target) {
  return String(target).split('-')[0];
}

function assertNativeTarget(target) {
  if (target !== currentTarget()) throw new Error(`NLC Node SEA must be built on its native target unless the matching Node binary is supplied with --node-binary. Requested ${target}; current ${currentTarget()}.`);
}

function assertBuildRuntime(release, nodeVersion = process.versions.node) {
  if (nodeVersion !== release.build.nodeVersion) {
    throw new Error(`NLC Node SEA requires Node ${release.build.nodeVersion}; current runtime is ${nodeVersion}.`);
  }
}

function assertPostjectInstall(release, { requireResolve = require.resolve } = {}) {
  const packageManifestPath = requireResolve('postject/package.json', { paths: [projectRoot] });
  const packageManifest = JSON.parse(fs.readFileSync(packageManifestPath, 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
  const locked = packageLock.packages && packageLock.packages['node_modules/postject'];
  if (!locked || locked.version !== release.build.postjectVersion || typeof locked.integrity !== 'string' || locked.integrity.length === 0) {
    throw new Error(`NLC Node SEA requires integrity-pinned postject ${release.build.postjectVersion}.`);
  }
  if (packageManifest.version !== release.build.postjectVersion) {
    throw new Error(`NLC Node SEA requires installed postject ${release.build.postjectVersion}.`);
  }
  const configuredBin = typeof packageManifest.bin === 'string' ? packageManifest.bin : packageManifest.bin && packageManifest.bin.postject;
  if (typeof configuredBin !== 'string' || configuredBin.length === 0) {
    throw new Error('NLC Node SEA postject package has no executable entrypoint.');
  }
  const packageRoot = path.dirname(packageManifestPath);
  const executablePath = path.resolve(packageRoot, configuredBin);
  const relativeExecutable = path.relative(packageRoot, executablePath);
  if (relativeExecutable.startsWith('..') || path.isAbsolute(relativeExecutable)) {
    throw new Error('NLC Node SEA postject entrypoint escapes its integrity-pinned package.');
  }
  fs.accessSync(executablePath, fs.constants.R_OK);
  return executablePath;
}

function run(command, args) {
  return execFileSync(command, args, { stdio: 'inherit', windowsHide: true });
}

function buildSea({
  target = currentTarget(),
  outputDir = path.join(projectRoot, 'dist', 'nlc-node'),
  updatePublicKey = process.env.NLC_NODE_UPDATE_PUBLIC_KEY_B64,
  nodeBinary = undefined,
} = {}) {
  if (nodeBinary) {
    try { fs.accessSync(nodeBinary, fs.constants.R_OK); }
    catch { throw new Error(`NLC Node SEA Node binary ${nodeBinary} cannot be used: it is missing or unreadable.`); }
  } else {
    assertNativeTarget(target);
  }
  const release = readRelease();
  assertBuildRuntime(release);
  const postjectCli = assertPostjectInstall(release);
  fs.mkdirSync(outputDir, { recursive: true });
  const bundlePath = path.join(outputDir, 'nlc-node.bundle.cjs');
  const blobPath = path.join(outputDir, 'nlc-node.sea.blob');
  const executableName = targetPlatform(target) === 'windows' ? 'NLC Node Host.exe' : 'NLC Node Host';
  const executablePath = path.join(outputDir, executableName);
  writeBundle({ outPath: bundlePath, updatePublicKey });
  const seaConfig = JSON.parse(fs.readFileSync(seaConfigPath, 'utf8'));
  seaConfig.main = bundlePath;
  seaConfig.output = blobPath;
  const generatedConfigPath = path.join(outputDir, 'sea-config.json');
  fs.writeFileSync(generatedConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`, 'utf8');
  run(process.execPath, ['--experimental-sea-config', generatedConfigPath]);
  fs.copyFileSync(nodeBinary || process.execPath, executablePath);
  if (targetPlatform(target) === 'macos' && process.platform === 'darwin') run('codesign', ['--remove-signature', executablePath]);
  const injectArgs = [executablePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', fuse];
  if (targetPlatform(target) === 'macos') injectArgs.push('--macho-segment-name', 'NODE_SEA');
  run(process.execPath, [postjectCli, ...injectArgs]);
  return Object.freeze({ executablePath, target, version: release.version, postjectVersion: release.build.postjectVersion });
}

if (require.main === module) {
  try {
    const targetIndex = process.argv.indexOf('--target');
    const outputIndex = process.argv.indexOf('--output-dir');
    const nodeBinaryIndex = process.argv.indexOf('--node-binary');
    const result = buildSea({
      target: targetIndex === -1 ? currentTarget() : process.argv[targetIndex + 1],
      outputDir: outputIndex === -1 ? undefined : path.resolve(process.argv[outputIndex + 1]),
      nodeBinary: nodeBinaryIndex === -1 ? undefined : path.resolve(process.argv[nodeBinaryIndex + 1]),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`NLC Node SEA build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertBuildRuntime, assertNativeTarget, assertPostjectInstall, buildSea, currentTarget, platformTarget, readRelease };
