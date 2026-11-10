'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function bad(message) { return Object.assign(new Error(message), { status: 400, code: 'BAD_ARGUMENT' }); }
function serverOrigin(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw bad('Use the HTTPS address of your NLC server.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password) throw bad('Use the HTTPS address of your NLC server, without sign-in details.');
  return url.origin;
}
function serverKey(origin) { return crypto.createHash('sha256').update(serverOrigin(origin)).digest('hex').slice(0, 24); }

function createServerPairings({ stateRoot, legacyEntry = null, createEntry }) {
  const file = path.join(stateRoot, 'servers.json');
  const entries = new Map(), pending = new Map(), retained = new Set();
  let running = false, registryError = false;
  if (legacyEntry) { const origin = serverOrigin(legacyEntry.origin); entries.set(origin, { ...legacyEntry, origin }); retained.add(origin); }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.servers)) throw Error('invalid');
    for (const record of data.servers) retained.add(serverOrigin(record.origin));
  } catch (error) { if (error.code !== 'ENOENT') registryError = true; }

  function persist() {
    if (registryError) throw bad('The saved NLC server list could not be read. Restore that list before changing pairings.');
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, servers: [...retained].map(origin => ({ origin })) }) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  async function ensure(origin) {
    if (entries.has(origin)) return entries.get(origin);
    if (pending.has(origin)) return pending.get(origin);
    const task = Promise.resolve().then(() => createEntry(origin, path.join(stateRoot, 'servers', serverKey(origin))))
      .then(entry => { entries.set(origin, { ...entry, origin }); return entries.get(origin); })
      .finally(() => pending.delete(origin));
    pending.set(origin, task);
    return task;
  }
  function known(value) {
    const origin = serverOrigin(value);
    if (!retained.has(origin) || !entries.has(origin)) throw bad('Choose one of the paired NLC servers returned by the server list.');
    return entries.get(origin);
  }
  return Object.freeze({
    async start() { running = true; for (const origin of retained) { const entry = await ensure(origin); await entry.connection.start(); } },
    async stop() { running = false; await Promise.all([...entries.values()].map(entry => entry.connection.stop())); },
    adopt(value, entry) {
      const origin = serverOrigin(value);
      if (entries.has(origin) && entries.get(origin).connection !== entry.connection) throw bad('That server is already paired. Use its existing connection.');
      entries.set(origin, { ...entry, origin }); retained.add(origin); persist();
    },
    async pair(value, code) {
      if (!running) throw bad('Start NLC Node before pairing a server.');
      if (registryError) throw bad('The saved NLC server list could not be read. Restore that list before changing pairings.');
      const origin = serverOrigin(value);
      const entry = await ensure(origin);
      // The server's existing one-time-code exchange authenticates that it is an NLC server.
      const result = await entry.connection.pair(code);
      retained.add(origin); persist();
      return { origin, ...result };
    },
    async grant(origin, folderPath) { return known(origin).grants.add(folderPath); },
    revokeGrant(origin, label) { return known(origin).grants.remove(label); },
    setPaused(origin, paused) {
      if (typeof paused !== 'boolean') throw bad('Choose paused true or false.');
      return known(origin).grants.setPaused(paused);
    },
    async disconnect(origin) { await known(origin).connection.disconnect(); },
    publishState() { for (const entry of entries.values()) entry.connection.publishState(); },
    list() { return [...retained].map(origin => {
      const entry = entries.get(origin);
      const grants = entry?.effectiveGrants || entry?.grants;
      return { origin, status: entry?.connection.status() || 'offline', paused: grants?.isPaused() || false, folders: grants?.list().map(grant => ({ label: grant.label, path: grant.path })) || [] };
    }); },
  });
}
module.exports = { createServerPairings, serverOrigin, serverKey };
