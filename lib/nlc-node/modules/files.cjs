'use strict';
// files module (CONTRACT 1.2/1.3): list, stat, search, read_text, write_text, edit,
// make_folder, rename, move, copy. Every path goes through the injected path guard
// (context.pathGuard, piece P2). Pause check and action logging live in the dispatcher.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { MODULE_API_VERSION } = require('../identity.cjs');
const { NodeError } = require('../errors.cjs');

const MAX_READ = 262144;
const EDIT_LIMIT = 5 * 1024 * 1024;
const LIST_MAX = 2000;
const SEARCH_MAX = 500;
const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

const mb = (n) => Math.round((n / 1048576) * 100) / 100;
const fwd = (p) => String(p || '').split(path.sep).join('/').replace(/\\/g, '/');
const joinRel = (a, b) => (a ? a + '/' + b : b);
const bad = (msg) => new NodeError('BAD_ARGUMENT', msg);

function clamp(value, def, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

function mapFsError(e, tool) {
  if (e instanceof NodeError) return e;
  switch (e && e.code) {
    case 'ENOENT': return new NodeError('NOT_FOUND', 'I could not find that file or folder.');
    case 'EEXIST': return new NodeError('EXISTS', 'That name already exists. Pick another name.');
    case 'EISDIR': return bad('That is a folder, not a file.');
    case 'ENOTDIR': return bad('Part of that path is a file, not a folder.');
    case 'EBUSY': case 'ETXTBSY': return new NodeError('BUSY', 'That file is in use by another program. Try again in a moment.');
    case 'EACCES': case 'EPERM': return bad('This computer does not allow changing that file or folder.');
    case 'ENOSPC': return bad('The disk is full.');
    default: return bad(`I could not complete ${tool} on that file or folder.`);
  }
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch (_) { return false; }
}

function decodeUtf8(buf) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
}

function looksBinary(buf) {
  if (buf.includes(0)) return true;
  // tolerate a multi-byte character cut at the end of the sample
  for (let cut = 0; cut <= 3 && cut < buf.length; cut++) {
    try { decodeUtf8(buf.subarray(0, buf.length - cut)); return false; } catch (_) { /* try shorter */ }
  }
  return true;
}

const NOT_TEXT_MSG = 'That file is not plain text (it looks like an image, video or other binary file).';

