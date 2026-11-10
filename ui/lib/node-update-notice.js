import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// When a computer's NLC Node signs in on /node-ws, this says whether a different published build of its own payload is on
// offer. The build is named by the checksum of the payload this server publishes (the same .sha256 file the installers check),
// so "published build" is exactly what a fresh install from this server would put on the computer.

const HEX64 = /^[0-9a-f]{64}$/;

// Which payload a computer takes, from what it says about itself. A fixed list, never built from request text.
export function payloadNameFor({ platform, arch } = {}) {
  if (platform === 'win32' && (arch === 'x64' || !arch)) return 'win-x64.zip';
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64.tar.gz';
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64.tar.gz';
  return '';
}

export function createNodeUpdateNoticeResolver({ payloads, folder, ensureSidecar = null } = {}) {
  if (!payloads || typeof folder !== 'function') throw new Error('The update notice needs the payload list and the artifact folder.');
  return async function resolveNodeUpdateNotice(info = {}) {
    const name = payloadNameFor(info);
    const spec = name ? payloads[name] : null;
    if (!spec) return null;
    if (typeof ensureSidecar === 'function') await ensureSidecar(spec.file);
    let sha = '';
    try { sha = readFileSync(join(folder(), `${spec.file}.sha256`), 'utf8').trim().split(/\s+/)[0].toLowerCase(); } catch { return null; }
    if (!HEX64.test(sha)) return null;
    const installed = String(info.build || '').trim().toLowerCase();
    if (installed === sha) return null;
    return { payload: name, sha256: sha };
  };
}
