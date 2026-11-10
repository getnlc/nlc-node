'use strict';
// Drives the real `trash` module tools on real temp folders. `pathGuard` is a small in-test fake
// following the FROZEN signature (Addendum A).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeLink } = require('./_links.cjs');
const crypto = require('node:crypto');
const { validateDescriptor } = require('../../lib/nlc-node/module-contract.cjs');
const { NodeError } = require('../../lib/nlc-node/errors.cjs');
const trashModule = require('../../lib/nlc-node/modules/trash.cjs');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-trash-')));
const w = (root, rel, data) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const code = async (promise) => { try { await promise; } catch (e) { return e; } assert.fail('expected a NodeError'); };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function fakeGuard(grantList) {
  const grants = { list: () => grantList.map((g) => ({ ...g, addedAt: 'x' })) };
  const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  return {
    async resolve(label, input, { intent }) {
      const grant = grants.list().find((g) => g.label.toLowerCase() === String(label).toLowerCase());
      if (!grant) throw new NodeError('NOT_GRANTED', `That folder has not been shared with me. Available folders: ${grants.list().map((g) => g.label).join(', ') || 'none'}.`);
      const root = fs.realpathSync(grant.path);
      let rel = String(input || '').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
      const abs = path.resolve(root, ...rel.split('/').filter(Boolean));
      if (!inside(root, abs)) throw new NodeError('OUTSIDE_GRANT', `That path is outside the shared folder ${grant.label}.`);
      let real;
      if (intent === 'create') {
        let rp;
        try { rp = fs.realpathSync(path.dirname(abs)); } catch (_) { throw new NodeError('NOT_FOUND', 'The folder does not exist.'); }
        real = abs === root ? root : path.join(rp, path.basename(abs));
      } else {
        try { real = fs.realpathSync(abs); } catch (_) { throw new NodeError('NOT_FOUND', 'I could not find that.'); }
      }
      if (!inside(root, real)) throw new NodeError('OUTSIDE_GRANT', `That path is outside the shared folder ${grant.label}.`);
      return { realPath: real, grant, relPath: path.relative(root, real).split(path.sep).join('/') };
    },
  };
}

function setup(extra = {}) {
  const root = tmp(); const home = tmp();
  const guard = fakeGuard([{ label: 'Footage', path: root }, { label: 'Home', path: home }]);
  const inst = trashModule.create({ pathGuard: guard, homeDir: home, now: () => new Date(2026, 9, 24, 15, 30, 0), ...extra });
  return { root, home, t: inst.tools, inst, trash: path.join(home, 'NLC Trash') };
}

test('descriptor valid; the tool list has delete, trash_list, trash_restore and nothing that erases (S04)', () => {
  assert.equal(validateDescriptor(trashModule).manifest.id, 'trash');
  const { t } = setup();
  assert.deepEqual(Object.keys(t).sort(), ['delete', 'trash_list', 'trash_restore']);
});

test('S03 delete a file: gone from folder, in NLC Trash/<date>/, listed, restore gives identical bytes', async () => {
  const { t, root, trash } = setup();
  const p = w(root, 'Day 1/clip 1.mov', crypto.randomBytes(5000));
  const before = sha(p);
  const d = await t.delete({ folder: 'Footage', path: 'Day 1/clip 1.mov' });
  assert.equal(d.restorable, true); assert.match(d.trash_id, /^[0-9a-f]{8}$/);
  assert.ok(!fs.existsSync(p));
  const dayDir = path.join(trash, '2026-10-24');
  assert.ok(fs.existsSync(path.join(dayDir, `${d.trash_id}-clip 1.mov`)));
  const side = JSON.parse(fs.readFileSync(path.join(dayDir, `${d.trash_id}.json`), 'utf8'));
  assert.equal(side.originalFolder, 'Footage'); assert.equal(side.originalPath, 'Day 1/clip 1.mov');
  assert.equal(side.size, 5000); assert.ok(side.deletedAt);
  const list = await t.trash_list({});
  assert.equal(list.entries.length, 1);
  assert.deepEqual([list.entries[0].trash_id, list.entries[0].original_path, list.entries[0].name], [d.trash_id, 'Day 1/clip 1.mov', 'clip 1.mov']);
  const r = await t.trash_restore({ trash_id: d.trash_id });
  assert.deepEqual(r, { folder: 'Footage', path: 'Day 1/clip 1.mov', renamed: false });
  assert.equal(sha(p), before);
  assert.equal((await t.trash_list({})).entries.length, 0);
});

