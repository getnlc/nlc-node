'use strict';
// NLC pass: the short-lived proof Central gives the browser to hand to one machine.
// Ed25519 (JWT "EdDSA"). Central signs; machines hold only the public key.
// The algorithm is fixed here, never read from the token header, so "alg: none" and key-swap tricks cannot work.
const crypto = require('node:crypto');

const PASS_TTL_SECONDS = 300;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

function generateSigningKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicDer.toString('base64url'),
    kid: crypto.createHash('sha256').update(publicDer).digest('hex').slice(0, 12),
  };
}

function signPass({ privatePem, kid, machineId, accountId, email, purpose, now = Date.now(), ttlSeconds = PASS_TTL_SECONDS }) {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid };
  const payload = { iss: 'nlc-central', aud: machineId, sub: accountId, email, iat, exp: iat + ttlSeconds, jti: crypto.randomBytes(16).toString('base64url'), ...(purpose ? { purpose: String(purpose) } : {}) };
  const body = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privatePem));
  return `${body}.${b64u(sig)}`;
}

// Returns { ok:true, payload } or { ok:false, reason } where reason is one of:
// 'malformed' | 'signature' | 'expired' | 'audience' | 'issuer' | 'purpose'
function verifyPass(pass, { publicKey, machineId, purpose, now = Date.now(), skewSeconds = 30 }) {
  const parts = String(pass || '').split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: 'malformed' };
  let header; let payload;
  try {
    header = JSON.parse(fromB64u(parts[0]).toString('utf8'));
    payload = JSON.parse(fromB64u(parts[1]).toString('utf8'));
  } catch { return { ok: false, reason: 'malformed' }; }
  if (!header || header.alg !== 'EdDSA') return { ok: false, reason: 'signature' };
  let good = false;
  try {
    const key = crypto.createPublicKey({ key: fromB64u(publicKey), format: 'der', type: 'spki' });
    good = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64u(parts[2]));
  } catch { good = false; }
  if (!good) return { ok: false, reason: 'signature' };
  if (!payload || payload.iss !== 'nlc-central') return { ok: false, reason: 'issuer' };
  const t = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + skewSeconds < t || payload.iat - skewSeconds > t) return { ok: false, reason: 'expired' };
  if (payload.aud !== machineId) return { ok: false, reason: 'audience' };
  // A pass made for one purpose (for example asking for an NLC Node pairing code) works only for that purpose; a sign-in pass has none.
  if ((payload.purpose || '') !== (purpose || '')) return { ok: false, reason: 'purpose' };
  return { ok: true, payload };
}

module.exports = { generateSigningKey, signPass, verifyPass, PASS_TTL_SECONDS };
