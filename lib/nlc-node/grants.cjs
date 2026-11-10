'use strict';
// Grants store (CONTRACT 1.3): the folders the customer has shared, plus the pause switch.
// Persisted to grants.json in the Node state folder with an atomic write.
const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { NodeError } = require('./errors.cjs');

const GRANTS_FILENAME = 'grants.json';
const FORBIDDEN_MESSAGE = 'Choose a folder for your work, not a system location.';

function defaultFs() {
  return { realpath: promisify(fs.realpath.native), stat: fs.promises.stat };
}

// Locations the Node refuses to share. "exact" = only that folder itself; "within" = it and everything below it.
function forbiddenLocations({ platform, env, homeDir, api }) {
  const exact = [homeDir, api.dirname(homeDir)];
  const within = [];
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
    within.push(systemRoot, env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)');
    if (env.ProgramW6432) within.push(env.ProgramW6432);
  } else if (platform === 'darwin') {
    within.push('/System', '/Library', '/Applications', '/usr', '/bin', '/sbin');
    exact.push('/Users', '/Volumes', '/private', '/var', '/etc', '/home');
  } else {
    within.push('/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev');
    exact.push('/home', '/var', '/root');
  }
  return { exact, within };
}

function createGrants({
  stateDir, platform = process.platform, homeDir = os.homedir(), env = process.env, fsImpl = defaultFs(), fsApi = fs, protectedRoots = [],
} = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new TypeError('stateDir is required');
  const api = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const insensitive = platform === 'win32' || platform === 'darwin';
  const file = nodePath.join(stateDir, GRANTS_FILENAME);
  const listeners = new Set();
  let state = { grants: [], paused: false };

  function clean(value) {
    const normalized = api.normalize(String(value));
    const stripped = normalized.replace(/[\\/]+$/, '');
    return !stripped || /^[A-Za-z]:$/.test(stripped) ? normalized : stripped;
  }
  const key = (value) => (insensitive ? clean(value).toLowerCase() : clean(value));
  const isWithin = (root, target) => {
    const rel = api.relative(key(root), key(target));
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + api.sep) && !api.isAbsolute(rel));
  };

  function load() {
    try {
      const parsed = JSON.parse(fsApi.readFileSync(file, 'utf8'));
      const grants = (Array.isArray(parsed.grants) ? parsed.grants : [])
        .filter((g) => g && typeof g.label === 'string' && g.label && typeof g.path === 'string' && g.path)
        .map((g) => ({ label: g.label, path: g.path, addedAt: String(g.addedAt || ''), id: typeof g.id === 'string' ? g.id : '' }));
      state = { grants, paused: parsed.paused === true };
    } catch { state = { grants: [], paused: false }; }
  }

  // Write a temp file in the same folder, flush it to disk, then rename it over grants.json.
  function persist(next) {
    fsApi.mkdirSync(stateDir, { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const descriptor = fsApi.openSync(temporary, 'wx', 0o600);
    try {
      fsApi.writeFileSync(descriptor, JSON.stringify({ version: 1, paused: next.paused, grants: next.grants }, null, 2));
      fsApi.fsyncSync(descriptor);
    } catch (error) {
      try { fsApi.closeSync(descriptor); } catch {}
      try { fsApi.unlinkSync(temporary); } catch {}
      throw error;
    }
    fsApi.closeSync(descriptor);
    try { fsApi.renameSync(temporary, file); } catch (error) {
      try { fsApi.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function commit(next, change) {
    persist(next); // if this throws, nothing in memory has changed
    state = next;
    for (const listener of [...listeners]) {
      try { listener({ change, grants: snapshot(), paused: state.paused }); } catch {}
    }
  }

  const snapshot = () => state.grants.map((g) => ({ ...g }));

  function uniqueLabel(base) {
    const taken = new Set(state.grants.map((g) => g.label.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }

  function refuseIfForbidden(candidates) {
    const { exact, within } = forbiddenLocations({ platform, env, homeDir, api });
    const stateRoots = [stateDir, ...protectedRoots];
    for (const candidate of candidates) {
      if (key(api.parse(clean(candidate)).root) === key(candidate)) throw new NodeError('BAD_ARGUMENT', FORBIDDEN_MESSAGE);
      if (exact.some((item) => key(item) === key(candidate))) throw new NodeError('BAD_ARGUMENT', FORBIDDEN_MESSAGE);
      if (within.some((item) => isWithin(item, candidate))) throw new NodeError('BAD_ARGUMENT', FORBIDDEN_MESSAGE);
      if (stateRoots.some((item) => isWithin(item, candidate) || isWithin(candidate, item))) throw new NodeError('BAD_ARGUMENT', 'That folder belongs to NLC Node itself. Choose a folder for your work.');
    }
  }

  // The folder's own identity (device and inode) survives a move or rename on the same disk, so a shared
  // folder the person moves or renames can be found again.
  async function identityOf(real) {
    try { const info = await fsImpl.stat(real); return info && info.ino ? `${info.dev}:${info.ino}` : ''; } catch { return ''; }
  }

  // A grant shared before identities were kept gets its identity the first time its folder is found.
  async function remember(label, real) {
    const found = state.grants.find((g) => g.label === label);
    if (!found || found.id) return;
    const id = await identityOf(real);
    if (!id) return;
    commit({ grants: state.grants.map((g) => (g === found ? { ...g, id } : g)), paused: state.paused }, { type: 'identified', label });
  }

  const SEARCH_SKIP = new Set(['library', 'node_modules', 'appdata', '$recycle.bin']);

  // The shared folder's path no longer opens: look for the same folder (same identity) where a person puts
  // things: beside where it was, Desktop, Documents, Downloads and the home folder, two levels deep.
  async function heal(label) {
    const found = state.grants.find((g) => g.label === label);
    if (!found || !found.id) return null;
    try { await fsImpl.realpath(found.path); return null; } catch {}
    const roots = [api.dirname(clean(found.path)), ...['Desktop', 'Documents', 'Downloads'].map((n) => api.join(homeDir, n)), homeDir];
    const seen = new Set();
    let budget = 4000;
    async function look(dir, depth) {
      if (budget <= 0 || seen.has(key(dir))) return null;
      seen.add(key(dir));
      let entries;
      try { entries = await fsApi.promises.readdir(dir, { withFileTypes: true }); } catch { return null; }
      const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SEARCH_SKIP.has(e.name.toLowerCase()));
      for (const entry of folders) {
        if (budget-- <= 0) return null;
        const candidate = api.join(dir, entry.name);
        if (await identityOf(candidate) === found.id) return candidate;
      }
      if (depth >= 2) return null;
      for (const entry of folders) {
        const hit = await look(api.join(dir, entry.name), depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    let where = null;
    for (const root of roots) { where = await look(root, 1); if (where) break; }
    if (!where) return null;
    let real;
    try { real = String(await fsImpl.realpath(where)).replace(/^\\\\\?\\(?!UNC\\)/, ''); refuseIfForbidden([where, real]); } catch { return null; }
    const followsName = key(api.basename(clean(found.path))) === key(found.label);
    const others = new Set(state.grants.filter((g) => g !== found).map((g) => g.label.toLowerCase()));
    let nextLabel = found.label;
    if (followsName) {
      const base = api.basename(clean(real)).replace(/[\\/\u0000-\u001f]/g, '').trim() || found.label;
      nextLabel = base;
      for (let n = 2; others.has(nextLabel.toLowerCase()); n += 1) nextLabel = `${base} ${n}`;
    }
    const moved = { ...found, label: nextLabel, path: real };
    commit({ grants: state.grants.map((g) => (g === found ? moved : g)), paused: state.paused }, { type: 'moved', label: nextLabel, was: found.label });
    return { ...moved };
  }

  async function add(absPath) {
    if (typeof absPath !== 'string' || !absPath.trim() || !api.isAbsolute(absPath.trim())) {
      throw new NodeError('BAD_ARGUMENT', 'Choose a folder with the Add folder button.');
    }
    const chosen = absPath.trim();
    let real;
    try { real = await fsImpl.realpath(chosen); } catch { throw new NodeError('NOT_FOUND', 'That folder could not be found.'); }
    real = String(real).replace(/^\\\\\?\\(?!UNC\\)/, '');
    let info;
    try { info = await fsImpl.stat(real); } catch { throw new NodeError('NOT_FOUND', 'That folder could not be found.'); }
    if (!info.isDirectory()) throw new NodeError('BAD_ARGUMENT', 'That is a file. Choose a folder to share.');
    refuseIfForbidden([chosen, real]);
    const existing = state.grants.find((g) => key(g.path) === key(real));
    if (existing) return { ...existing };
    const name = api.basename(clean(chosen)).replace(/[\\/\u0000-\u001f]/g, '').trim() || 'Folder';
    const grant = { label: uniqueLabel(name), path: real, addedAt: new Date().toISOString(), id: await identityOf(real) };
    commit({ grants: [...state.grants, grant], paused: state.paused }, { type: 'added', label: grant.label });
    return { ...grant };
  }

  // Point a shared folder at a different folder. The name stays; the old folder and its files are not touched.
  async function replace(label, absPath) {
    const wanted = String(label == null ? '' : label).trim().toLowerCase();
    const found = state.grants.find((g) => g.label.toLowerCase() === wanted);
    if (!found) throw new NodeError('NOT_FOUND', 'That folder is not shared.');
    if (typeof absPath !== 'string' || !absPath.trim() || !api.isAbsolute(absPath.trim())) {
      throw new NodeError('BAD_ARGUMENT', 'Choose a folder with the Choose a different folder button.');
    }
    const chosen = absPath.trim();
    let real;
    try { real = await fsImpl.realpath(chosen); } catch { throw new NodeError('NOT_FOUND', 'That folder could not be found.'); }
    real = String(real).replace(/^\\\\\?\\(?!UNC\\)/, '');
    let info;
    try { info = await fsImpl.stat(real); } catch { throw new NodeError('NOT_FOUND', 'That folder could not be found.'); }
    if (!info.isDirectory()) throw new NodeError('BAD_ARGUMENT', 'That is a file. Choose a folder to share.');
    refuseIfForbidden([chosen, real]);
    if (key(found.path) === key(real)) return { ...found };
    if (state.grants.some((g) => g !== found && key(g.path) === key(real))) throw new NodeError('BAD_ARGUMENT', 'That folder is already shared.');
    const grant = { label: found.label, path: real, addedAt: new Date().toISOString() };
    commit({ grants: state.grants.map((g) => (g === found ? grant : g)), paused: state.paused }, { type: 'replaced', label: grant.label });
    return { ...grant };
  }

  function remove(label) {
    const wanted = String(label == null ? '' : label).trim().toLowerCase();
    const found = state.grants.find((g) => g.label.toLowerCase() === wanted);
    if (!found) throw new NodeError('NOT_FOUND', 'That folder is not shared.');
    commit({ grants: state.grants.filter((g) => g !== found), paused: state.paused }, { type: 'removed', label: found.label });
    return { ...found };
  }

  function setPaused(value) {
    const paused = value === true;
    if (paused === state.paused) return paused;
    commit({ grants: state.grants, paused }, { type: 'paused', paused });
    return paused;
  }

  function onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  load();
  return Object.freeze({ list: snapshot, add, replace, remove, heal, remember, isPaused: () => state.paused, setPaused, onChange, file });
}

module.exports = { createGrants, forbiddenLocations, GRANTS_FILENAME, FORBIDDEN_MESSAGE };
