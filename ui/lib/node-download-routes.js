import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { configuredOrigin, requestOrigin } from './node-origin.js';
import { registerNodeLinkPageRoutes } from './node-link-page.js';
import { createArtifactSource } from './node-artifact-source.js';
import { createNodeUpdateNoticeResolver } from './node-update-notice.js';

// GET /downloads/nlc-node: hands the customer the NLC Node installer for their computer.
// No sign-in is needed (the installer holds nothing private). Only three fixed files can ever be served, picked from a
// fixed list, never from the request text. Windows gets a zip that also carries the customer's NLC address.

const HERE = dirname(fileURLToPath(import.meta.url));
// The file names come from one shared list that the builds read too, so the route serves what CI produces.
const NAMES = createRequire(import.meta.url)('../../lib/nlc-node/artifact-names.cjs');
export const DEFAULT_ARTIFACT_DIR = join(HERE, '..', '..', 'data', 'nlc-node-artifacts');

export const ARTIFACTS = Object.freeze({
  win: { file: NAMES.SETUP_EXE, zipName: 'NLC-Node-Windows.zip', type: 'application/zip' },
  'mac-arm64': { file: NAMES.DMG_NAMES['macos-arm64'], type: 'application/x-apple-diskimage' },
  'mac-x64': { file: NAMES.DMG_NAMES['macos-x64'], type: 'application/x-apple-diskimage' },
});

const WIN_WORDS = new Set(['win', 'windows', 'win32', 'win64', 'pc']);
const MAC_WORDS = new Set(['mac', 'macos', 'darwin', 'osx', 'apple']);
const ARM_WORDS = new Set(['mac-arm64', 'mac_arm64', 'macarm64', 'mac-arm', 'mac-apple', 'apple-silicon']);
const INTEL_WORDS = new Set(['mac-x64', 'mac_x64', 'macx64', 'mac-intel', 'intel']);

const PAGE_STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}a{color:#1a56db}';
function page(response, status, title, bodyHtml) {
  response.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style></head><body><h1>${title}</h1>${bodyHtml}</body></html>`);
}
const notReady = (response) => page(response, 503, 'NLC Node is being prepared', '<p>The download is not ready yet. Please try this link again in a little while.</p>');
const unknownComputer = (response) => page(response, 404, 'NLC Node works on Windows and Mac', '<p>Open this link on the Windows or Mac computer you want your assistant to use.</p>');

function chooseFromQuery(raw) {
  const text = String(Array.isArray(raw) ? raw[0] : raw ?? '').trim().toLowerCase();
  if (!text) return { kind: 'none' };
  if (text.length > 40) return { kind: 'unknown' };
  if (WIN_WORDS.has(text)) return { kind: 'win' };
  if (ARM_WORDS.has(text)) return { kind: 'mac-arm64' };
  if (INTEL_WORDS.has(text)) return { kind: 'mac-x64' };
  if (MAC_WORDS.has(text)) return { kind: 'mac' };
  return { kind: 'unknown' };
}

function chooseFromBrowser(userAgent) {
  const ua = String(userAgent || '');
  if (/iphone|ipad|ipod|android/i.test(ua)) return 'unknown';
  if (/windows/i.test(ua)) return 'win';
  if (/macintosh|mac os x/i.test(ua)) return 'mac';
  return 'unknown';
}

// ---- a small zip writer: two stored files, checksums known up front so the installer streams without a copy ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crcUpdate(crc, buffer) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const crcCache = new Map();
function fileChecksum(file, stat) {
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  if (crcCache.has(key)) return Promise.resolve(crcCache.get(key));
  return new Promise((resolve, reject) => {
    let crc = 0;
    createReadStream(file).on('data', (chunk) => { crc = crcUpdate(crc, chunk); })
      .on('error', reject)
      .on('end', () => { crcCache.clear(); crcCache.set(key, crc); resolve(crc); });
  });
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, day: day & 0xffff };
}
function localHeader(name, crc, size, stamp) {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30 + nameBytes.length);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(0, 8);
  header.writeUInt16LE(stamp.time, 10); header.writeUInt16LE(stamp.day, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(size, 18); header.writeUInt32LE(size, 22);
  header.writeUInt16LE(nameBytes.length, 26); header.writeUInt16LE(0, 28);
  nameBytes.copy(header, 30);
  return header;
}
function centralHeader(name, crc, size, offset, stamp) {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(46 + nameBytes.length);
  header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(0, 10);
  header.writeUInt16LE(stamp.time, 12); header.writeUInt16LE(stamp.day, 14);
  header.writeUInt32LE(crc, 16); header.writeUInt32LE(size, 20); header.writeUInt32LE(size, 24);
  header.writeUInt16LE(nameBytes.length, 28); header.writeUInt32LE(offset, 42);
  nameBytes.copy(header, 46);
  return header;
}

async function sendWindowsZip(response, installerPath, installerName, zipName, origin) {
  const stat = statSync(installerPath);
  if (stat.size >= 0xffffffff) return sendFile(response, installerPath, installerName, 'application/octet-stream');
  const crc = await fileChecksum(installerPath, stat);
  const note = Buffer.from(`${origin}\n`, 'utf8');
  const stamp = dosDateTime();
  const head1 = localHeader(installerName, crc, stat.size, stamp);
  const noteCrc = crcUpdate(0, note);
  const head2 = localHeader('origin.txt', noteCrc, note.length, stamp);
  const offset2 = head1.length + stat.size;
  const directory = Buffer.concat([centralHeader(installerName, crc, stat.size, 0, stamp), centralHeader('origin.txt', noteCrc, note.length, offset2 + 0, stamp)]);
  const dirOffset = offset2 + head2.length + note.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(dirOffset, 16);
  response.status(200).set({
    'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName}"`,
    'Content-Length': String(dirOffset + directory.length + end.length), 'Cache-Control': 'no-store',
  });
  response.write(head1);
  const stream = createReadStream(installerPath);
  // A computer that drops the connection part-way must not leave the installer file held open on this server.
  response.on('close', () => stream.destroy());
  stream.on('error', () => response.destroy());
  stream.on('end', () => { response.write(Buffer.concat([head2, note, directory, end])); response.end(); });
  stream.pipe(response, { end: false });
}

