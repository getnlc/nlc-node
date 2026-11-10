'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createLinuxPlatformAdapter,
  createMacosPlatformAdapter,
  createWindowsPlatformAdapter,
  linuxSupervisorPlan,
  macosSupervisorPlan,
  invocationShouldExit,
  supervisionManagementArguments,
  windowsSupervisorPlan,
} = require('../../lib/nlc-node/index.cjs');

test('Windows supervision is one per-user native task that starts the Host directly and restarts failures', () => {
  const plan = windowsSupervisorPlan({
    executablePath: 'C:\\Program Files\\NLC Node\\NLC Node Host.exe',
    userSid: 'S-1-5-21-123-456-789-1001',
  });
  assert.equal(plan.id, 'windows-task-scheduler');
  assert.equal(plan.taskName, 'NLC Node');
  assert.match(plan.document, /<LogonTrigger>/);
  assert.match(plan.document, /<UserId>S-1-5-21-123-456-789-1001<\/UserId>/);
  assert.match(plan.document, /<Command>C:\\Program Files\\NLC Node\\NLC Node Host\.exe<\/Command>/);
  assert.match(plan.document, /<Arguments>--supervised<\/Arguments>/);
  assert.match(plan.document, /<RestartOnFailure>/);
  assert.match(plan.document, /<Count>999<\/Count>/);
  assert.doesNotMatch(plan.document, /powershell|pwsh|cmd\.exe|wsl\.exe|WindowsTerminal/i);
});

test('macOS and Linux supervision are native per-user declarations for the same unchanged Host', () => {
  const executablePath = '/opt/nlc/NLC Node Host';
  const mac = macosSupervisorPlan({ executablePath, homeDirectory: '/Users/customer', uid: 501 });
  assert.equal(mac.filePath, '/Users/customer/Library/LaunchAgents/com.nlc.node.supervisor.plist');
  assert.match(mac.document, /<string>\/opt\/nlc\/NLC Node Host<\/string>/);
  assert.match(mac.document, /<string>--supervised<\/string>/);
  assert.match(mac.document, /<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/, 'a clean exit (Quit) is not restarted; a crash is');
  assert.match(mac.document, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/, 'and a check every 5 minutes, like Windows');
  assert.equal(mac.label, 'com.nlc.node.supervisor', 'a separate job from the sign-in job');
  assert.equal(mac.domain, 'gui/501');

  const linux = linuxSupervisorPlan({ executablePath, homeDirectory: '/home/customer' });
  assert.equal(linux.filePath, '/home/customer/.config/systemd/user/nlc-node.service');
  assert.match(linux.document, /ExecStart="\/opt\/nlc\/NLC Node Host" --supervised/);
  assert.match(linux.document, /Restart=on-failure/);
  assert.match(linux.document, /WantedBy=default\.target/);
});

test('platform adapters own installation and removal of their native supervisor', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-supervision-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));

  const windowsCalls = [];
  const windows = createWindowsPlatformAdapter({
    execFileSyncImpl(command, args) {
      windowsCalls.push({ command, args });
      if (command === 'whoami.exe') return Buffer.from('"CUSTOMER\\User","S-1-5-21-1-2-3-1001"\r\n');
      return Buffer.alloc(0);
    },
  });
  await windows.supervision.install({ executablePath: 'C:\\NLC Node\\NLC Node Host.exe', stateRoot });
  await windows.supervision.remove();
  assert.deepEqual(windowsCalls.filter((call) => call.command === 'schtasks.exe').map((call) => call.args[0]), ['/Create', '/Delete']);
  assert.equal(fs.existsSync(path.join(stateRoot, 'supervision-task.xml')), false);

  const macCalls = [];
  const macHome = path.join(stateRoot, 'mac-home');
  const mac = createMacosPlatformAdapter({
    execFileSyncImpl(command, args) { macCalls.push({ command, args }); return Buffer.alloc(0); },
    homeDirectory: macHome,
    uid: 501,
  });
  const macReceipt = await mac.supervision.install({ executablePath: '/Applications/NLC Node.app/Contents/MacOS/NLC Node Host' });
  assert.equal(fs.existsSync(macReceipt.filePath), true);
  await mac.supervision.remove();
  assert.equal(fs.existsSync(macReceipt.filePath), false);
  assert.equal(macCalls.some((call) => call.command === '/bin/launchctl' && call.args[0] === 'bootstrap'), true);

  const linuxCalls = [];
  const linuxHome = path.join(stateRoot, 'linux-home');
  const linux = createLinuxPlatformAdapter({
    execFileSyncImpl(command, args) { linuxCalls.push({ command, args }); return Buffer.alloc(0); },
    homeDirectory: linuxHome,
  });
  const linuxReceipt = await linux.supervision.install({ executablePath: '/opt/nlc/NLC Node Host' });
  assert.equal(fs.existsSync(linuxReceipt.filePath), true);
  await linux.supervision.remove();
  assert.equal(fs.existsSync(linuxReceipt.filePath), false);
  assert.equal(linuxCalls.some((call) => call.command === 'systemctl' && call.args.join(' ') === '--user enable --now nlc-node.service'), true);
});

test('runtime exposes generic supervision management without a platform branch', () => {
  assert.deepEqual(supervisionManagementArguments(['--install-supervision']), {
    install: true,
    remove: false,
  });
  assert.deepEqual(supervisionManagementArguments(['--remove-supervision']), {
    install: false,
    remove: true,
  });
});

test('bounded Host invocations are classified for explicit packaged-process exit', () => {
  for (const argumentsList of [
    ['--install-supervision'],
    ['--remove-supervision'],
    ['--stop'],
    ['--diagnose'],
  ]) assert.equal(invocationShouldExit(argumentsList), true, argumentsList.join(' '));
  assert.equal(invocationShouldExit([]), false);
});


test('Windows supervision also starts the Host again every 5 minutes when none is running, whoever started the last one', () => {
  const plan = windowsSupervisorPlan({
    executablePath: 'C:\\Users\\Customer\\AppData\\Local\\Programs\\NLC Node\\NLC Node Host.exe',
    userSid: 'S-1-5-21-123-456-789-1001',
  });
  assert.match(plan.document, /<TimeTrigger>[\s\S]*<Repetition>[\s\S]*<Interval>PT5M<\/Interval>[\s\S]*<\/Repetition>[\s\S]*<\/TimeTrigger>/);
  assert.match(plan.document, /<LogonTrigger>/);
  assert.match(plan.document, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.doesNotMatch(plan.document, /<StopAtDurationEnd>true/);
});

test('every Windows task interval is one minute or longer (Task Scheduler rejects the whole task below that)', () => {
  const plan = windowsSupervisorPlan({
    executablePath: 'C:\\Users\\Customer\\AppData\\Local\\Programs\\NLC Node\\NLC Node Host.exe',
    userSid: 'S-1-5-21-123-456-789-1001',
  });
  const intervals = [...plan.document.matchAll(/<Interval>PT(\d+)([SM])<\/Interval>/g)];
  assert.ok(intervals.length >= 2);
  for (const [, amount, unit] of intervals) assert.ok(unit === 'M' && Number(amount) >= 1, `interval PT${amount}${unit} is below the one-minute minimum`);
});
