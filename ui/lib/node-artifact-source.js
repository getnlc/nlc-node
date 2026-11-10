import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Where a machine gets the NLC Node installers when it does not hold them itself.
// Set NLC_NODE_DOWNLOAD_SOURCE to the address of a folder that holds the installer files and their .sha256 files
// (the durable store on Master, or Central-served storage). Not set: the machine serves what is in its own artifact
// folder, exactly as before. Set: the small .sha256 files are fetched when the link page is read, and a big installer
// is fetched, checked against its .sha256 and kept only when a customer actually asks for it.
// File names always come from the route's fixed list, never from the request.

const SIDECAR_MAX_AGE_MS = 10 * 60 * 1000;
const RETRY_AFTER_FAIL_MS = 30 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;

export function cleanSource(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 300) return '';
  let url;
  try { url = new URL(text); } catch { return ''; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return '';
  if (url.username || url.password || url.search || url.hash) return '';
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function createArtifactSource({ folder, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const base = () => cleanSource(env.NLC_NODE_DOWNLOAD_SOURCE);
  const inflight = new Map();
  const failedAt = new Map();

  const readSha = (path) => {
    try { const word = readFileSync(path, 'utf8').trim().split(/\s+/)[0].toLowerCase(); return HEX64.test(word) ? word : ''; } catch { return ''; }
  };
  const remove = (path) => { try { unlinkSync(path); } catch { /* already gone */ } };
  const single = (key, work) => {
    if (!inflight.has(key)) inflight.set(key, work().catch(() => false).finally(() => inflight.delete(key)));
    return inflight.get(key);
  };

  // The small checksum file for one installer. A new checksum means a new build: the old big file is dropped.
  async function ensureSidecar(name) {
    const source = base();
    if (!source) return false;
    const sidecar = join(folder(), `${name}.sha256`);
    let fresh = false;
    try { fresh = now() - statSync(sidecar).mtimeMs < SIDECAR_MAX_AGE_MS; } catch { /* none yet */ }
    if (fresh) return true;
    if (now() - (failedAt.get(`s:${name}`) || 0) < RETRY_AFTER_FAIL_MS) return existsSync(sidecar);
    return single(`s:${name}`, async () => {
      try {
        const response = await fetchImpl(`${source}/${name}.sha256`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('no checksum');
        const word = (await response.text()).slice(0, 400).trim().split(/\s+/)[0].toLowerCase();
        if (!HEX64.test(word)) throw new Error('bad checksum');
        mkdirSync(folder(), { recursive: true });
        const before = readSha(sidecar);
        if (before && before !== word) remove(join(folder(), name));
        writeFileSync(sidecar, `${word}  ${name}\n`);
        return true;
      } catch { failedAt.set(`s:${name}`, now()); return existsSync(sidecar); }
    });
  }

  // The big installer itself, fetched on the first ask, checked against its checksum, then kept.
  async function ensureFile(name) {
    const source = base();
    const path = join(folder(), name);
    if (!source) return existsSync(path);
    if (!(await ensureSidecar(name))) return false;
    const expected = readSha(join(folder(), `${name}.sha256`));
    if (!expected) return false;
    try { if (statSync(path).isFile()) return true; } catch { /* fetch it */ }
    if (now() - (failedAt.get(`f:${name}`) || 0) < RETRY_AFTER_FAIL_MS) return false;
    return single(`f:${name}`, async () => {
      const part = `${path}.part`;
      try {
        const response = await fetchImpl(`${source}/${name}`, { signal: AbortSignal.timeout(10 * 60 * 1000) });
        if (!response.ok || !response.body) throw new Error('not available');
        mkdirSync(folder(), { recursive: true });
        const hash = createHash('sha256');
        const body = Readable.fromWeb(response.body);
        body.on('data', (chunk) => hash.update(chunk));
        await pipeline(body, createWriteStream(part));
        if (hash.digest('hex') !== expected) throw new Error('checksum mismatch');
        renameSync(part, path);
        return true;
      } catch { remove(part); failedAt.set(`f:${name}`, now()); return false; }
    });
  }

  return { base, ensureSidecar, ensureFile, enabled: () => Boolean(base()) };
}
