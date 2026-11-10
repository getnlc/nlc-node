'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeLink } = require('./_links.cjs');
const test = require('node:test');
const { createPathGuard } = require('../../lib/nlc-node/path-guard.cjs');

function grantsOf(list) { return { list: () => list.map((g) => ({ addedAt: 't', ...g })) }; }
async function refused(promise, code) {
  await assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); assert.doesNotMatch(error.message, /\n\s+at /); return true; });
}

// ---------- real filesystem (Linux/macOS/Windows host), real symlinks ----------
function makeTree(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-guard-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const grant = path.join(base, 'Footage');
  fs.mkdirSync(path.join(grant, 'Day 1'), { recursive: true });
  fs.mkdirSync(path.join(base, 'Footage2'));
  fs.mkdirSync(path.join(base, 'secret'));
  fs.writeFileSync(path.join(grant, 'clip 1.mov'), 'inside');
  fs.writeFileSync(path.join(grant, 'Day 1', 'a.txt'), 'a');
  fs.writeFileSync(path.join(base, 'secret', 'passwords.txt'), 'outside');
  fs.writeFileSync(path.join(base, 'Footage2', 'other.txt'), 'sibling');
  return { base, grant };
}

test('every way an agent can write a path inside the folder lands on the same real file (F08)', async (t) => {
  const { grant } = makeTree(t);
  const guard = createPathGuard({ grants: grantsOf([{ label: 'Footage', path: grant }]) });
  const expected = path.join(grant, 'clip 1.mov');
  const variants = ['clip 1.mov', './clip 1.mov', 'Footage/clip 1.mov', 'Footage\\clip 1.mov', '/clip 1.mov', '\\clip 1.mov', 'Day 1/../clip 1.mov', 'footage/CLIP 1.mov'.replace('CLIP 1', 'clip 1'), path.join(grant, 'clip 1.mov'), ' clip 1.mov '];
  for (const variant of variants) {
    const result = await guard.resolve('Footage', variant, { intent: 'read' });
    assert.equal(result.realPath, expected, variant);
    assert.equal(result.relPath, 'clip 1.mov');
    assert.equal(result.grant.label, 'Footage');
  }
  assert.equal((await guard.resolve('footage', '')).relPath, '');
  assert.equal((await guard.resolve('Footage', 'Footage')).relPath, '');
  assert.equal((await guard.resolve('Footage', 'Footage/Day 1/a.txt')).relPath, 'Day 1/a.txt');
  assert.equal((await guard.resolve('Footage', '/Day 1\\a.txt')).relPath, 'Day 1/a.txt');
});

test('a real subfolder named like the shared folder is not mistaken for the label', async (t) => {
  const { grant } = makeTree(t);
  fs.mkdirSync(path.join(grant, 'Footage'));
  fs.writeFileSync(path.join(grant, 'Footage', 'deep.txt'), 'x');
  const guard = createPathGuard({ grants: grantsOf([{ label: 'Footage', path: grant }]) });
  assert.equal((await guard.resolve('Footage', 'Footage/deep.txt')).relPath, 'Footage/deep.txt');
});

test('traversal, outside absolute paths and sibling folders with the same prefix are refused (S01)', async (t) => {
  const { base, grant } = makeTree(t);
  const guard = createPathGuard({ grants: grantsOf([{ label: 'Footage', path: grant }]) });
  for (const bad of ['..', '../secret/passwords.txt', 'Day 1/../../secret/passwords.txt', '..\\secret\\passwords.txt', 'Footage/../../secret', path.join(base, 'secret', 'passwords.txt'), path.join(base, 'Footage2', 'other.txt'), base]) {
    await refused(guard.resolve('Footage', bad, { intent: 'read' }), 'OUTSIDE_GRANT');
    await refused(guard.resolve('Footage', bad, { intent: 'write' }), 'OUTSIDE_GRANT');
  }
  if (process.platform !== 'win32') await refused(guard.resolve('Footage', '/etc/passwd'), 'OUTSIDE_GRANT');
});