async function atomicWrite(target, data, { exclusive, mode } = {}) {
  const tmp = path.join(path.dirname(target), `.nlc-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let fh = null;
  try {
    fh = await fsp.open(tmp, 'wx', mode === undefined ? 0o666 : mode);
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    if (exclusive) {
      try {
        await fsp.link(tmp, target);
        await fsp.unlink(tmp);
        return;
      } catch (e) {
        if (e.code === 'EEXIST') throw new NodeError('EXISTS', `${path.basename(target)} already exists. Use mode overwrite or pick another name.`);
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EACCES', 'EMLINK'].includes(e.code)) throw e;
        // filesystem without hard links (e.g. exFAT USB drive): fall back to check then rename
        if (await exists(target)) throw new NodeError('EXISTS', `${path.basename(target)} already exists. Use mode overwrite or pick another name.`);
      }
    }
    await fsp.rename(tmp, target);
  } catch (e) {
    if (fh) { try { await fh.close(); } catch (_) { /* ignore */ } }
    try { await fsp.unlink(tmp); } catch (_) { /* already gone */ }
    throw e;
  }
}

function create(context) {
  const ctx = context || {};
  const guard = ctx.pathGuard || (typeof ctx.getModule === 'function' ? ctx.getModule('path-guard') : null);
  if (!guard) throw new Error('files module needs a path guard');
  const renameFn = ctx.renameFn || ((a, b) => fsp.rename(a, b));

  const res = (folder, p, intent) => guard.resolve(folder, p === undefined || p === null ? '' : String(p), { intent });
  const relOut = (r) => fwd(r.relPath);

  async function describe(full, name, st) {
    return {
      name,
      type: st.isDirectory() ? 'folder' : 'file',
      size: st.isDirectory() ? 0 : st.size,
      modified: st.mtime.toISOString(),
    };
  }

  // Lists the entries of one real directory, applying the symlink rule.
  async function entriesOf(folder, relBase, absDir) {
    const dirents = await fsp.readdir(absDir, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const out = [];
    for (const d of dirents) {
      if (d.name.startsWith('.nlc-tmp-')) continue;
      const full = path.join(absDir, d.name);
      const rel = joinRel(relBase, d.name);
      try {
        if (d.isSymbolicLink()) {
          try {
            await res(folder, rel, 'read');
          } catch (e) {
            if (e.code === 'OUTSIDE_GRANT') { out.push({ name: d.name, rel, type: 'link-outside', size: 0, modified: null, follow: false }); continue; }
            if (e.code === 'NOT_FOUND') { out.push({ name: d.name, rel, type: 'file', size: 0, modified: null, follow: false }); continue; }
            throw e;
          }
          const st = await fsp.stat(full);
          out.push({ ...(await describe(full, d.name, st)), rel, follow: false });
        } else {
          const st = await fsp.lstat(full);
          out.push({ ...(await describe(full, d.name, st)), rel, follow: st.isDirectory(), full });
        }
      } catch (e) {
        if (e instanceof NodeError) throw e;
        // entry vanished or unreadable: skip it
      }
    }
    return out;
  }

  const tools = {
    async list(args = {}) {
      const r = await res(args.folder, args.path, 'read');
      const st = await fsp.stat(r.realPath);
      if (!st.isDirectory()) throw bad('That is a file, not a folder. Use stat or read_text.');
      const limit = clamp(args.limit, LIST_MAX, LIST_MAX);
      const recursive = String(args.recursive || 'no').toLowerCase();
      const deep = recursive === 'yes' || recursive === 'true';
      const base = relOut(r);
      const entries = [];
      let truncated = false;
      const queue = [{ rel: base, abs: r.realPath, prefix: '' }];
      while (queue.length && !truncated) {
        const cur = queue.shift();
        for (const e of await entriesOf(args.folder, cur.rel, cur.abs)) {
          if (entries.length >= limit) { truncated = true; break; }
          entries.push({ name: joinRel(cur.prefix, e.name), type: e.type, size: e.size, modified: e.modified });
          if (deep && e.follow) queue.push({ rel: e.rel, abs: e.full, prefix: joinRel(cur.prefix, e.name) });
        }
      }
      return { folder: r.grant.label, path: base, entries, truncated };
    },

    async stat(args = {}) {
      const r = await res(args.folder, args.path, 'read');
      const st = await fsp.stat(r.realPath);
      const d = await describe(r.realPath, path.basename(r.realPath), st);
      return { ...d, name: r.relPath ? path.basename(relOut(r)) : r.grant.label, path: relOut(r), created: st.birthtime.toISOString() };
    },

    async search(args = {}) {
      const q = String(args.name_contains === undefined ? '' : args.name_contains).normalize('NFC').toLowerCase();
      if (!q) throw bad('Tell me part of the file name to look for (name_contains).');
      const limit = clamp(args.limit, 100, SEARCH_MAX);
      const r = await res(args.folder, args.path, 'read');
      const st = await fsp.stat(r.realPath);
      if (!st.isDirectory()) throw bad('That is a file, not a folder to search in.');
      const results = [];
      let truncated = false;
      const queue = [{ rel: relOut(r), abs: r.realPath }];
      while (queue.length && !truncated) {
        const cur = queue.shift();
        for (const e of await entriesOf(args.folder, cur.rel, cur.abs)) {
          if (e.name.normalize('NFC').toLowerCase().includes(q)) {
            if (results.length >= limit) { truncated = true; break; }
            results.push({ name: e.name, path: e.rel, type: e.type, size: e.size, modified: e.modified });
          }
          if (e.follow) queue.push({ rel: e.rel, abs: e.full });
        }
      }
      return { entries: results, truncated };
    },

    async read_text(args = {}) {
      const r = await res(args.folder, args.path, 'read');
      const st = await fsp.stat(r.realPath);
      if (st.isDirectory()) throw bad('That is a folder, not a file. Use list.');
      const paged = args.offset !== undefined || args.length !== undefined;
      const offset = Math.max(0, Number.parseInt(args.offset, 10) || 0);
      const length = clamp(args.length, MAX_READ, MAX_READ);
      const fh = await fsp.open(r.realPath, 'r');
      try {
        if (!paged && st.size > MAX_READ) {
          const sample = Buffer.alloc(Math.min(8192, st.size));
          await fh.read(sample, 0, sample.length, 0);
          if (looksBinary(sample)) throw new NodeError('NOT_TEXT', NOT_TEXT_MSG);
          throw new NodeError('TOO_LARGE', `File is ${mb(st.size)} MB; limit for this call is ${mb(MAX_READ)} MB. Use offset and length.`);
        }
        const buf = Buffer.alloc(Math.min(length, Math.max(0, st.size - offset)));
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        let data = buf.subarray(0, bytesRead);
        if (data.includes(0)) throw new NodeError('NOT_TEXT', NOT_TEXT_MSG);
        let start = 0;
        if (offset > 0) while (start < 3 && start < data.length && (data[start] & 0xc0) === 0x80) start++;
        let end = data.length;
        let text = null;
        const atEnd = offset + bytesRead >= st.size;
        for (let cut = 0; cut <= (atEnd ? 0 : 3) && end - cut > start - 0; cut++) {
          try { text = decodeUtf8(data.subarray(start, end - cut)); end -= cut; break; } catch (_) { /* shorten */ }
        }
        if (text === null) {
          if (data.length === 0) text = '';
          else throw new NodeError('NOT_TEXT', NOT_TEXT_MSG);
        }
        const consumedEnd = offset + end;
        return {
          path: relOut(r), text, offset: offset + start, next_offset: consumedEnd, size: st.size, eof: consumedEnd >= st.size,
        };
      } finally { await fh.close(); }
    },

    async write_text(args = {}) {
      let mode = String(args.mode || 'create').toLowerCase();
      mode = { write: 'overwrite', replace: 'overwrite', add: 'append' }[mode] || mode;
      if (!['create', 'overwrite', 'append'].includes(mode)) throw bad('mode must be create, overwrite or append.');
      let content = args.content;
      if (content === undefined || content === null) content = '';
      if (typeof content !== 'string') {
        if (typeof content === 'number' || typeof content === 'boolean') content = String(content);
        else throw bad('content must be text.');
      }
      let r = await res(args.folder, args.path, 'create');
      if (!r.relPath) throw bad('Give a file name to write.');
      let existing = null;
      try { existing = await fsp.lstat(r.realPath); } catch (_) { /* new file */ }
      if (existing) {
        r = await res(args.folder, args.path, 'write');
        existing = await fsp.stat(r.realPath);
        if (existing.isDirectory()) throw bad(`${path.basename(r.realPath)} is a folder. Pick a file name.`);
      }
      const data = Buffer.from(content, 'utf8');
      if (mode === 'create') {
        if (existing) throw new NodeError('EXISTS', `${path.basename(r.realPath)} already exists. Use mode overwrite or pick another name.`);
        await atomicWrite(r.realPath, data, { exclusive: true });
      } else if (mode === 'overwrite') {
        await atomicWrite(r.realPath, data, { mode: existing ? existing.mode & 0o777 : undefined });
      } else {
        const fh = await fsp.open(r.realPath, 'a');
        try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
      }
      return { path: relOut(r), bytes: data.length, mode };
    },

    async edit(args = {}) {
      const find = args.find;
      if (typeof find !== 'string' || find === '') throw bad('Tell me the exact text to find (find).');
      const replace = args.replace === undefined || args.replace === null ? '' : String(args.replace);
      const which = String(args.which || 'only').toLowerCase();
      if (!['only', 'first', 'all'].includes(which)) throw bad('which must be only, first or all.');
      const r = await res(args.folder, args.path, 'write');
      const st = await fsp.stat(r.realPath);
      if (st.isDirectory()) throw bad('That is a folder, not a file.');
      if (st.size > EDIT_LIMIT) throw new NodeError('TOO_LARGE', `File is ${mb(st.size)} MB; limit for this call is ${mb(EDIT_LIMIT)} MB.`);
      const buf = await fsp.readFile(r.realPath);
      let text;
      try { if (buf.includes(0)) throw new Error('bin'); text = decodeUtf8(buf); } catch (_) { throw new NodeError('NOT_TEXT', NOT_TEXT_MSG); }
      const positions = [];
      for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) positions.push(i);
      if (positions.length === 0) throw new NodeError('NO_MATCH', `I could not find that text in ${path.basename(r.realPath)}. Nothing was changed.`);
      if (which === 'only' && positions.length > 1) {
        throw new NodeError('AMBIGUOUS', `That text matched ${positions.length} times in ${path.basename(r.realPath)}. Nothing was changed. Add more surrounding text, or use which first or all.`);
      }
      const chosen = which === 'all' ? positions : [positions[0]];
      let out = '';
      let last = 0;
      for (const p of chosen) { out += text.slice(last, p) + replace; last = p + find.length; }
      out += text.slice(last);
      await atomicWrite(r.realPath, Buffer.from(out, 'utf8'), { mode: st.mode & 0o777 });
      return { path: relOut(r), replaced: chosen.length };
    },

    async make_folder(args = {}) {
      let target;
      try {
        target = await res(args.folder, args.path, 'create');
      } catch (e) {
        if (e.code !== 'NOT_FOUND') throw e;
        target = null;
      }
      if (target) {
        if (!target.relPath) return { path: '', created: false };
        const st = await fsp.lstat(target.realPath).catch(() => null);
        if (st) {
          if (st.isDirectory()) return { path: relOut(target), created: false };
          throw new NodeError('EXISTS', `${path.basename(target.realPath)} already exists and is a file.`);
        }
        await fsp.mkdir(target.realPath);
        return { path: relOut(target), created: true };
      }
      // some parent folders are missing: create them one by one, each step checked by the guard
      const root = await res(args.folder, '', 'read');
      let raw = fwd(args.path).replace(/^[a-zA-Z]:/, '');
      const rootFwd = fwd(root.grant.path).replace(/^[a-zA-Z]:/, '');
      if (raw.toLowerCase().startsWith(rootFwd.toLowerCase() + '/')) raw = raw.slice(rootFwd.length + 1);
      const parts = raw.split('/').filter((s) => s && s !== '.');
      let rel = '';
      let last = null;
      for (const part of parts) {
        rel = joinRel(rel, part);
        last = await res(args.folder, rel, 'create');
        const st = await fsp.lstat(last.realPath).catch(() => null);
        if (!st) await fsp.mkdir(last.realPath);
        else if (!st.isDirectory()) throw new NodeError('EXISTS', `${part} already exists and is a file.`);
      }
      return { path: last ? relOut(last) : '', created: true };
    },

    async rename(args = {}) {
      const newName = String(args.new_name === undefined ? '' : args.new_name).trim();
      if (!newName || newName === '.' || newName === '..') throw bad('Give the new name (new_name).');
      if (/[\\/]/.test(newName)) throw bad('A new name cannot contain / or \\. To put the item in another folder, use move.');
      if (BAD_NAME_CHARS.test(newName) || /[. ]$/.test(newName)) throw bad('A name cannot contain : * ? " < > | or end with a dot or space.');
      const src = await res(args.folder, args.path, 'write');
      if (!src.relPath) throw bad('The shared folder itself cannot be renamed here.');
      const st = await fsp.lstat(src.realPath);
      let finalName = newName;
      if (!st.isDirectory() && !path.extname(newName)) finalName = newName + path.extname(path.basename(src.realPath));
      const parentRel = fwd(path.posix.dirname(relOut(src)));
      const destRel = joinRel(parentRel === '.' ? '' : parentRel, finalName);
      const dest = await res(args.folder, destRel, 'create');
      const destSt = await fsp.lstat(dest.realPath).catch(() => null);
      if (destSt) {
        const sameItem = destSt.ino && destSt.ino === st.ino && destSt.dev === st.dev;
        if (!sameItem) throw new NodeError('EXISTS', `${finalName} already exists. Pick another name.`);
      }
      await renameFn(src.realPath, dest.realPath);
      return { path: relOut(dest), name: finalName };
    },

    move: (args) => relocate('move', args),
    copy: (args) => relocate('copy', args),
  };

  async function copyTree(src, dst, st) {
    if (st.isSymbolicLink()) {
      await fsp.symlink(await fsp.readlink(src), dst);
      return;
    }
    if (st.isDirectory()) {
      await fsp.mkdir(dst);
      for (const name of await fsp.readdir(src)) {
        await copyTree(path.join(src, name), path.join(dst, name), await fsp.lstat(path.join(src, name)));
      }
      await fsp.utimes(dst, st.atime, st.mtime);
      return;
    }
    await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
    await fsp.utimes(dst, st.atime, st.mtime);
  }

  async function sizes(p, base, into) {
    const st = await fsp.lstat(p);
    if (st.isDirectory()) {
      into.set(base || '.', -1);
      for (const name of await fsp.readdir(p)) await sizes(path.join(p, name), joinRel(base, name), into);
    } else into.set(base || '.', st.isSymbolicLink() ? -2 : st.size);
    return into;
  }

  async function relocate(kind, args = {}) {
    const toFolder = args.to_folder || args.folder;
    const src = await res(args.folder, args.path, kind === 'move' ? 'write' : 'read');
    if (!src.relPath) throw bad(`The shared folder itself cannot be ${kind === 'move' ? 'moved' : 'copied'} here.`);
    const st = await fsp.lstat(src.realPath);
    const name = path.posix.basename(relOut(src));

    let dest;
    let into = null;
    try { into = await res(toFolder, args.to_path, 'read'); } catch (e) { if (e.code !== 'NOT_FOUND') throw e; }
    if (into) {
      const ist = await fsp.stat(into.realPath);
      if (!ist.isDirectory()) throw new NodeError('EXISTS', `${path.basename(into.realPath)} already exists. Pick another name.`);
      dest = await res(toFolder, joinRel(relOut(into), name), 'create');
    } else {
      dest = await res(toFolder, args.to_path, 'create');
    }
    if (!dest.relPath) throw bad('Give the destination folder or new path (to_path).');
    const rel = path.relative(src.realPath, dest.realPath);
    if (st.isDirectory() && (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)))) {
      throw bad('A folder cannot be put inside itself.');
    }
    if (await exists(dest.realPath)) throw new NodeError('EXISTS', `${path.basename(dest.realPath)} already exists in the destination. Pick another name.`);

    if (kind === 'move') {
      try {
        await renameFn(src.realPath, dest.realPath);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        // other drive: copy, check every size, and only then remove the original
        try {
          await copyTree(src.realPath, dest.realPath, st);
          const a = await sizes(src.realPath, '', new Map());
          const b = await sizes(dest.realPath, '', new Map());
          if (a.size !== b.size || [...a].some(([k, v]) => b.get(k) !== v)) throw bad('The copy did not match the original, so nothing was moved.');
          if ([...a.values()].includes(-2)) { /* links were recreated as links */ }
        } catch (err) {
          await fsp.rm(dest.realPath, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
        await fsp.rm(src.realPath, { recursive: true, force: true });
      }
    } else {
      try { await copyTree(src.realPath, dest.realPath, st); } catch (err) {
        await fsp.rm(dest.realPath, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    }
    return { folder: dest.grant.label, path: relOut(dest) };
  }

  // Every tool turns raw file-system errors into plain NodeErrors.
  const wrapped = {};
  for (const [tool, fn] of Object.entries(tools)) {
    wrapped[tool] = async (args, call) => {
      try { return await fn(args || {}, call); } catch (e) { throw mapFsError(e, tool); }
    };
  }

  return {
    tools: wrapped,
    async start() {},
    async health() { return { ok: true }; },
    async stop() {},
  };
}

module.exports = {
  manifest: { apiVersion: MODULE_API_VERSION, id: 'files', version: '1.0.0', dependsOn: [] },
  create,
};
