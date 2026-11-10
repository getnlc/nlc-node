'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WINDOWS_TASK_NAME = 'NLC Node';
const MACOS_LABEL = 'com.nlc.node';
// The restart supervisor is its own launchd job beside the sign-in job (com.nlc.node, which shows the menu-bar icon).
const MACOS_SUPERVISOR_LABEL = 'com.nlc.node.supervisor';
const LINUX_UNIT = 'nlc-node.service';

// Windows PowerShell 5.1 does not load System.Security by default; without this the type is not found and the token is never sealed.
const WINDOWS_LOAD_DPAPI = 'Add-Type -AssemblyName System.Security;';
const WINDOWS_PROTECT = [
  WINDOWS_LOAD_DPAPI,
  '$plain=[Console]::In.ReadToEnd();',
  '$bytes=[Text.Encoding]::UTF8.GetBytes($plain);',
  '$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($cipher));',
].join('');
const WINDOWS_UNPROTECT = [
  WINDOWS_LOAD_DPAPI,
  '$encoded=[Console]::In.ReadToEnd();',
  '$cipher=[Convert]::FromBase64String($encoded);',
  '$bytes=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes));',
].join('');

function run(execFileSyncImpl, command, args, input) {
  return execFileSyncImpl(command, args, {
    input,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

function windowsCommand({ executablePath, argumentsList = [] }) {
  const values = [executablePath, ...argumentsList].map((value) => String(value));
  if (values.some((value) => value.includes('"') || /[\r\n]/.test(value))) throw new Error('platform_command_value_invalid');
  return values.map((value) => `"${value}"`).join(' ');
}

function posixCommand({ executablePath, argumentsList = [] }) {
  const quote = (value) => `'${String(value).replace(/'/g, `'\\\\''`)}'`;
  return [executablePath, ...argumentsList].map(quote).join(' ');
}

function xml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  })[character]);
}

function windowsSupervisorPlan({ executablePath, userSid }) {
  if (!path.win32.isAbsolute(String(executablePath || '')) || !/^S-\d(?:-\d+)+$/.test(String(userSid || ''))) {
    throw new Error('windows_supervision_identity_invalid');
  }
  const document = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(userSid)}</UserId></LogonTrigger>
    <TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${xml(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(executablePath)}</Command><Arguments>--supervised</Arguments></Exec></Actions>
</Task>
`;
  return Object.freeze({ id: 'windows-task-scheduler', taskName: WINDOWS_TASK_NAME, document });
}

function plist(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  })[character]);
}

// A POSIX-style home (/Users/x) joins with forward slashes on every host OS; a drive-style home uses the host rules.
function joinFor(home) { return String(home).startsWith('/') ? path.posix.join : path.join; }

function macosSupervisorPlan({ executablePath, homeDirectory = os.homedir(), uid = typeof process.getuid === 'function' ? process.getuid() : 0 }) {
  if (!path.posix.isAbsolute(String(executablePath || '')) || !path.isAbsolute(homeDirectory) || !Number.isInteger(uid) || uid < 0) {
    throw new Error('macos_supervision_identity_invalid');
  }
  const filePath = joinFor(homeDirectory)(homeDirectory, 'Library', 'LaunchAgents', `${MACOS_SUPERVISOR_LABEL}.plist`);
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${MACOS_SUPERVISOR_LABEL}</string>
  <key>ProgramArguments</key><array><string>${plist(executablePath)}</string><string>--supervised</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StartInterval</key><integer>300</integer>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
  return Object.freeze({ id: 'macos-launchd', label: MACOS_SUPERVISOR_LABEL, domain: `gui/${uid}`, filePath, document });
}

function systemdQuote(value) {
  if (/[\r\n]/.test(String(value))) throw new Error('linux_supervision_value_invalid');
  return `"${String(value).replace(/([\\\\"$\\`])/g, '\\\\$1')}"`;
}

