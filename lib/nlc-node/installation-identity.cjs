'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ensureStateRoot } = require('./local-state.cjs');

const PRIVATE_KEY_FILENAME = 'installation-private-key.pem';
const PUBLIC_KEY_FILENAME = 'installation-public-key.pem';

function keyPaths(stateRoot) {
  const root = ensureStateRoot(stateRoot);
  return Object.freeze({
    privateKey: path.join(root, PRIVATE_KEY_FILENAME),
    publicKey: path.join(root, PUBLIC_KEY_FILENAME),
  });
}

function loadOrCreatePrivateKey(destination) {
  try {
    return crypto.createPrivateKey(fs.readFileSync(destination, 'utf8'));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  const generated = crypto.generateKeyPairSync('ed25519');
  const pem = generated.privateKey.export({ type: 'pkcs8', format: 'pem' });
  try {
    fs.writeFileSync(destination, pem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return generated.privateKey;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    return crypto.createPrivateKey(fs.readFileSync(destination, 'utf8'));
  }
}

function createInstallationIdentity({ stateRoot } = {}) {
  const paths = keyPaths(stateRoot);
  const privateKey = loadOrCreatePrivateKey(paths.privateKey);
  const publicKey = crypto.createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(paths.publicKey, publicPem, { encoding: 'utf8', mode: 0o600 });
  const digest = crypto.createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');

  return Object.freeze({
    digest: () => digest,
    publicKeyPem: () => publicPem,
    sign: (payload) => crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url'),
  });
}

module.exports = { createInstallationIdentity, PRIVATE_KEY_FILENAME, PUBLIC_KEY_FILENAME };