function sendFile(response, path, name, type) {
  const stat = statSync(path);
  response.status(200).set({
    'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`,
    'Content-Length': String(stat.size), 'Cache-Control': 'no-store',
  });
  const stream = createReadStream(path);
  // A computer that drops the connection part-way must not leave the file held open on this server.
  response.on('close', () => stream.destroy());
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

// ---- one-line installers: GET /downloads/nlc-node/install.sh (Mac) and install.ps1 (Windows), plus the payloads they download ----
// The script is written for each request with the customer's own NLC address inside it. Payload names come from a fixed
// list; nothing in the request ever becomes a file name.
const INSTALL_DIR = join(HERE, 'node-install');
export const PAYLOADS = Object.freeze({
  'mac-arm64.tar.gz': { file: NAMES.PAYLOAD_ROUTE_NAMES['mac-arm64.tar.gz'], type: 'application/gzip' },
  'mac-x64.tar.gz': { file: NAMES.PAYLOAD_ROUTE_NAMES['mac-x64.tar.gz'], type: 'application/gzip' },
  'win-x64.zip': { file: NAMES.PAYLOAD_ROUTE_NAMES['win-x64.zip'], type: 'application/zip' },
});
const SAFE_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

// The connection link the dashboard shows (https://<their NLC>/n/<CODE>); it rides inside the one-liner so the install pairs by itself.
export function cleanLink(value) {
  const text = String(Array.isArray(value) ? value[0] : value ?? '').trim();
  if (!text || text.length > 300) return '';
  let url;
  try { url = new URL(text); } catch { return ''; }
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return '';
  if (url.username || url.password || url.search || url.hash) return '';
  if (!/^\/n\/[A-Za-z0-9-]+\/?$/.test(url.pathname)) return '';
  const clean = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  return /^[A-Za-z0-9:/._-]+$/.test(clean) ? clean : '';
}

export function renderInstallScript(kind, origin, link = '') {
  if (!SAFE_ORIGIN.test(origin)) throw new Error('unsafe origin');
  const template = readFileSync(join(INSTALL_DIR, kind === 'ps1' ? 'install.ps1' : 'install.sh'), 'utf8');
  return template.split('__NLC_ORIGIN__').join(origin).split('__NLC_LINK__').join(cleanLink(link) || '');
}

export function registerNodeDownloadRoutes({ app, artifactDir, publicOrigin, env = {
  NLC_NODE_DOWNLOAD_SOURCE: '',
  ...process.env,
} } = {}) {
  if (!app) throw new Error('Node download routes need their app.');
  const folder = () => artifactDir || env.NLC_NODE_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR;
  // NLC_NODE_DOWNLOAD_SOURCE: a machine without the big installer files fetches the checksum files when the link page is read
  // and an installer itself on the first ask (node-artifact-source.js). Not set: everything below behaves as before.
  const source = createArtifactSource({ folder, env });
  const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
  const offered = (file) => isFile(join(folder(), file)) || (source.enabled() && isFile(join(folder(), `${file}.sha256`)));
  const have = (key) => offered(ARTIFACTS[key].file);
  const everyFile = [...Object.values(ARTIFACTS), ...Object.values(PAYLOADS)].map((spec) => spec.file);
  const checksumsFirst = async (files) => { if (source.enabled()) await Promise.all(files.map((file) => source.ensureSidecar(file))); };

  const payloadFile = (name) => PAYLOADS[name] ? join(folder(), PAYLOADS[name].file) : '';
  const hasPayload = (names) => names.some((name) => isFile(`${payloadFile(name)}.sha256`) && (isFile(payloadFile(name)) || source.enabled()));

  // The link page and its install.json show the payload checksums: bring those small files in first.
  app.use(['/node', '/node/llms.txt', '/node/install.json'], async (request, response, next) => { await checksumsFirst(everyFile); next(); });

  // The scripts are piped straight into a shell, so even a refusal is a short script that says what is going on.
  async function sendScript(request, response, kind) {
    const mac = kind === 'sh';
    await checksumsFirst(mac ? [PAYLOADS['mac-arm64.tar.gz'].file, PAYLOADS['mac-x64.tar.gz'].file] : [PAYLOADS['win-x64.zip'].file]);
    const ready = mac ? hasPayload(['mac-arm64.tar.gz', 'mac-x64.tar.gz']) : hasPayload(['win-x64.zip']);
    const say = 'NLC Node is being prepared. Please try this line again in a little while.';
    const text = (status, body) => response.status(status).set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).send(body);
    if (!ready) return text(503, mac ? `echo "${say}" >&2\nexit 1\n` : `Write-Host "${say}"\n`);
    const origin = configuredOrigin(publicOrigin, env) || requestOrigin(request);
    let body;
    try { body = renderInstallScript(kind, origin, request.query.link); } catch {
      return text(400, mac ? 'echo "NLC could not work out its own address. Open the install line from your NLC dashboard." >&2\nexit 1\n' : 'Write-Host "NLC could not work out its own address. Open the install line from your NLC dashboard."\n');
    }
    return text(200, body);
  }
  app.get('/downloads/nlc-node/install.sh', (request, response) => sendScript(request, response, 'sh'));
  app.get('/downloads/nlc-node/install.ps1', (request, response) => sendScript(request, response, 'ps1'));
  // The single link page for assistants and people: /node, /node/llms.txt, /node/install.json.
  registerNodeLinkPageRoutes({ app, folder, publicOrigin, env, cleanLink });
  app.get('/downloads/nlc-node/payload/:name', async (request, response) => {
    const raw = String(request.params.name || '');
    const isSha = raw.endsWith('.sha256');
    const name = isSha ? raw.slice(0, -'.sha256'.length) : raw;
    if (!Object.prototype.hasOwnProperty.call(PAYLOADS, name)) return unknownComputer(response);
    if (isSha) await checksumsFirst([PAYLOADS[name].file]); else await source.ensureFile(PAYLOADS[name].file);
    const path = payloadFile(name) + (isSha ? '.sha256' : '');
    if (!isFile(path)) return notReady(response);
    return sendFile(response, path, isSha ? `${PAYLOADS[name].file}.sha256` : PAYLOADS[name].file, isSha ? 'text/plain' : PAYLOADS[name].type);
  });

  app.get('/downloads/nlc-node', async (request, response) => {
    try {
      let { kind } = chooseFromQuery(request.query.os);
      if (kind === 'unknown') return unknownComputer(response);
      if (kind === 'none') kind = chooseFromBrowser(request.headers['user-agent']);
      if (kind === 'unknown') return unknownComputer(response);
      await checksumsFirst([ARTIFACTS[kind === 'mac' ? 'mac-arm64' : kind]?.file, ...(kind === 'mac' ? [ARTIFACTS['mac-x64'].file] : [])].filter(Boolean));
      if (kind === 'mac') {
        const arm = have('mac-arm64');
        const intel = have('mac-x64');
        if (arm && intel) {
          return page(response, 200, 'Download NLC Node for Mac',
            '<p>Which Mac do you have?</p><ul><li><a href="/downloads/nlc-node?os=mac-arm64">Mac with Apple chip (M1 or newer)</a></li><li><a href="/downloads/nlc-node?os=mac-x64">Mac with Intel chip</a></li></ul>');
        }
        kind = arm ? 'mac-arm64' : intel ? 'mac-x64' : 'mac-arm64';
      }
      if (!have(kind)) return notReady(response);
      const spec = ARTIFACTS[kind];
      if (!(await source.ensureFile(spec.file))) return notReady(response);
      const path = join(folder(), spec.file);
      if (kind === 'win') {
        const origin = configuredOrigin(publicOrigin, env) || requestOrigin(request);
        return await sendWindowsZip(response, path, spec.file, spec.zipName, origin);
      }
      return sendFile(response, path, spec.file, spec.type);
    } catch {
      if (!response.headersSent) notReady(response);
      else response.destroy();
    }
  });
  // The /node-ws line asks this when a computer signs in: is a different published build of its payload on offer?
  return { updateNotice: createNodeUpdateNoticeResolver({ payloads: PAYLOADS, folder, ensureSidecar: (file) => source.ensureSidecar(file) }) };
}
