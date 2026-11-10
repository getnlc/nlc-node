'use strict';
// Test helper: make a link the way each OS allows an ordinary (non-admin) user to.
// - POSIX: a symlink.
// - Windows, target is a folder: a junction (the real Windows case; needs no privilege).
// - Windows, target is a file or does not exist: a file symlink, which an ordinary Windows user may not create (EPERM).
//   In that case this returns false and says so on stderr; the caller then skips only the assertions that need that link.
const fs = require('node:fs');

function isFolder(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

function makeLink(target, linkPath) {
  if (process.platform !== 'win32') { fs.symlinkSync(target, linkPath); return true; }
  if (isFolder(target)) { fs.symlinkSync(target, linkPath, 'junction'); return true; }
  try { fs.symlinkSync(target, linkPath, 'file'); return true; } catch (error) {
    if (error && error.code === 'EPERM') {
      process.stderr.write(`NOTE: skipped a file-symlink check: Windows refused to create a file symlink for an ordinary user (EPERM): ${linkPath}\n`);
      return false;
    }
    throw error;
  }
}

module.exports = { makeLink };