function linuxSupervisorPlan({ executablePath, homeDirectory = os.homedir() }) {
  if (!path.posix.isAbsolute(String(executablePath || '')) || !path.isAbsolute(homeDirectory)) throw new Error('linux_supervision_identity_invalid');
  const filePath = joinFor(homeDirectory)(homeDirectory, '.config', 'systemd', 'user', LINUX_UNIT);
  const document = `[Unit]
Description=NLC Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(executablePath)} --supervised
Restart=on-failure
RestartSec=15
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
  return Object.freeze({ id: 'linux-systemd-user', unit: LINUX_UNIT, filePath, document });
}

function createWindowsPlatformAdapter({ execFileSyncImpl = execFileSync, fsImpl = fs } = {}) {
  return Object.freeze({
    id: 'windows',
    renderCommand: windowsCommand,
    openBrowser: async (url) => { run(execFileSyncImpl, 'rundll32.exe', ['url.dll,FileProtocolHandler', String(url)]); },
    supervision: Object.freeze({
      async install({ executablePath, stateRoot }) {
        if (!stateRoot) throw new Error('supervision_state_root_required');
        const whoami = String(run(execFileSyncImpl, 'whoami.exe', ['/user', '/fo', 'csv', '/nh'])).trim();
        const fields = [...whoami.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
        const userSid = fields.find((field) => /^S-\d(?:-\d+)+$/.test(field));
        const plan = windowsSupervisorPlan({ executablePath, userSid });
        fsImpl.mkdirSync(stateRoot, { recursive: true });
        const temporaryPath = path.join(stateRoot, 'supervision-task.xml');
        try {
          fsImpl.writeFileSync(temporaryPath, Buffer.from('\ufeff' + plan.document, 'utf16le'), { mode: 0o600 });
          run(execFileSyncImpl, 'schtasks.exe', ['/Create', '/TN', plan.taskName, '/XML', temporaryPath, '/F']);
        } finally {
          fsImpl.rmSync(temporaryPath, { force: true });
        }
        return Object.freeze({ id: plan.id, taskName: plan.taskName });
      },
      async remove() {
        try { run(execFileSyncImpl, 'schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']); } catch {}
        return Object.freeze({ removed: true, id: 'windows-task-scheduler' });
      },
    }),
    credentialProtector: Object.freeze({
      async protect(plain) {
        const output = run(execFileSyncImpl, 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROTECT], plain);
        return Buffer.from(String(output).trim(), 'base64');
      },
      async unprotect(sealed) {
        return Buffer.from(run(execFileSyncImpl, 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_UNPROTECT], Buffer.from(sealed).toString('base64')));
      },
    }),
  });
}

function macWrappingKey(execFileSyncImpl) {
  try {
    const existing = run(execFileSyncImpl, '/usr/bin/security', ['find-generic-password', '-a', 'nlc-node', '-s', 'com.nlc.node.token', '-w']);
    const key = Buffer.from(String(existing).trim(), 'base64');
    if (key.length === 32) return key;
  } catch {}
  const key = crypto.randomBytes(32);
  run(execFileSyncImpl, '/usr/bin/security', ['add-generic-password', '-U', '-a', 'nlc-node', '-s', 'com.nlc.node.token', '-w', key.toString('base64')]);
  return key;
}

function createMacosPlatformAdapter({ execFileSyncImpl = execFileSync, fsImpl = fs, homeDirectory = os.homedir(), uid = typeof process.getuid === 'function' ? process.getuid() : 0 } = {}) {
  return Object.freeze({
    id: 'macos',
    renderCommand: posixCommand,
    openBrowser: async (url) => { run(execFileSyncImpl, '/usr/bin/open', [String(url)]); },
    supervision: Object.freeze({
      async install({ executablePath }) {
        const plan = macosSupervisorPlan({ executablePath, homeDirectory, uid });
        fsImpl.mkdirSync(path.dirname(plan.filePath), { recursive: true });
        fsImpl.writeFileSync(plan.filePath, plan.document, { encoding: 'utf8', mode: 0o600 });
        try { run(execFileSyncImpl, '/bin/launchctl', ['bootout', plan.domain, plan.label]); } catch {}
        run(execFileSyncImpl, '/bin/launchctl', ['bootstrap', plan.domain, plan.filePath]);
        run(execFileSyncImpl, '/bin/launchctl', ['enable', `${plan.domain}/${plan.label}`]);
        return plan;
      },
      async remove() {
        const plan = macosSupervisorPlan({ executablePath: '/Applications/NLC Node.app/Contents/MacOS/NLC Node Host', homeDirectory, uid });
        try { run(execFileSyncImpl, '/bin/launchctl', ['bootout', plan.domain, plan.label]); } catch {}
        fsImpl.rmSync(plan.filePath, { force: true });
        return Object.freeze({ removed: true, id: plan.id });
      },
    }),
    credentialProtector: Object.freeze({
      async protect(plain) {
        const key = macWrappingKey(execFileSyncImpl);
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
      },
      async unprotect(sealed) {
        const input = Buffer.from(sealed);
        const key = macWrappingKey(execFileSyncImpl);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, input.subarray(0, 12));
        decipher.setAuthTag(input.subarray(12, 28));
        return Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]);
      },
      async clear() {
        try { run(execFileSyncImpl, '/usr/bin/security', ['delete-generic-password', '-a', 'nlc-node', '-s', 'com.nlc.node.token']); } catch {}
      },
    }),
  });
}

function createLinuxPlatformAdapter({ execFileSyncImpl = execFileSync, fsImpl = fs, homeDirectory = os.homedir() } = {}) {
  const baseArguments = ['service', 'nlc-node-token', 'account', 'default'];
  return Object.freeze({
    id: 'linux',
    renderCommand: posixCommand,
    openBrowser: async (url) => { run(execFileSyncImpl, 'xdg-open', [String(url)]); },
    supervision: Object.freeze({
      async install({ executablePath }) {
        const plan = linuxSupervisorPlan({ executablePath, homeDirectory });
        fsImpl.mkdirSync(path.dirname(plan.filePath), { recursive: true });
        fsImpl.writeFileSync(plan.filePath, plan.document, { encoding: 'utf8', mode: 0o600 });
        run(execFileSyncImpl, 'systemctl', ['--user', 'daemon-reload']);
        run(execFileSyncImpl, 'systemctl', ['--user', 'enable', '--now', plan.unit]);
        return plan;
      },
      async remove() {
        try { run(execFileSyncImpl, 'systemctl', ['--user', 'disable', '--now', LINUX_UNIT]); } catch {}
        const plan = linuxSupervisorPlan({ executablePath: '/opt/nlc/NLC Node Host', homeDirectory });
        fsImpl.rmSync(plan.filePath, { force: true });
        try { run(execFileSyncImpl, 'systemctl', ['--user', 'daemon-reload']); } catch {}
        return Object.freeze({ removed: true, id: plan.id });
      },
    }),
    credentialProtector: Object.freeze({
      async protect(plain) {
        run(execFileSyncImpl, 'secret-tool', ['store', '--label=NLC Node', ...baseArguments], plain);
        return Buffer.from('secret-tool:v1');
      },
      async unprotect() {
        return Buffer.from(run(execFileSyncImpl, 'secret-tool', ['lookup', ...baseArguments]));
      },
      async clear() {
        try { run(execFileSyncImpl, 'secret-tool', ['clear', ...baseArguments]); } catch {}
      },
    }),
  });
}

const PLATFORM_FACTORIES = Object.freeze({
  win32: createWindowsPlatformAdapter,
  darwin: createMacosPlatformAdapter,
  linux: createLinuxPlatformAdapter,
});

function selectPlatformAdapter({ platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
  const factory = PLATFORM_FACTORIES[platform];
  if (!factory) throw new Error('platform_unsupported');
  return factory({ execFileSyncImpl });
}

module.exports = {
  createLinuxPlatformAdapter,
  createMacosPlatformAdapter,
  createWindowsPlatformAdapter,
  linuxSupervisorPlan,
  macosSupervisorPlan,
  posixCommand,
  selectPlatformAdapter,
  windowsCommand,
  windowsSupervisorPlan,
};
