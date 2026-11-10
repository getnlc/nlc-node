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

async function publishVerifiedRelease({ manifest, sourceArtifactDirectory, authorityProvider }) {
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
  return authority.publish({ manifest, staged });
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

module.exports = { protectedReleaseCredential, publishVerifiedRelease };
