'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeLink } = require('./_links.cjs');
const test = require('node:test');
const { createGrants, FORBIDDEN_MESSAGE } = require('../../lib/nlc-node/grants.cjs');

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-grants-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const stateDir = path.join(base, 'state');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, 'Documents', 'Footage'), { recursive: true });
  return { base, stateDir, home, footage: path.join(home, 'Documents', 'Footage') };
}
const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
async function refusedPlain(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message) assert.equal(error.message, message);
    assert.doesNotMatch(error.message, /\n\s+at |ENOENT|EACCES/);
    return true;
  });
}

test('before any folder is shared the list is empty, and a damaged file is treated as empty (G04)', (t) => {
  const { stateDir, home } = sandbox(t);
  assert.deepEqual(createGrants({ stateDir, homeDir: home }).list(), []);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'grants.json'), '{ not json');
  const grants = createGrants({ stateDir, homeDir: home });
  assert.deepEqual(grants.list(), []);
  assert.equal(grants.isPaused(), false);
});

test('adding a folder stores label, real path and time, keeps it across restarts, and the same folder is not added twice', async (t) => {
  const { stateDir, home, footage } = sandbox(t);
  const grants = createGrants({ stateDir, homeDir: home });
  const added = await grants.add(footage);
  assert.equal(added.label, 'Footage');
  assert.equal(added.path, footage);
  assert.ok(!Number.isNaN(Date.parse(added.addedAt)));
  assert.deepEqual((await grants.add(footage + path.sep)).label, 'Footage');
  assert.equal(grants.list().length, 1);
  const reopened = createGrants({ stateDir, homeDir: home });
  assert.deepEqual(reopened.list(), grants.list());
  const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, 'grants.json'), 'utf8'));
  assert.deepEqual(onDisk.grants.map((g) => Object.keys(g).sort()), [['addedAt', 'id', 'label', 'path']]);
});

test('labels are unique even when folder names repeat or differ only by case', async (t) => {
  const { stateDir, home } = sandbox(t);
  const grants = createGrants({ stateDir, homeDir: home });
  const a = mk(path.join(home, 'a', 'Footage'));
  const b = mk(path.join(home, 'b', 'Footage'));
  const c = mk(path.join(home, 'c', 'footage'));
  assert.equal((await grants.add(a)).label, 'Footage');
  assert.equal((await grants.add(b)).label, 'Footage 2');
  assert.equal((await grants.add(c)).label, 'footage 3');
  assert.deepEqual(grants.list().map((g) => g.label), ['Footage', 'Footage 2', 'footage 3']);
  grants.remove('Footage 2');
  assert.equal((await grants.add(mk(path.join(home, 'd', 'Footage')))).label, 'Footage 2');
});

test('system locations, the profile, the root and the Node state folder are refused with a plain message (G02, real folders)', async (t) => {
  const { base, stateDir, home } = sandbox(t);
  const grants = createGrants({ stateDir, homeDir: home });
  mk(path.join(stateDir, 'inner'));
  const toRoot = path.join(base, 'link-to-root');
  makeLink(path.parse(base).root, toRoot); // a link to the drive / filesystem root must not get past the check
  const system = process.platform === 'win32'
    ? [path.parse(base).root, process.env.SystemRoot, process.env.ProgramFiles]
    : ['/', '/etc', '/usr/bin', path.dirname(home) === '/' ? '/' : '/home'];
  for (const bad of [...system, home, toRoot]) {
    if (!bad || !fs.existsSync(bad)) continue;
    await refusedPlain(grants.add(bad), 'BAD_ARGUMENT', FORBIDDEN_MESSAGE);
  }
  await assert.rejects(grants.add(stateDir), (error) => { assert.equal(error.code, 'BAD_ARGUMENT'); assert.match(error.message, /belongs to NLC Node/); return true; });
  await assert.rejects(grants.add(path.join(stateDir, 'inner')), /belongs to NLC Node/);
  assert.deepEqual(grants.list(), []);
});

function simulated(platform, home, env = {}) {
  const dirs = new Set();
  const fsImpl = {
    async realpath(p) { return p; },
    async stat(p) { return { isDirectory: () => !dirs.has('file:' + p) }; },
  };
  return { make: (t) => createGrants({ stateDir: sandbox(t).stateDir, platform, homeDir: home, env, fsImpl }), dirs };
}