test('S03 deleting a folder moves the whole folder and restore brings it all back', async () => {
  const { t, root } = setup();
  w(root, 'proj/a.txt', 'A'); w(root, 'proj/sub/b.txt', 'BB');
  const d = await t.delete({ folder: 'Footage', path: 'proj' });
  assert.ok(!fs.existsSync(path.join(root, 'proj')));
  assert.equal((await t.trash_list({})).entries[0].size, 3);
  await t.trash_restore({ trash_id: d.trash_id });
  assert.equal(fs.readFileSync(path.join(root, 'proj', 'sub', 'b.txt'), 'utf8'), 'BB');
});

test('S03 same name deleted twice keeps both; restore into a taken name uses "(restored)"; missing parent is recreated', async () => {
  const { t, root } = setup();
  w(root, 'a/same.txt', 'first');
  const d1 = await t.delete({ folder: 'Footage', path: 'a/same.txt' });
  w(root, 'a/same.txt', 'second');
  const d2 = await t.delete({ folder: 'Footage', path: 'a/same.txt' });
  assert.notEqual(d1.trash_id, d2.trash_id);
  assert.equal((await t.trash_list({})).entries.length, 2);
  w(root, 'a/same.txt', 'now here');
  const r1 = await t.trash_restore({ trash_id: d1.trash_id });
  assert.equal(r1.path, 'a/same (restored).txt'); assert.equal(r1.renamed, true);
  const r2 = await t.trash_restore({ trash_id: d2.trash_id });
  assert.equal(r2.path, 'a/same (restored 2).txt');
  assert.equal(fs.readFileSync(path.join(root, 'a', 'same.txt'), 'utf8'), 'now here');
  assert.equal(fs.readFileSync(path.join(root, 'a', 'same (restored).txt'), 'utf8'), 'first');
  // parent folder gone: recreated on restore
  w(root, 'gone/dir/x.txt', 'X');
  const d3 = await t.delete({ folder: 'Footage', path: 'gone/dir/x.txt' });
  const d4 = await t.delete({ folder: 'Footage', path: 'gone' });
  const back = await t.trash_restore({ trash_id: d3.trash_id });
  assert.equal(back.path, 'gone/dir/x.txt');
  assert.equal(fs.readFileSync(path.join(root, 'gone', 'dir', 'x.txt'), 'utf8'), 'X');
  assert.ok(d4.trash_id);
});

test('S04 delete inside NLC Trash is refused; the folder holding the trash and the shared folder itself are refused; nothing moves', async () => {
  const { t, root, home, trash } = setup();
  w(root, 'x.txt', 'x');
  const d = await t.delete({ folder: 'Footage', path: 'x.txt' });
  const inTrash = `NLC Trash/2026-10-24/${d.trash_id}-x.txt`;
  const e = await code(t.delete({ folder: 'Home', path: inTrash }));
  assert.equal(e.message, 'That is already in NLC Trash.');
  assert.ok(fs.existsSync(path.join(home, inTrash)));
  assert.equal((await code(t.delete({ folder: 'Home', path: 'NLC Trash' }))).message, 'That is already in NLC Trash.');
  assert.equal((await code(t.delete({ folder: 'Footage', path: '' }))).code, 'BAD_ARGUMENT');
  w(home, 'inner/keep.txt', 'k');
  assert.ok(fs.existsSync(trash));
  assert.equal((await code(t.delete({ folder: 'Footage', path: 'nope.txt' }))).code, 'NOT_FOUND');
  assert.equal((await code(t.delete({ folder: 'Nowhere', path: 'x' }))).code, 'NOT_GRANTED');
  assert.equal((await code(t.trash_restore({ trash_id: '../../etc' }))).code, 'NOT_FOUND');
  assert.equal((await code(t.trash_restore({ trash_id: 'deadbeef' }))).code, 'NOT_FOUND');
});

