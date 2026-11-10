'use strict';
// trash module (CONTRACT 1.3): delete (move to NLC Trash), trash_list, trash_restore.
// There is no permanent-delete or empty-trash tool. The only removal the Node ever performs
// is the original after a verified cross-volume copy into NLC Trash (or out of it on restore).
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MODULE_API_VERSION } = require('../identity.cjs');
const { NodeError } = require('../errors.cjs');

const TRASH_NAME = 'NLC Trash';
const bad = (m) => new NodeError('BAD_ARGUMENT', m);
const fwd = (p) => String(p || '').split(path.sep).join('/').replace(/\\/g, '/');

function clamp(value, def, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

function mapFsError(e, tool) {
  if (e instanceof NodeError) return e;
  switch (e && e.code) {
    case 'ENOENT': return new NodeError('NOT_FOUND', 'I could not find that file or folder.');
    case 'EBUSY': case 'ETXTBSY': return new NodeError('BUSY', 'That file is in use by another program. Try again in a moment.');
    case 'EACCES': case 'EPERM': return bad('This computer does not allow moving that file or folder.');
    case 'ENOSPC': return bad('The disk is full.');
    default: return bad(`I could not complete ${tool} on that file or folder.`);
  }
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally { await fh.close(); }
  return h.digest('hex');
}

// Fingerprint of a file or folder tree: relative path -> size, hash (files) or link target.
async function fingerprint(root) {
  const map = new Map();
  async function walk(p, rel) {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) map.set(rel, 'L:' + (await fsp.readlink(p)));
    else if (st.isDirectory()) {
      map.set(rel, 'D');
      for (const n of (await fsp.readdir(p)).sort()) await walk(path.join(p, n), rel ? rel + '/' + n : n);
    } else map.set(rel, `F:${st.size}:${await sha256(p)}`);
  }
  await walk(root, '');
  return map;
}

