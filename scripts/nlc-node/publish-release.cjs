'use strict';

const crypto = require('node:crypto');
const { verifyReleaseManifest } = require('./generate-release-manifest.cjs');

function protectedReleaseCredential(environment = process.env) {
  const credential = environment.NLC_NODE_RELEASE_CREDENTIAL;
  if (typeof credential !== 'string' || credential.trim().length < 32) {
    throw new Error('NLC Node release activation requires a protected NLC_NODE_RELEASE_CREDENTIAL.');
  }
  return true;
}

// After a release is published, the public NLC Node repository is rebuilt from that release's own source and handed to the
// protected public-source adapter (see public-source-github.cjs), so github.com/getnlc/nlc-node always matches the newest release.
// A refresh that fails never undoes the release: it is reported in the result so the caller sees the repository is stale.
async function refreshPublicSource({ publicSource, manifest }) {
  const { sourceRoot, adapterProvider, downloads, sourceUrl } = publicSource;
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { buildPublicRepo } = require('./build-public-repo.cjs');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-public-')), 'repo');
  try {
    if (typeof adapterProvider !== 'function') throw new Error('no protected public-source adapter is configured');
    const adapter = await adapterProvider();
    if (!adapter || typeof adapter.push !== 'function') throw new Error('the public-source adapter is unavailable');
    const built = buildPublicRepo({ root: sourceRoot, out, downloads, sourceUrl, version: manifest?.version });
    const pushed = await adapter.push({ directory: out, version: manifest?.version || '', files: built.files.length });
    return { ok: true, files: built.files.length, ...(pushed && typeof pushed === 'object' ? pushed : {}) };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 500) };
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

async function publishVerifiedRelease({ manifest, sourceArtifactDirectory, authorityProvider, publicSource }) {
  verifyReleaseManifest({ manifest, artifactDirectory: sourceArtifactDirectory });
  if (typeof authorityProvider !== 'function') {
    throw new Error('NLC Node publishing requires a protected release authority adapter.');
  }
  const authority = await authorityProvider();
  if (!authority || typeof authority.stage !== 'function' || typeof authority.readStagedArtifact !== 'function' || typeof authority.publish !== 'function') {
    throw new Error('NLC Node release authority is unavailable.');
  }
  const staged = await authority.stage({ manifest, sourceArtifactDirectory });
  if (!staged || typeof staged.id !== 'string' || staged.id.length === 0 || staged.immutable !== true) {
    throw new Error('NLC Node publisher refused a mutable or unidentifiable staged release.');
  }
  for (const artifact of manifest.artifacts) {
    const contents = await authority.readStagedArtifact({ staged, artifact });
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents || '');
    const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== artifact.size || actualSha256 !== artifact.sha256) {
      throw new Error(`NLC Node staged artifact does not match its manifest: ${artifact.filename}.`);
    }
  }
  const published = await authority.publish({ manifest, staged });
  if (!publicSource) return published;
  const refreshed = await refreshPublicSource({ publicSource, manifest });
  return { ...(published && typeof published === 'object' ? published : { published }), publicSource: refreshed };
}

if (require.main === module) {
  try {
    protectedReleaseCredential();
    throw new Error('NLC Node release activation must use a configured protected publisher adapter, not an ad hoc command.');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { protectedReleaseCredential, publishVerifiedRelease, refreshPublicSource };