test('delete follows a symlink-out request: outside the grant is refused and nothing is touched', async () => {
  const { t, root } = setup();
  const outside = tmp(); w(outside, 'o.txt', 'O');
  makeLink(outside, path.join(root, 'lnk'));
  assert.equal((await code(t.delete({ folder: 'Footage', path: 'lnk/o.txt' }))).code, 'OUTSIDE_GRANT');
  assert.ok(fs.existsSync(path.join(outside, 'o.txt')));
});

test('trash_list: newest first, limit honoured', async () => {
  let n = 0;
  const { t, root } = setup({ now: () => new Date(2026, 9, 24, 10, 0, n++) });
  for (const f of ['1.txt', '2.txt', '3.txt']) { w(root, f, f); await t.delete({ folder: 'Footage', path: f }); }
  const all = await t.trash_list({});
  assert.deepEqual(all.entries.map((e) => e.name), ['3.txt', '2.txt', '1.txt']);
  const two = await t.trash_list({ limit: 2 });
  assert.equal(two.entries.length, 2); assert.equal(two.truncated, true);
});

test('S05 across volumes: copy, verify size and hash, then remove the original', async () => {
  const exdev = async () => { const e = new Error('x'); e.code = 'EXDEV'; throw e; };
  const { t, root, trash } = setup({ renameFn: exdev });
  const p = w(root, 'usb/f/a.bin', crypto.randomBytes(3000)); w(root, 'usb/f/s/b.txt', 'B');
  const before = sha(p);
  const d = await t.delete({ folder: 'Footage', path: 'usb/f' });
  assert.ok(!fs.existsSync(path.join(root, 'usb', 'f')));
  const stored = path.join(trash, '2026-10-24', `${d.trash_id}-f`);
  assert.equal(sha(path.join(stored, 'a.bin')), before);
  assert.deepEqual(fs.readdirSync(path.join(trash, '2026-10-24')).filter((n) => n.startsWith('.partial')), []);
  await t.trash_restore({ trash_id: d.trash_id });
  assert.equal(sha(p), before);
});

test('S05 kill mid-copy leaves the original intact and no half item in trash', async () => {
  const dying = async (src, dst) => { fs.writeFileSync(dst, fs.readFileSync(src).subarray(0, 10)); throw new Error('power cut'); };
  const exdev = async () => { const e = new Error('x'); e.code = 'EXDEV'; throw e; };
  const { t, root, trash } = setup({ renameFn: exdev, copyFileFn: dying });
  const p = w(root, 'big.bin', crypto.randomBytes(4000));
  const before = sha(p);
  await code(t.delete({ folder: 'Footage', path: 'big.bin' }));
  assert.equal(sha(p), before);
  assert.equal((await t.trash_list({})).entries.length, 0);
  const day = path.join(trash, '2026-10-24');
  assert.deepEqual(fs.readdirSync(day), []);
});

test('S05 a copy that is silently wrong (same size, different bytes; or short) is never trusted: original stays', async () => {
  const exdev = async () => { const e = new Error('x'); e.code = 'EXDEV'; throw e; };
  for (const corrupt of [
    (src, dst) => { const b = Buffer.from(fs.readFileSync(src)); b[0] ^= 0xff; fs.writeFileSync(dst, b); },
    (src, dst) => fs.writeFileSync(dst, fs.readFileSync(src).subarray(0, 100)),
  ]) {
    const { t, root } = setup({ renameFn: exdev, copyFileFn: async (s, d) => corrupt(s, d) });
    const p = w(root, 'v.bin', crypto.randomBytes(2000));
    const before = sha(p);
    const e = await code(t.delete({ folder: 'Footage', path: 'v.bin' }));
    assert.equal(e.code, 'BAD_ARGUMENT'); assert.match(e.message, /left the original/);
    assert.equal(sha(p), before);
  }
});