test('a symlink (on Windows a junction) inside the folder that leads outside is refused for read, write and create (S01)', async (t) => {
  const { base, grant } = makeTree(t);
  makeLink(path.join(base, 'secret'), path.join(grant, 'linkdir'));
  const hasFileLink = makeLink(path.join(base, 'secret', 'passwords.txt'), path.join(grant, 'linkfile.txt'));
  makeLink(path.join(base, 'Footage2'), path.join(grant, 'sibling'));
  const hasDangling = makeLink(path.join(base, 'nowhere.txt'), path.join(grant, 'dangling.txt'));
  makeLink(path.join(grant, 'Day 1'), path.join(grant, 'innerlink'));
  const guard = createPathGuard({ grants: grantsOf([{ label: 'Footage', path: grant }]) });
  await refused(guard.resolve('Footage', 'linkdir', { intent: 'read' }), 'OUTSIDE_GRANT');
  await refused(guard.resolve('Footage', 'linkdir/passwords.txt', { intent: 'read' }), 'OUTSIDE_GRANT');
  await refused(guard.resolve('Footage', 'linkdir\\passwords.txt', { intent: 'read' }), 'OUTSIDE_GRANT');
  if (hasFileLink) {
    await refused(guard.resolve('Footage', 'linkfile.txt', { intent: 'read' }), 'OUTSIDE_GRANT');
    await refused(guard.resolve('Footage', 'linkfile.txt', { intent: 'write' }), 'OUTSIDE_GRANT');
  }
  await refused(guard.resolve('Footage', 'linkdir/new.txt', { intent: 'create' }), 'OUTSIDE_GRANT');
  await refused(guard.resolve('Footage', 'sibling/other.txt', { intent: 'read' }), 'OUTSIDE_GRANT');
  if (hasDangling) await refused(guard.resolve('Footage', 'dangling.txt', { intent: 'create' }), 'OUTSIDE_GRANT');
  // a link that stays inside the folder is fine
  assert.equal((await guard.resolve('Footage', 'innerlink/a.txt')).relPath, 'Day 1/a.txt');
  // listings show the outside link by name only
  assert.equal(await guard.classifyEntry({ label: 'Footage', path: grant }, path.join(grant, 'linkdir')), 'link-outside');
  assert.equal(await guard.classifyEntry({ label: 'Footage', path: grant }, path.join(grant, 'sibling')), 'link-outside');
  assert.equal(await guard.classifyEntry({ label: 'Footage', path: grant }, path.join(grant, 'innerlink')), 'ok');
  assert.equal(await guard.classifyEntry({ label: 'Footage', path: grant }, path.join(grant, 'clip 1.mov')), 'ok');
  // nothing was created through the links
  assert.equal(fs.existsSync(path.join(base, 'secret', 'new.txt')), false);
});

test('read of a missing path is NOT_FOUND, create resolves the parent and appends the name', async (t) => {
  const { grant } = makeTree(t);
  const guard = createPathGuard({ grants: grantsOf([{ label: 'Footage', path: grant }]) });
  await refused(guard.resolve('Footage', 'nope.txt', { intent: 'read' }), 'NOT_FOUND');
  await refused(guard.resolve('Footage', 'missing dir/new.txt', { intent: 'create' }), 'NOT_FOUND');
  const made = await guard.resolve('Footage', 'Day 1/new file.txt', { intent: 'create' });
  assert.equal(made.realPath, path.join(grant, 'Day 1', 'new file.txt'));
  assert.equal(made.relPath, 'Day 1/new file.txt');
  const existing = await guard.resolve('Footage', 'clip 1.mov', { intent: 'write' });
  assert.equal(existing.realPath, path.join(grant, 'clip 1.mov'));
  await refused(guard.resolve('Footage', 'a\u0000b'), 'BAD_ARGUMENT');
  await refused(guard.resolve('Footage', 'x', { intent: 'delete' }), 'BAD_ARGUMENT');
});

test('an unknown folder name returns NOT_GRANTED listing the shared folders, or how to share one when there are none (G04)', async (t) => {
  const { grant } = makeTree(t);
  const guard = createPathGuard({ grants: grantsOf([{ label: 'Footage', path: grant }, { label: 'Footage 2', path: grant }]) });
  await assert.rejects(guard.resolve('Music', 'x'), (error) => {
    assert.equal(error.code, 'NOT_GRANTED');
    assert.equal(error.message, 'That folder has not been shared with me. Available folders: Footage, Footage 2.');
    return true;
  });
  const none = createPathGuard({ grants: grantsOf([]) });
  await assert.rejects(none.resolve('Footage', 'x'), (error) => {
    assert.equal(error.code, 'NOT_GRANTED');
    assert.match(error.message, /No folders are shared with me yet.*Add folder/);
    return true;
  });
});

