'use strict';
// Build scripts unpack zip and tar.gz with the operating system's own tar. On a Windows runner the first "tar" on the PATH can be
// Git's GNU tar, which reads "C:\..." as a remote host ("Cannot connect to C: resolve failed"), so Windows uses System32\tar.exe by full path.
const test = require('node:test');
const assert = require('node:assert');
const { tarProgram } = require('../../lib/nlc-node/archive-tool.cjs');

test('Windows unpacks with the system tar by full path, wherever Windows is installed', () => {
  assert.equal(tarProgram('win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\tar.exe');
  assert.equal(tarProgram('win32', { SystemRoot: 'D:\\WIN' }), 'D:\\WIN\\System32\\tar.exe');
  assert.equal(tarProgram('win32', {}), 'C:\\Windows\\System32\\tar.exe', 'a missing SystemRoot falls back to the usual place');
});

test('Mac and Linux use the tar on the PATH', () => {
  assert.equal(tarProgram('darwin', { SystemRoot: 'C:\\Windows' }), 'tar');
  assert.equal(tarProgram('linux', {}), 'tar');
});
