'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureStateRoot } = require('./local-state.cjs');

const CREDENTIAL_FILENAME = 'node-credential.bin';

// The only secret the Node keeps: the machine token issued when the customer pairs this computer.
function normalizeCredential(value) {
  const credential = {
    origin: String(value?.origin || '').trim().replace(/\/+$/, ''),
    machineId: String(value?.machineId || ''),
    token: String(value?.token || ''),
    expiresAt: String(value?.expiresAt || ''),
  };
  if (!/^https?:\/\//.test(credential.origin) || !credential.machineId || !credential.token || !credential.expiresAt) {
    throw new Error('node_credential_invalid');
  }
  return credential;
}

function createCredentialStore({ stateRoot, protector } = {}) {
  if (!protector || typeof protector.protect !== 'function' || typeof protector.unprotect !== 'function') {
    throw new TypeError('credential protector is required');
  }
  const destination = path.join(ensureStateRoot(stateRoot), CREDENTIAL_FILENAME);

  return Object.freeze({
    async save(value) {
      const credential = normalizeCredential(value);
      const protectedBytes = Buffer.from(await protector.protect(Buffer.from(JSON.stringify(credential), 'utf8')));
      if (!protectedBytes.length) throw new Error('credential_protection_failed');
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, protectedBytes, { mode: 0o600, flag: 'wx' });
      try { fs.renameSync(temporary, destination); } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
      }
    },
    async load() {
      let protectedBytes;
      try { protectedBytes = fs.readFileSync(destination); } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
      const plain = Buffer.from(await protector.unprotect(protectedBytes));
      return normalizeCredential(JSON.parse(plain.toString('utf8')));
    },
    async clear() {
      try { fs.unlinkSync(destination); } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      if (typeof protector.clear === 'function') await protector.clear();
    },
    path: destination,
  });
}

module.exports = { CREDENTIAL_FILENAME, createCredentialStore, normalizeCredential };
