// The address the customer reaches their own NLC on, as the server sees it.
// A configured public address (NLC_PUBLIC_ORIGIN) wins; otherwise the address of the request, behind a proxy too.

export function normalizeOrigin(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function firstValue(header) {
  return String(Array.isArray(header) ? header[0] : header ?? '').split(',')[0].trim();
}

export function requestOrigin(request) {
  const headers = request.headers || {};
  const proto = firstValue(headers['x-forwarded-proto']).toLowerCase() || request.protocol || 'http';
  const host = firstValue(headers['x-forwarded-host']) || firstValue(headers.host);
  return host ? normalizeOrigin(`${proto}://${host}`) : '';
}

export function configuredOrigin(option, env = process.env) {
  const value = typeof option === 'function' ? option() : option;
  return normalizeOrigin(value || env.NLC_PUBLIC_ORIGIN || '');
}