function sameFingerprint(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

async function totalSize(p) {
  const st = await fsp.lstat(p);
  if (!st.isDirectory()) return st.size;
  let sum = 0;
  for (const n of await fsp.readdir(p)) sum += await totalSize(path.join(p, n));
  return sum;
}

function create(context) {
  const ctx = context || {};
  const guard = ctx.pathGuard || (typeof ctx.getModule === 'function' ? ctx.getModule('path-guard') : null);
  if (!guard) throw new Error('trash module needs a path guard');
  const homeDir = ctx.homeDir || os.homedir();
  const trashRoot = path.join(homeDir, TRASH_NAME);
  const now = ctx.now || (() => new Date());
  const renameFn = ctx.renameFn || ((a, b) => fsp.rename(a, b));
  const copyFileFn = ctx.copyFileFn || ((a, b) => fsp.copyFile(a, b, fs.constants.COPYFILE_EXCL));
  const caseInsensitive = ctx.caseInsensitive !== undefined ? ctx.caseInsensitive : process.platform !== 'linux';

  const res = (folder, p, intent) => guard.resolve(folder, p === undefined || p === null ? '' : String(p), { intent });
  const norm = (p) => (caseInsensitive ? p.toLowerCase() : p);
  const isInside = (parent, child) => {
    const rel = path.relative(norm(parent), norm(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  async function realTrashRoot() {
    await fsp.mkdir(trashRoot, { recursive: true });
    return fsp.realpath(trashRoot);
  }

  // Copy a file or tree (no overwrite), recreating symlinks as links.
  async function copyTree(src, dst) {
    const st = await fsp.lstat(src);
    if (st.isSymbolicLink()) { await fsp.symlink(await fsp.readlink(src), dst); return; }
    if (st.isDirectory()) {
      await fsp.mkdir(dst);
      for (const n of await fsp.readdir(src)) await copyTree(path.join(src, n), path.join(dst, n));
      await fsp.utimes(dst, st.atime, st.mtime);
      return;
    }
    await copyFileFn(src, dst);
    await fsp.utimes(dst, st.atime, st.mtime);
  }

  // Move src to dst (dst must not exist). Same volume: rename. Other volume: copy to a
  // partial name, verify sizes and hashes, rename into place, and only then remove the original.
  async function safeMove(src, dst) {
    try {
      await renameFn(src, dst);
      return;
    } catch (e) {
      if (!e || e.code !== 'EXDEV') throw e;
    }
    const partial = path.join(path.dirname(dst), `.partial-${crypto.randomBytes(5).toString('hex')}-${path.basename(dst).slice(0, 60)}`);
    try {
      await copyTree(src, partial);
      const [a, b] = [await fingerprint(src), await fingerprint(partial)];
      if (!sameFingerprint(a, b)) throw bad('The copy did not match the original, so I left the original where it was.');
      await fsp.rename(partial, dst);
    } catch (err) {
      await fsp.rm(partial, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    await fsp.rm(src, { recursive: true, force: true });
  }

  async function findSidecar(trashId) {
    const id = String(trashId === undefined ? '' : trashId).trim();
    if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) throw new NodeError('NOT_FOUND', 'I could not find that item in NLC Trash. Use trash_list to see what is there.');
    let days = [];
    try { days = await fsp.readdir(trashRoot); } catch (_) { /* no trash yet */ }
    for (const day of days.sort().reverse()) {
      const meta = path.join(trashRoot, day, `${id}.json`);
      try {
        const info = JSON.parse(await fsp.readFile(meta, 'utf8'));
        const item = path.join(trashRoot, day, path.basename(String(info.storedAs || '')));
        await fsp.lstat(item);
        return { meta, item, info, day };
      } catch (_) { /* not in this day */ }
    }
    throw new NodeError('NOT_FOUND', 'I could not find that item in NLC Trash. Use trash_list to see what is there.');
  }

  const tools = {
    async delete(args = {}) {
      const src = await res(args.folder, args.path, 'write');
      if (!src.relPath) throw bad('The shared folder itself cannot be deleted. Delete things inside it instead.');
      const trashReal = await realTrashRoot();
      if (isInside(trashReal, src.realPath)) throw bad('That is already in NLC Trash.');
      if (isInside(src.realPath, trashReal)) throw bad('That folder contains NLC Trash, so it cannot be deleted.');
      const st = await fsp.lstat(src.realPath);
      const when = now();
      const dayDir = path.join(trashRoot, localDate(when));
      await fsp.mkdir(dayDir, { recursive: true });
      let trashId; let item;
      for (let i = 0; i < 20; i++) {
        trashId = crypto.randomBytes(4).toString('hex');
        const origName = path.basename(src.realPath);
        const stored = `${trashId}-${origName.length > 150 ? origName.slice(0, 150) : origName}`;
        item = path.join(dayDir, stored);
        const meta = path.join(dayDir, `${trashId}.json`);
        if (!(await fsp.lstat(item).catch(() => null)) && !(await fsp.lstat(meta).catch(() => null))) break;
        if (i === 19) throw new NodeError('BUSY', 'Could not make a free name in NLC Trash. Try again.');
      }
      const metaPath = path.join(dayDir, `${trashId}.json`);
      const record = {
        trashId,
        originalFolder: src.grant.label,
        originalPath: fwd(src.relPath),
        deletedAt: when.toISOString(),
        size: await totalSize(src.realPath),
        type: st.isDirectory() ? 'folder' : 'file',
        name: path.basename(src.realPath),
        storedAs: path.basename(item),
      };
      await fsp.writeFile(metaPath, JSON.stringify(record, null, 2), { flag: 'wx' });
      try {
        await safeMove(src.realPath, item);
      } catch (e) {
        await fsp.unlink(metaPath).catch(() => {});
        throw e;
      }
      return { trash_id: trashId, restorable: true, name: record.name };
    },

    async trash_list(args = {}) {
      const limit = clamp(args.limit, 100, 500);
      const items = [];
      let days = [];
      try { days = await fsp.readdir(trashRoot); } catch (_) { /* nothing yet */ }
      for (const day of days.sort().reverse()) {
        let files = [];
        try { files = await fsp.readdir(path.join(trashRoot, day)); } catch (_) { continue; }
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          try {
            const info = JSON.parse(await fsp.readFile(path.join(trashRoot, day, f), 'utf8'));
            await fsp.lstat(path.join(trashRoot, day, path.basename(String(info.storedAs || ''))));
            items.push({
              trash_id: info.trashId, name: info.name, type: info.type, size: info.size,
              original_folder: info.originalFolder, original_path: info.originalPath, deleted_at: info.deletedAt,
            });
          } catch (_) { /* skip damaged or half-made entries */ }
        }
      }
      items.sort((a, b) => (a.deleted_at < b.deleted_at ? 1 : a.deleted_at > b.deleted_at ? -1 : 0));
      return { entries: items.slice(0, limit), truncated: items.length > limit };
    },

    async trash_restore(args = {}) {
      const found = await findSidecar(args.trash_id);
      const info = found.info;
      const origParts = String(info.originalPath || '').split('/').filter(Boolean);
      if (!origParts.length) throw bad('This item has no original location recorded.');
      // make sure the original parent folders exist (the guard checks every step)
      let rel = '';
      for (const part of origParts.slice(0, -1)) {
        rel = rel ? rel + '/' + part : part;
        const r = await res(info.originalFolder, rel, 'create');
        const st = await fsp.lstat(r.realPath).catch(() => null);
        if (!st) await fsp.mkdir(r.realPath);
        else if (!st.isDirectory()) throw bad(`${part} is a file now, so I cannot put the item back there.`);
      }
      const parentRel = origParts.slice(0, -1).join('/');
      const baseName = origParts[origParts.length - 1];
      const ext = info.type === 'file' ? path.extname(baseName) : '';
      const stem = ext ? baseName.slice(0, -ext.length) : baseName;
      let dest = null; let renamed = false;
      for (let n = 0; n < 200; n++) {
        const name = n === 0 ? baseName : `${stem} (restored${n > 1 ? ' ' + n : ''})${ext}`;
        const target = await res(info.originalFolder, parentRel ? parentRel + '/' + name : name, 'create');
        if (!(await fsp.lstat(target.realPath).catch(() => null))) { dest = target; renamed = n > 0; break; }
      }
      if (!dest) throw new NodeError('EXISTS', 'Too many items already use that name. Move or rename some first.');
      await safeMove(found.item, dest.realPath);
      await fsp.unlink(found.meta).catch(() => {});
      await fsp.rmdir(path.dirname(found.meta)).catch(() => {}); // only succeeds when the date folder is empty
      return { folder: dest.grant.label, path: fwd(dest.relPath), renamed };
    },
  };

  const wrapped = {};
  for (const [tool, fn] of Object.entries(tools)) {
    wrapped[tool] = async (args, call) => {
      try { return await fn(args || {}, call); } catch (e) { throw mapFsError(e, tool); }
    };
  }
  return {
    tools: wrapped,
    trashPath: trashRoot,
    async start() {},
    async health() { return { ok: true }; },
    async stop() {},
  };
}

module.exports = {
  manifest: { apiVersion: MODULE_API_VERSION, id: 'trash', version: '1.0.0', dependsOn: [] },
  create,
};
