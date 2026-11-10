'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createCredentialStore,
  createLinuxPlatformAdapter,
  createMacosPlatformAdapter,
  createWindowsPlatformAdapter,
  selectPlatformAdapter,
} = require('../../lib/nlc-node/index.cjs');

function temporaryState(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-node-credential-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the credential store persists only protected bytes and round-trips the machine token', async (t) => {
  const stateRoot = temporaryState(t);
  const protector = {
    async protect(plain) { return Buffer.from(`sealed:${plain.toString('base64')}`); },
    async unprotect(sealed) { return Buffer.from(sealed.toString().slice('sealed:'.length), 'base64'); },
  };
  const store = createCredentialStore({ stateRoot, protector });
  const credential = {
    origin: 'https://customer.example',
    machineId: 'machine-1',
    token: 'token-secret-value',
    expiresAt: '2026-11-01T00:00:00.000Z',
  };
  await store.save(credential);
  const stored = fs.readFileSync(path.join(stateRoot, 'node-credential.bin'));
  assert.equal(stored.includes(Buffer.from('token-secret-value')), false);
  assert.deepEqual(await store.load(), credential);
  await assert.rejects(store.save({ origin: 'https://customer.example' }), /node_credential_invalid/);
  await store.clear();
  assert.equal(await store.load(), null);
});

test('the Windows adapter uses current-user DPAPI with hidden PowerShell and never places a credential in arguments', async () => {
  const calls = [];
  const adapter = createWindowsPlatformAdapter({
    execFileSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      if (String(options.input).startsWith('secret-value')) return Buffer.from('c2VhbGVk');
      return Buffer.from('secret-value');
    },
  });
  const sealed = await adapter.credentialProtector.protect(Buffer.from('secret-value'));
  assert.equal((await adapter.credentialProtector.unprotect(sealed)).toString(), 'secret-value');
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.command.toLowerCase().endsWith('powershell.exe')), true);
  assert.equal(calls.every((call) => call.options.windowsHide === true), true);
  assert.equal(calls.some((call) => call.args.join(' ').includes('secret-value')), false);
  assert.match(calls[0].args.join(' '), /DataProtectionScope\]::CurrentUser/);
});

test('macOS and Linux secure-store adapters keep secrets on stdin rather than command arguments', async () => {
  const macCalls = [];
  let macKey = '';
  const mac = createMacosPlatformAdapter({
    execFileSyncImpl(command, args, options) {
      macCalls.push({ command, args, options });
      if (args.includes('add-generic-password')) macKey = args.at(-1);
      return args.includes('find-generic-password') ? Buffer.from(macKey) : Buffer.alloc(0);
    },
  });
  const macSealed = await mac.credentialProtector.protect(Buffer.from('mac-secret'));
  assert.equal((await mac.credentialProtector.unprotect(macSealed)).toString(), 'mac-secret');
  assert.equal(macCalls.some((call) => call.args.join(' ').includes('mac-secret')), false);
  assert.equal(macCalls.some((call) => call.options?.input?.toString() === 'mac-secret'), false);

  const linuxCalls = [];
  const linux = createLinuxPlatformAdapter({
    execFileSyncImpl(command, args, options) {
      linuxCalls.push({ command, args, options });
      return args.includes('lookup') ? Buffer.from('linux-secret') : Buffer.alloc(0);
    },
  });
  await linux.credentialProtector.protect(Buffer.from('linux-secret'));
  assert.equal((await linux.credentialProtector.unprotect()).toString(), 'linux-secret');
  assert.equal(linuxCalls.some((call) => call.args.join(' ').includes('linux-secret')), false);
  assert.equal(linuxCalls[0].options.input.toString(), 'linux-secret');
});

test('platform selection is data-isolated from the shared Connector core', () => {
  const runner = () => Buffer.alloc(0);
  assert.equal(selectPlatformAdapter({ platform: 'win32', execFileSyncImpl: runner }).id, 'windows');
  assert.equal(selectPlatformAdapter({ platform: 'darwin', execFileSyncImpl: runner }).id, 'macos');
  assert.equal(selectPlatformAdapter({ platform: 'linux', execFileSyncImpl: runner }).id, 'linux');
  assert.throws(() => selectPlatformAdapter({ platform: 'aix', execFileSyncImpl: runner }), /platform_unsupported/);
});

test('platform adapters render the same controlled Connector command through native quoting only', () => {
  const runner = () => Buffer.alloc(0);
  const input = { executablePath: '/Product/NLC Node Host', argumentsList: ['--lifecycle-runtime', 'codex'] };
  assert.equal(createWindowsPlatformAdapter({ execFileSyncImpl: runner }).renderCommand(input), '"/Product/NLC Node Host" "--lifecycle-runtime" "codex"');
  assert.equal(createMacosPlatformAdapter({ execFileSyncImpl: runner }).renderCommand(input), "'/Product/NLC Node Host' '--lifecycle-runtime' 'codex'");
  assert.equal(createLinuxPlatformAdapter({ execFileSyncImpl: runner }).renderCommand(input), "'/Product/NLC Node Host' '--lifecycle-runtime' 'codex'");
  assert.throws(() => createWindowsPlatformAdapter({ execFileSyncImpl: runner }).renderCommand({ executablePath: 'bad"path' }), /invalid/);
});


test('on a real Windows PC the sign-in store seals the token with DPAPI and gives it back', { skip: process.platform !== 'win32' }, async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nlc-cred-real-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const { createWindowsPlatformAdapter } = require('../../lib/nlc-node/platform-adapters.cjs');
  const store = createCredentialStore({ stateRoot, protector: createWindowsPlatformAdapter().credentialProtector });
  const credential = { origin: 'https://customer.example', machineId: 'machine-1', token: 'tok-' + 'ab12cd34'.repeat(8), expiresAt: '2026-11-01T00:00:00.000Z' };
  await store.save(credential);
  const onDisk = fs.readdirSync(stateRoot).map((n) => fs.readFileSync(path.join(stateRoot, n)).toString('latin1')).join('\n');
  assert.equal(onDisk.includes(credential.token), false, 'the token is not readable on disk');
  assert.deepEqual(await store.load(), credential);
});
