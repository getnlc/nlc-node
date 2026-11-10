'use strict';
// The tar program the build scripts use to unpack zip and tar.gz files.
const path = require('node:path');

function tarProgram(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'tar';
  return path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

module.exports = { tarProgram };
