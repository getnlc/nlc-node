'use strict';

// Native folder picker. Script route only (PowerShell on Windows, osascript on macOS),
// so no native rebuild of the launchers is needed. The customer chooses the folder;
// the result goes to grants.add().

const { execFile } = require('node:child_process');

const PROMPT = 'Choose a folder to share with your assistant';

// Output is base64 so accents, emoji and any code page survive the pipe.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
  '$owner.Size = New-Object System.Drawing.Size(1, 1)',
  '$owner.Opacity = 0',
  '$owner.Show()',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  `$dialog.Description = '${PROMPT}'`,
  '$dialog.ShowNewFolderButton = $true',
  '$result = $dialog.ShowDialog($owner)',
  '$owner.Close()',
  "if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {",
  "  [Console]::Out.Write('OK:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))",
  '} else {',
  "  [Console]::Out.Write('CANCEL')",
  '}',
].join('\n');

const MAC_SCRIPT = `POSIX path of (choose folder with prompt "${PROMPT}")`;

function defaultRun(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function buildCommand(platform) {
  if (platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT] };
  }
  if (platform === 'darwin') {
    return { command: 'osascript', args: ['-e', MAC_SCRIPT] };
  }
  throw new Error('Choosing a folder is available on Windows and Mac.');
}

function normalizeWindows(raw) {
  let value = raw.trim();
  if (!value) return null;
  value = value.replace(/\//g, '\\');
  if (/^[A-Za-z]:\\?$/.test(value)) return `${value[0].toUpperCase()}:\\`;
  return value.replace(/\\+$/, '');
}

function normalizeMac(raw) {
  const value = raw.replace(/[\r\n]+$/, '').trim();
  if (!value.startsWith('/')) return null;
  if (value === '/') return '/';
  return value.replace(/\/+$/, '');
}

async function pickFolder({ platform = process.platform, run = defaultRun } = {}) {
  const { command, args } = buildCommand(platform);
  const result = await run(command, args);
  const stdout = String((result && result.stdout) || '');
  if (platform === 'win32') {
    const text = stdout.trim();
    if (!text.startsWith('OK:')) return null;
    let decoded;
    try { decoded = Buffer.from(text.slice(3), 'base64').toString('utf8'); } catch { return null; }
    return normalizeWindows(decoded);
  }
  // macOS: Cancel makes osascript exit 1 with "User canceled. (-128)" and no output.
  if (!result || result.code !== 0) return null;
  return normalizeMac(stdout);
}

// Ask the customer for a folder and share it. Never throws for a cancel or a refused folder.
async function pickAndShare({ grants, platform, run } = {}) {
  let chosen;
  try {
    chosen = await pickFolder({ platform, run });
  } catch (error) {
    return { status: 'error', message: error.message };
  }
  if (!chosen) return { status: 'cancelled' };
  try {
    const grant = await grants.add(chosen);
    return { status: 'added', grant };
  } catch (error) {
    return { status: 'refused', message: error.message || 'Choose a folder for your work, not a system location.' };
  }
}

module.exports = { pickFolder, pickAndShare, buildCommand };
