function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
}

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return '';
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end !== -1) ip = ip.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  return ip;
}

export function getForwardedClientIp(req) {
  const forwarded = firstHeaderValue(req?.headers?.['x-forwarded-for']);
  return normalizeIp(forwarded.split(',')[0]);
}

export function getSocketIp(req) {
  return normalizeIp(req?.socket?.remoteAddress || req?.connection?.remoteAddress || req?.ip || '');
}

export function getHostName(req) {
  const rawHost = firstHeaderValue(req?.headers?.host).trim().toLowerCase();
  if (!rawHost) return '';
  if (rawHost.startsWith('[')) {
    const end = rawHost.indexOf(']');
    return end === -1 ? rawHost : rawHost.slice(1, end);
  }
  return rawHost.split(':')[0];
}

function forwardedChain(req) {
  return firstHeaderValue(req?.headers?.['x-forwarded-for']).split(',').map(normalizeIp).filter(Boolean);
}

// The caller's real address. A client can put anything at the front of X-Forwarded-For, but the local proxy
// adds the address it actually saw at the END (and newer proxy settings replace the header with that address alone),
// so behind the local proxy the last entry is the real one. A connection that did not come through the local
// proxy has no trustworthy header at all: use the socket address.
export function getClientIp(req) {
  const peer = getSocketIp(req);
  if (peer && !isLoopbackIp(peer)) return peer;
  const chain = forwardedChain(req);
  return chain[chain.length - 1] || normalizeIp(req?.ip || '') || peer;
}

export function isLoopbackIp(value) {
  const ip = normalizeIp(value);
  if (!ip) return false;
  if (ip === '::1' || ip === 'localhost') return true;
  const mapped = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  return /^127(?:\.\d{1,3}){3}$/.test(mapped);
}

export function isLocalHostHeader(req) {
  const host = getHostName(req);
  return !host || host === 'localhost' || isLoopbackIp(host);
}

// True only for a caller on this machine: loopback socket, a loopback host name, and no sign that a proxy
// carried the request from anywhere else. Every entry of X-Forwarded-For (not just the first) and X-Real-IP
// must be loopback, so a forged "127.0.0.1" that a proxy extended with the real address is not believed.
export function isLocalRequest(req) {
  if (!isLoopbackIp(getSocketIp(req))) return false;
  if (!isLocalHostHeader(req)) return false;
  if (forwardedChain(req).some((ip) => !isLoopbackIp(ip))) return false;
  const realIp = normalizeIp(firstHeaderValue(req?.headers?.['x-real-ip']));
  return !realIp || isLoopbackIp(realIp);
}