test('Windows: drive roots, the profile, Windows and Program Files are refused; a normal folder works (G02)', async (t) => {
  const sim = simulated('win32', 'C:\\Users\\Jo', { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' });
  const grants = sim.make(t);
  for (const bad of ['C:\\', 'c:/', 'D:\\', 'C:\\Users\\Jo', 'c:\\users\\jo\\', 'C:\\Users', 'C:\\Windows', 'c:\\windows\\System32', 'C:\\WINDOWS\\', 'C:\\Program Files', 'C:\\Program Files (x86)\\Vendor', 'C:\\Program Files\\App\\bin', '\\\\?\\C:\\Windows', '\\\\server\\share']) {
    await refusedPlain(grants.add(bad), 'BAD_ARGUMENT', FORBIDDEN_MESSAGE);
  }
  assert.equal((await grants.add('C:\\Users\\Jo\\Documents\\Footage')).label, 'Footage');
  assert.equal((await grants.add('D:\\Projects\\Footage')).label, 'Footage 2');
  assert.equal((await grants.add('c:/users/jo/documents/footage')).label, 'Footage', 'same folder, different spelling');
  assert.equal((await grants.add('C:\\Program Files Backup\\x')).label, 'x', 'look-alike names are fine');
  assert.equal(grants.list().length, 3);
});

test('macOS: /, /System, /Library, /Applications, /Users and the home folder are refused; Movies/Footage works (G02)', async (t) => {
  const grants = simulated('darwin', '/Users/jo').make(t);
  for (const bad of ['/', '/System', '/System/Library/Fonts', '/Library', '/Library/Application Support', '/Applications', '/Applications/Safari.app', '/Users', '/Users/jo', '/users/JO/', '/Volumes', '/usr/local']) {
    await refusedPlain(grants.add(bad), 'BAD_ARGUMENT', FORBIDDEN_MESSAGE);
  }
  assert.equal((await grants.add('/Users/jo/Movies/Footage')).label, 'Footage');
  assert.equal((await grants.add('/Volumes/USB Drive/Footage')).label, 'Footage 2');
  assert.equal((await grants.add('/Users/jo/Library/Application Support/Thing')).label, 'Thing', 'the user Library is not /Library');
});

test('a missing folder, a file, a relative path and empty input get plain messages', async (t) => {
  const { stateDir, home, footage } = sandbox(t);
  const grants = createGrants({ stateDir, homeDir: home });
  fs.writeFileSync(path.join(footage, 'a.txt'), 'x');
  await refusedPlain(grants.add(path.join(home, 'nope')), 'NOT_FOUND', 'That folder could not be found.');
  await refusedPlain(grants.add(path.join(footage, 'a.txt')), 'BAD_ARGUMENT', 'That is a file. Choose a folder to share.');
  await refusedPlain(grants.add('Footage'), 'BAD_ARGUMENT');
  await refusedPlain(grants.add(''), 'BAD_ARGUMENT');
  await refusedPlain(grants.add(undefined), 'BAD_ARGUMENT');
});

test('removing a grant drops it for good, matching the name in any letter case (G03)', async (t) => {
  const { stateDir, home, footage } = sandbox(t);
  const grants = createGrants({ stateDir, homeDir: home });
  await grants.add(footage);
  await grants.add(mk(path.join(home, 'Music')));
  assert.equal(grants.remove('FOOTAGE').label, 'Footage');
  assert.deepEqual(grants.list().map((g) => g.label), ['Music']);
  assert.deepEqual(createGrants({ stateDir, homeDir: home }).list().map((g) => g.label), ['Music']);
  assert.throws(() => grants.remove('Footage'), (error) => error.code === 'NOT_FOUND' && /not shared/.test(error.message));
});

test('pause is remembered across restarts and resume needs nothing else (S06 state)', async (t) => {
  const { stateDir, home, footage } = sandbox(t);
  const grants = createGrants({ stateDir, homeDir: home });
  await grants.add(footage);
  assert.equal(grants.isPaused(), false);
  grants.setPaused(true);
  assert.equal(grants.isPaused(), true);
  const reopened = createGrants({ stateDir, homeDir: home });
  assert.equal(reopened.isPaused(), true);
  assert.equal(reopened.list().length, 1);
  reopened.setPaused(false);
  assert.equal(createGrants({ stateDir, homeDir: home }).isPaused(), false);
  assert.equal(createGrants({ stateDir, homeDir: home }).list().length, 1);
});

test('listeners hear about every change, can stop listening, and cannot break the store', async (t) => {
  const { stateDir, home, footage } = sandbox(t);
  const grants = createGrants({ stateDir, homeDir: home });
  const seen = [];
  const stop = grants.onChange((event) => seen.push(event.change.type));
  grants.onChange(() => { throw new Error('listener bug'); });
  await grants.add(footage);
  grants.setPaused(true);
  grants.setPaused(true);
  grants.remove('Footage');
  assert.deepEqual(seen, ['added', 'paused', 'removed']);
  stop();
  grants.setPaused(false);
  assert.equal(seen.length, 3);
});

test('a write that fails half way leaves the old file intact, no temp files, and the store unchanged', async (t) => {
  const { stateDir, home, footage } = sandbox(t);
  let failRename = false;
  let failWrite = false;
  const flaky = Object.create(fs);
  flaky.renameSync = (...args) => { if (failRename) throw new Error('disk full'); return fs.renameSync(...args); };
  flaky.writeFileSync = (...args) => { if (failWrite && typeof args[0] === 'number') { fs.writeSync(args[0], '{"partial'); throw new Error('power cut'); } return fs.writeFileSync(...args); };
  const grants = createGrants({ stateDir, homeDir: home, fsApi: flaky });
  await grants.add(footage);
  const before = fs.readFileSync(path.join(stateDir, 'grants.json'), 'utf8');
  const music = mk(path.join(home, 'Music'));
  failRename = true;
  await assert.rejects(grants.add(music), /disk full/);
  failRename = false; failWrite = true;
  assert.throws(() => grants.setPaused(true), /power cut/);
  failWrite = false;
  assert.equal(fs.readFileSync(path.join(stateDir, 'grants.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(stateDir), ['grants.json']);
  assert.deepEqual(grants.list().map((g) => g.label), ['Footage']);
  assert.equal(grants.isPaused(), false);
  assert.equal((await grants.add(music)).label, 'Music');
  assert.deepEqual(createGrants({ stateDir, homeDir: home }).list().map((g) => g.label), ['Footage', 'Music']);
});
