'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickFolder, pickAndShare } = require('../../lib/nlc-node/picker.cjs');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function fakeRun(reply) {
  const calls = [];
  const run = async (command, args) => { calls.push({ command, args }); return typeof reply === 'function' ? reply(command, args) : reply; };
  run.calls = calls;
  return run;
}

test('Windows: opens the folder dialog through PowerShell and returns the chosen path', async () => {
  const run = fakeRun({ code: 0, stdout: `OK:${b64('D:\\Videos\\Footage')}`, stderr: '' });
  assert.equal(await pickFolder({ platform: 'win32', run }), 'D:\\Videos\\Footage');
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].command, 'powershell.exe');
  assert.ok(run.calls[0].args.includes('-STA'));
  assert.match(run.calls[0].args.at(-1), /FolderBrowserDialog/);
});

test('Windows: cancel returns null', async () => {
  assert.equal(await pickFolder({ platform: 'win32', run: fakeRun({ code: 0, stdout: 'CANCEL', stderr: '' }) }), null);
  assert.equal(await pickFolder({ platform: 'win32', run: fakeRun({ code: 1, stdout: '', stderr: 'boom' }) }), null);
});

test('Windows: spaces, accents and emoji survive; trailing slash removed; drive root keeps its slash', async () => {
  const unicode = 'C:\\Users\\José\\Mes vidéos 🎬\\';
  assert.equal(await pickFolder({ platform: 'win32', run: fakeRun({ code: 0, stdout: `OK:${b64(unicode)}\r\n`, stderr: '' }) }), 'C:\\Users\\José\\Mes vidéos 🎬');
  assert.equal(await pickFolder({ platform: 'win32', run: fakeRun({ code: 0, stdout: `OK:${b64('c:')}`, stderr: '' }) }), 'C:\\');
});

test('macOS: opens the choose-folder panel through osascript and strips the trailing slash', async () => {
  const run = fakeRun({ code: 0, stdout: '/Users/amy/Movies/My Footage/\n', stderr: '' });
  assert.equal(await pickFolder({ platform: 'darwin', run }), '/Users/amy/Movies/My Footage');
  assert.equal(run.calls[0].command, 'osascript');
  assert.equal(run.calls[0].args[0], '-e');
  assert.match(run.calls[0].args[1], /^POSIX path of \(choose folder/);
});

test('macOS: cancel (exit 1, User canceled) returns null; unicode path works', async () => {
  assert.equal(await pickFolder({ platform: 'darwin', run: fakeRun({ code: 1, stdout: '', stderr: '0:42: execution error: User canceled. (-128)' }) }), null);
  assert.equal(await pickFolder({ platform: 'darwin', run: fakeRun({ code: 0, stdout: '/Users/zoë/Vidéos 🎬/\n', stderr: '' }) }), '/Users/zoë/Vidéos 🎬');
});

test('an unsupported platform gives a plain message', async () => {
  await assert.rejects(() => pickFolder({ platform: 'linux', run: fakeRun({}) }), /Windows and Mac/);
});

test('pickAndShare: chosen folder reaches grants.add and comes back as added', async () => {
  const added = [];
  const grants = { add: async (p) => { added.push(p); return { label: 'Footage', path: p, addedAt: 'now' }; } };
  const out = await pickAndShare({ grants, platform: 'darwin', run: fakeRun({ code: 0, stdout: '/Users/amy/Footage/\n', stderr: '' }) });
  assert.deepEqual(added, ['/Users/amy/Footage']);
  assert.equal(out.status, 'added');
  assert.equal(out.grant.label, 'Footage');
});

test('pickAndShare: cancel adds nothing; a refused system folder shows the grants message', async () => {
  let called = 0;
  const grants = { add: async () => { called += 1; throw new Error('Choose a folder for your work, not a system location.'); } };
  assert.deepEqual(await pickAndShare({ grants, platform: 'win32', run: fakeRun({ code: 0, stdout: 'CANCEL', stderr: '' }) }), { status: 'cancelled' });
  assert.equal(called, 0);
  const refused = await pickAndShare({ grants, platform: 'win32', run: fakeRun({ code: 0, stdout: `OK:${b64('C:\\Windows')}`, stderr: '' }) });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.message, 'Choose a folder for your work, not a system location.');
});
