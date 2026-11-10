'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_SCHEMA = 'nlc-node.release/v1';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyArtifactChecksum({ filePath, sha256: expectedSha256 }) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`NLC Node artifact is missing: ${filePath || '(unspecified)'}.`);
  const actualSha256 = sha256(filePath);
  if (actualSha256 !== expectedSha256) throw new Error(`NLC Node artifact checksum does not match: ${path.basename(filePath)}.`);
  return true;
}

function normalizeArtifact({ filePath, platform, architecture, version, url, verified }) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`NLC Node artifact is missing: ${filePath || '(unspecified)'}.`);
  if (!platform || !architecture || !version || !url || !/^https:\/\//.test(url)) {
    throw new Error('NLC Node artifact requires platform, architecture, version, and an HTTPS official URL.');
  }
  if (verified !== true) throw new Error(`NLC Node artifact ${path.basename(filePath)} has no verified evidence.`);
  const stat = fs.statSync(filePath);
  return Object.freeze({
    platform,
    architecture,
    version,
    filename: path.basename(filePath),
    size: stat.size,
    sha256: sha256(filePath),
    url,
  });
}

function assertSafeFilename(filename) {
  if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) || path.basename(filename) !== filename) {
    throw new Error('NLC Node release manifest artifact filename is invalid.');
  }
}

function assertReleaseManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA || typeof manifest.version !== 'string' || manifest.version.length === 0 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('NLC Node release manifest is invalid.');
  }
  const identities = new Set();
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact.platform !== 'string' || typeof artifact.architecture !== 'string' || artifact.version !== manifest.version || typeof artifact.url !== 'string' || !/^https:\/\/[^/\s]+/i.test(artifact.url) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error('NLC Node release manifest artifact is invalid.');
    }
    assertSafeFilename(artifact.filename);
    const identity = `${artifact.platform}/${artifact.architecture}`;
    if (identities.has(identity)) throw new Error('NLC Node release manifest has duplicate platform artifacts.');
    identities.add(identity);
  }
  return manifest;
}

function generateReleaseManifest({ version, artifacts }) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('NLC Node release manifest needs verified artifacts.');
  const normalized = artifacts.map(normalizeArtifact);
  if (normalized.some((artifact) => artifact.version !== version)) throw new Error('NLC Node artifact versions must match the release version.');
  const identities = normalized.map((artifact) => `${artifact.platform}/${artifact.architecture}`);
  if (new Set(identities).size !== identities.length) throw new Error('NLC Node release manifest has duplicate platform artifacts.');
  assertReleaseManifest({ schemaVersion: MANIFEST_SCHEMA, version, artifacts: normalized });
  return Object.freeze({ schemaVersion: MANIFEST_SCHEMA, version, artifacts: normalized });
}

function writeReleaseManifest({ outputPath, ...input }) {
  const manifest = generateReleaseManifest(input);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function verifyReleaseManifest({ manifest, artifactDirectory }) {
  assertReleaseManifest(manifest);
  if (typeof artifactDirectory !== 'string' || artifactDirectory.length === 0 || !fs.statSync(artifactDirectory).isDirectory()) {
    throw new Error('NLC Node artifact directory is invalid.');
  }
  const resolvedDirectory = path.resolve(artifactDirectory);
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.resolve(resolvedDirectory, artifact.filename);
    if (path.dirname(artifactPath) !== resolvedDirectory) throw new Error('NLC Node release manifest artifact path escapes its directory.');
    const stat = fs.statSync(artifactPath);
    if (!stat.isFile() || stat.size !== artifact.size) throw new Error(`NLC Node artifact size does not match: ${artifact.filename}.`);
    verifyArtifactChecksum({ filePath: artifactPath, sha256: artifact.sha256 });
  }
  return true;
}

module.exports = { assertReleaseManifest, generateReleaseManifest, normalizeArtifact, sha256, verifyArtifactChecksum, verifyReleaseManifest, writeReleaseManifest };