// ---------- simulated Windows / macOS (injected platform + in-memory filesystem) ----------
function fakeFs(api, insensitive) {
  const key = (p) => (insensitive ? api.normalize(p).toLowerCase() : api.normalize(p));
  const nodes = new Map();
  const trim = (p) => api.normalize(p).replace(/[\\/]+$/, '') || api.normalize(p);
  const add = (p, kind, target) => {
    // ensure parents exist
    let dir = api.dirname(p);
    const chain = [];
    while (dir !== api.dirname(dir)) { chain.push(dir); dir = api.dirname(dir); }
    chain.push(dir);
    for (const d of chain.reverse()) if (!nodes.has(key(trim(d)))) nodes.set(key(trim(d)), { path: trim(d), kind: 'dir' });
    nodes.set(key(trim(p)), { path: trim(p), kind, target });
  };
  const get = (p) => nodes.get(key(trim(p)));
  const err = (code) => Object.assign(new Error(code), { code });
  async function realpath(p, depth = 0) {
    if (depth > 20) throw err('ELOOP');
    const norm = api.normalize(p);
    const { root } = api.parse(norm);
    let current = root;
    for (const part of norm.slice(root.length).split(api.sep).filter(Boolean)) {
      const next = api.join(current, part);
      const node = get(next);
      if (!node) throw err('ENOENT');
      current = node.kind === 'link' ? await realpath(api.resolve(api.dirname(next), node.target), depth + 1) : node.path;
    }
    return current;
  }
  async function lstat(p) {
    const parent = api.dirname(api.normalize(p));
    let node;
    try { node = get(api.join(await realpath(parent), api.basename(p))); } catch { node = null; }
    if (!node) throw err('ENOENT');
    return { isSymbolicLink: () => node.kind === 'link' };
  }
  return { add, fsImpl: { realpath, lstat } };
}

function windowsGuard(extra = () => {}) {
  const win = path.win32;
  const f = fakeFs(win, true);
  f.add('C:\\Users\\Jo\\Footage\\clip 1.mov', 'file');
  f.add('C:\\Users\\Jo\\Footage\\Day 1\\a.txt', 'file');
  f.add('C:\\Users\\Jo\\Footage2\\other.txt', 'file');
  f.add('C:\\Windows\\System32\\config.txt', 'file');
  f.add('D:\\Footage\\clip 1.mov', 'file');
  f.add('C:\\Users\\Jo\\Footage\\outlink', 'link', 'C:\\Windows\\System32');
  f.add('C:\\Users\\Jo\\Footage\\short~1', 'link', 'C:\\Users\\Jo\\Footage\\Day 1');
  f.add('C:\\Progra~1', 'link', 'C:\\Windows');
  f.add('C:\\Users\\Jo\\Footage\\viaShort', 'link', 'C:\\Progra~1\\System32');
  extra(f);
  return createPathGuard({ grants: grantsOf([{ label: 'Footage', path: 'C:\\Users\\Jo\\Footage' }]), platform: 'win32', fsImpl: f.fsImpl });
}

test('Windows: drive letters, slash styles, case and the extended prefix all reach the same file (F08, S02)', async () => {
  const guard = windowsGuard();
  const expected = 'C:\\Users\\Jo\\Footage\\clip 1.mov';
  for (const input of ['clip 1.mov', 'Footage\\clip 1.mov', 'Footage/clip 1.mov', '/clip 1.mov', 'C:\\Users\\Jo\\Footage\\clip 1.mov', 'c:/users/jo/footage/clip 1.mov', 'c:\\USERS\\jo\\Footage\\clip 1.mov', '\\\\?\\C:\\Users\\Jo\\Footage\\clip 1.mov', '//?/c:/users/jo/footage/clip 1.mov', 'FOOTAGE\\..\\footage\\clip 1.mov', 'CLIP 1.MOV', 'clip 1.mov.', 'clip 1.mov ', 'Day 1\\..\\clip 1.mov']) {
    const r = await guard.resolve('Footage', input);
    assert.equal(r.realPath, expected, input);
    assert.equal(r.relPath, 'clip 1.mov');
  }
  assert.equal((await guard.resolve('Footage', 'FOOTAGE\\..\\footage')).relPath, '');
});

