import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyPass } = require('../../lib/nlc-pass.cjs');

// The signed requests NLC Central sends when its owner looks at the NLC Node page: "list the computers asking to link"
// and "allow or deny one". Central signs each for this NLC only (audience = this NLC's machine id) and for one purpose,
// so a sign-in pass cannot list or decide, and a listing pass cannot decide. Each works once and for a minute.
export const NODE_LIST_PURPOSE = 'node-list';
export const NODE_DECIDE_PURPOSE = 'node-decide';

const basePathOf = (cfg) => (cfg.centralPath == null ? '/account' : String(cfg.centralPath).replace(/\/+$/, ''));

export function createCentralPairPassChecker({ getConfig, stateDir, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const keyFile = path.join(stateDir, 'central-key.json');
  const usedFile = path.join(stateDir, 'central-node-pair-used.json');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJson = (f, v) => {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); fs.renameSync(tmp, f);
  };
  async function fetchKey(cfg) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetchImpl(`${cfg.centralUrl}${basePathOf(cfg)}/.well-known/nlc-keys`, { signal: controller.signal });
      if (!r.ok) return null;
      const k = await r.json();
      if (!k || !k.publicKey) return null;
      writeJson(keyFile, { kid: k.kid, publicKey: k.publicKey });
      return k.publicKey;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  // check(pass, purpose) -> { ok: true, payload } or { ok: false, status, message } in plain words.
  return async function check(pass, purpose) {
    const cfg = getConfig();
    if (!cfg || !cfg.centralUrl || !cfg.machineId) {
      return { ok: false, status: 404, message: 'This NLC is not linked to an NLC account, so NLC Central cannot ask it about computers.' };
    }
    const options = (publicKey) => ({ publicKey, machineId: cfg.machineId, now: now(), purpose });
    const known = (readJson(keyFile, {}) || {}).publicKey || '';
    let result = known ? verifyPass(pass, options(known)) : { ok: false, reason: 'signature' };
    if (!result.ok && result.reason === 'signature') { // the key may have rotated, or never been fetched
      const fresh = await fetchKey(cfg);
      if (fresh && fresh !== known) result = verifyPass(pass, options(fresh));
    }
    if (!result.ok) return { ok: false, status: 401, message: 'That request could not be confirmed. Reload the NLC Node page.' };
    const used = readJson(usedFile, {}); const t = now();
    for (const [k, exp] of Object.entries(used)) if (exp < t) delete used[k];
    if (used[result.payload.jti]) return { ok: false, status: 401, message: 'That request was already used. Reload the NLC Node page.' };
    used[result.payload.jti] = (result.payload.exp * 1000) + 60000;
    writeJson(usedFile, used);
    return { ok: true, payload: result.payload };
  };
}
