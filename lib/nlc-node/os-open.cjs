'use strict';
// Opens a folder in Finder / File Explorer, or a web address in the person's browser. Only these two jobs.
const { spawn } = require('node:child_process');

function command(platform, target) {
  if (platform === 'win32') return { file: 'explorer.exe', args: [target] };
  if (platform === 'darwin') return { file: 'open', args: [target] };
  throw new Error('Opening is available on Windows and Mac.');
}

function launch(platform, target, run = spawn) {
  const { file, args } = command(platform, target);
  const child = run(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
  if (child && child.on) child.on('error', () => {});
  if (child && child.unref) child.unref();
}

function openFolder(folder, platform = process.platform, run) { launch(platform, folder, run); }
function openAddress(address, platform = process.platform, run) {
  if (!/^https:\/\//i.test(address)) throw new Error('Only a secure web address can be opened.');
  if (platform === 'win32') {
    const child = (run || spawn)('rundll32.exe', ['url.dll,FileProtocolHandler', address], { detached: true, stdio: 'ignore', windowsHide: true });
    if (child && child.on) child.on('error', () => {});
    if (child && child.unref) child.unref();
    return;
  }
  launch(platform, address, run);
}

module.exports = { openFolder, openAddress, command };