test('Windows: outside locations, other drives, UNC, extended prefixes, drive-relative and prefix look-alikes are refused (S01)', async () => {
  const guard = windowsGuard();
  for (const bad of ['..\\..\\Windows\\System32\\config.txt', 'C:\\Windows\\System32\\config.txt', 'c:/windows', 'D:\\Footage\\clip 1.mov', 'C:\\Users\\Jo\\Footage2\\other.txt', '\\\\?\\C:\\Windows\\System32\\config.txt', '\\\\?\\UNC\\server\\share\\x.txt', '\\\\server\\share\\x.txt', '//server/share/x.txt', 'C:clip.txt', '/Windows/System32/config.txt', 'outlink', 'outlink\\config.txt', 'viaShort\\config.txt']) {
    await refused(guard.resolve('Footage', bad, { intent: 'read' }), 'OUTSIDE_GRANT');
  }
  await refused(guard.resolve('Footage', 'outlink\\new.txt', { intent: 'create' }), 'OUTSIDE_GRANT');
});

test('Windows: alternate data streams, bad characters and device names are refused, short 8.3 names stay checked', async () => {
  const guard = windowsGuard();
  for (const bad of ['clip 1.mov:stream', 'clip 1.mov::$DATA', 'Day 1\\a.txt:hidden', 'a?.txt', 'NUL', 'con.txt', 'Day 1\\COM1', '...', 'Day 1\\.. \\x']) {
    await refused(guard.resolve('Footage', bad, { intent: 'read' }), 'NOT_FOUND');
  }
  // an 8.3 short name that points back inside is fine
  assert.equal((await guard.resolve('Footage', 'short~1\\a.txt')).relPath, 'Day 1/a.txt');
});

test('Windows: a junction or short name leading outside is refused after resolution, nothing is created', async () => {
  const guard = windowsGuard();
  await refused(guard.resolve('Footage', 'viaShort/config.txt', { intent: 'write' }), 'OUTSIDE_GRANT');
  const made = await guard.resolve('Footage', 'Day 1\\New Clip.mov. ', { intent: 'create' });
  assert.equal(made.realPath, 'C:\\Users\\Jo\\Footage\\Day 1\\New Clip.mov');
});

function macGuard(insensitive) {
  const f = fakeFs(path.posix, insensitive);
  f.add('/Users/jo/Footage/Clip.mov', 'file');
  f.add('/Users/jo/Footage/clip.mov', 'file');
  f.add('/Users/jo/Secret/x.txt', 'file');
  f.add('/Users/jo/Footage/out', 'link', '/Users/jo/Secret');
  return createPathGuard({ grants: grantsOf([{ label: 'Footage', path: '/Users/jo/Footage' }]), platform: 'darwin', fsImpl: f.fsImpl, caseInsensitive: insensitive });
}

test('macOS: case games resolve inside on a case-insensitive volume and stay distinct on a case-sensitive one (S02)', async () => {
  const ci = macGuard(true);
  assert.equal((await ci.resolve('Footage', '/USERS/JO/FOOTAGE/clip.mov')).relPath, 'clip.mov');
  assert.equal((await ci.resolve('Footage', 'FOOTAGE/../footage')).relPath, '');
  await refused(ci.resolve('Footage', '/Users/jo/Secret/x.txt'), 'OUTSIDE_GRANT');
  await refused(ci.resolve('Footage', 'out/x.txt'), 'OUTSIDE_GRANT');
  const cs = macGuard(false);
  assert.equal((await cs.resolve('Footage', 'Clip.mov')).relPath, 'Clip.mov');
  assert.equal((await cs.resolve('Footage', 'clip.mov')).relPath, 'clip.mov');
  await refused(cs.resolve('Footage', '/USERS/JO/FOOTAGE/clip.mov'), 'NOT_FOUND'); // different name on a case-sensitive volume
  await refused(cs.resolve('Footage', 'out/x.txt'), 'OUTSIDE_GRANT');
});
