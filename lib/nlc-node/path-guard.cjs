'use strict';
// Path guard (CONTRACT 1.3): every path the agent names is resolved to a real location and must
// lie inside a shared folder, or the call is refused. Platform behaviour is injectable so the
// Windows and macOS branches are tested on Linux.
const fs = require('node:fs');
const nodePath = require('node:path');
const { promisify } = require('node:util');
const { NodeError } = require('./errors.cjs');

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const WIN_BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;

function defaultFs() {
  return { realpath: promisify(fs.realpath.native), lstat: fs.promises.lstat };
}

function missing(error) {
  return Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function createPathGuard({ grants, platform = process.platform, fsImpl = defaultFs(), caseInsensitive } = {}) {
  if (!grants || typeof grants.list !== 'function') throw new TypeError('grants are required');
  const win = platform === 'win32';
  const api = win ? nodePath.win32 : nodePath.posix;
  const insensitiveCache = new Map();

  function normalizeCase(value, insensitive) { return insensitive ? value.toLowerCase() : value; }

  function contains(root, target, insensitive) {
    const rel = api.relative(normalizeCase(root, insensitive), normalizeCase(target, insensitive));
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + api.sep) && !api.isAbsolute(rel));
  }

  async function isInsensitive(rootReal) {
    if (typeof caseInsensitive === 'boolean') return caseInsensitive;
    if (win) return true;
    if (platform !== 'darwin') return false;
    if (insensitiveCache.has(rootReal)) return insensitiveCache.get(rootReal);
    const base = api.basename(rootReal);
    const flipped = base === base.toUpperCase() ? base.toLowerCase() : base.toUpperCase();
    let result = true; // default macOS volumes are case-insensitive
    if (flipped !== base) {
      try { await fsImpl.lstat(api.join(api.dirname(rootReal), flipped)); result = true; } catch { result = false; }
    }
    insensitiveCache.set(rootReal, result);
    return result;
  }

  function names() { return grants.list().map((grant) => grant.label); }

  function findGrant(label) {
    const wanted = String(label == null ? '' : label).trim().replace(/[\\/]+$/, '').toLowerCase();
    const grant = grants.list().find((item) => item.label.toLowerCase() === wanted);
    if (grant) return grant;
    const available = names();
    throw new NodeError('NOT_GRANTED', available.length
      ? `That folder has not been shared with me. Available folders: ${available.join(', ')}. If the customer means a different folder, call ask_for_folder: a folder chooser opens on their computer and they pick it.`
      : 'No folders are shared with me yet. Call ask_for_folder: a folder chooser opens on their computer and they pick the folder to share.');
  }

  function cleanRealpath(value) {
    if (!win) return value;
    return String(value).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  }

  async function realpathOrNull(target) {
    try { return cleanRealpath(await fsImpl.realpath(target)); } catch (error) {
      if (missing(error)) return null;
      throw new NodeError('NOT_FOUND', 'That path could not be opened.');
    }
  }

  async function lstatOrNull(target) {
    try { return await fsImpl.lstat(target); } catch (error) {
      if (missing(error)) return null;
      throw new NodeError('NOT_FOUND', 'That path could not be opened.');
    }
  }

  function outside(grant) { return new NodeError('OUTSIDE_GRANT', `That path is outside the shared folder ${grant.label}.`); }
  function notFound(grant, shown) { return new NodeError('NOT_FOUND', `${shown || 'That path'} was not found in ${grant.label}.`); }

  // Splits a slash-normalised relative path into clean segments; '..' above the grant is OUTSIDE_GRANT.
  function toSegments(text, grant) {
    const stack = [];
    for (const raw of text.split('/')) {
      if (raw === '' || raw === '.') continue;
      if (raw === '..') {
        if (!stack.length) throw outside(grant);
        stack.pop();
        continue;
      }
      let segment = raw;
      if (win) {
        if (WIN_BAD_CHARS.test(segment)) throw notFound(grant, raw); // includes NTFS alternate data streams
        segment = segment.replace(/[. ]+$/, '');
        if (!segment || WIN_RESERVED.test(segment)) throw notFound(grant, raw);
      }
      stack.push(segment);
    }
    return stack;
  }

  async function resolve(folderLabel, relPath, { intent = 'read' } = {}) {
    if (!['read', 'write', 'create'].includes(intent)) throw new NodeError('BAD_ARGUMENT', 'intent must be read, write or create.');
    if (relPath != null && typeof relPath !== 'string') throw new NodeError('BAD_ARGUMENT', 'The path must be text.');
    if (String(relPath || '').includes('\u0000')) throw new NodeError('BAD_ARGUMENT', 'The path contains an invalid character.');
    let grant = findGrant(folderLabel);
    let rootReal = cleanRealpath(await realpathOrNull(grant.path) || '');
    if (!rootReal && typeof grants.heal === 'function') {
      // The person moved or renamed the folder: find it again by its identity and keep working.
      const healed = await grants.heal(grant.label);
      if (healed) { grant = healed; rootReal = cleanRealpath(await realpathOrNull(grant.path) || ''); }
    }
    if (!rootReal) throw new NodeError('NOT_FOUND', `The shared folder ${grant.label} cannot be found on this computer. NLC Node looked where it was and in the usual places (Desktop, Documents, Downloads) and did not find it. Call ask_for_folder: a folder chooser opens on their computer and they pick it again.`);
    if (!grant.id && typeof grants.remember === 'function') { try { await grants.remember(grant.label, rootReal); } catch {} }
    const insensitive = await isInsensitive(rootReal);
    const same = (a, b) => a.toLowerCase() === b.toLowerCase(); // labels are matched ignoring case everywhere

    let text = String(relPath || '').trim().replace(/\\/g, '/');
    let absolute = false;
    if (win) {
      if (/^\/\/[?.]\//.test(text)) {
        text = text.slice(4);
        if (/^unc\//i.test(text)) text = '//' + text.slice(4);
      }
      if (/^[a-zA-Z]:(?![/])/.test(text) && text.length > 2) throw outside(grant); // drive-relative "c:foo"
      absolute = /^[a-zA-Z]:(\/|$)/.test(text) || text.startsWith('//');
    }
    if (absolute) {
      const normalized = api.normalize(text.replace(/\//g, '\\'));
      const prefix = [grant.path, rootReal].find((candidate) => contains(candidate, normalized, true));
      if (!prefix) throw outside(grant);
      text = api.relative(prefix, normalized).replace(/\\/g, '/');
    } else if (text.startsWith('/')) {
      // A leading slash is either an absolute path or "from the top of the shared folder".
      const normalized = api.normalize(win ? text.replace(/\//g, '\\') : text);
      const prefix = [grant.path, rootReal].find((candidate) => contains(candidate, normalized, insensitive));
      if (prefix && !win) {
        text = normalized.slice(prefix.length);
      } else {
        const inner = text.replace(/^\/+/, '');
        const first = inner.split('/')[0];
        const asRelative = await lstatOrNull(api.join(rootReal, ...inner.split('/').filter((s) => s && s !== '..' && s !== '.')));
        if (!asRelative && first && first !== '..') {
          const topLevel = await lstatOrNull(api.join(api.parse(rootReal).root, first));
          if (topLevel) throw outside(grant);
        }
        text = inner;
      }
    }

    let segments = toSegments(text, grant);
    if (segments.length && same(segments[0], grant.label)) {
      const asNamed = await lstatOrNull(api.join(rootReal, ...segments));
      if (!asNamed && (segments.length > 1 || intent === 'read')) segments = segments.slice(1);
    }
    const shown = segments.join('/') || grant.label;
    const candidate = api.join(rootReal, ...segments);

    const finish = (realPath) => {
      if (!contains(rootReal, realPath, insensitive)) throw outside(grant);
      const rel = realPath.slice(rootReal.length).replace(/^[\\/]+/, '').split(api.sep).join('/');
      return Object.freeze({ realPath, grant, relPath: rel });
    };

    if (intent === 'read') {
      const real = await realpathOrNull(candidate);
      if (!real) throw notFound(grant, shown);
      return finish(real);
    }
    const stat = await lstatOrNull(candidate);
    if (stat) {
      const real = await realpathOrNull(candidate);
      if (!real) {
        if (stat.isSymbolicLink()) throw outside(grant); // dangling link: never create through it
        throw notFound(grant, shown);
      }
      return finish(real);
    }
    const parentReal = await realpathOrNull(api.dirname(candidate));
    if (!parentReal) throw notFound(grant, api.dirname(shown) === '.' ? grant.label : api.dirname(shown).split(api.sep).join('/'));
    return finish(api.join(parentReal, api.basename(candidate)));
  }

  async function isInsideGrant(grant, realPath) {
    const rootReal = await realpathOrNull(grant.path);
    return Boolean(rootReal) && contains(rootReal, cleanRealpath(realPath), await isInsensitive(rootReal));
  }

  // Used by listings: an entry that is a link leading outside the grant is shown as 'link-outside'.
  async function classifyEntry(grant, entryPath) {
    const stat = await lstatOrNull(entryPath);
    if (!stat || !stat.isSymbolicLink()) return 'ok';
    const real = await realpathOrNull(entryPath);
    return real && await isInsideGrant(grant, real) ? 'ok' : 'link-outside';
  }

  return Object.freeze({ resolve, isInsideGrant, classifyEntry });
}

module.exports = { createPathGuard };
