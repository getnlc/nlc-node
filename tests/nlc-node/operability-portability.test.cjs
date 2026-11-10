'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { run } = require('../../lib/nlc-node/index.cjs');

test('a new platform adapter installs through the shared runtime without a platform branch', async () => {
  const calls = [];
  const fixturePlatform = {
    id: 'fixture-platform',
    supervision: {
      async install(input) { calls.push(input); return { id: 'fixture-supervisor' }; },
      async remove() { return { removed: true }; },
    },
  };
  const result = await run({
    argumentsList: ['--install-supervision'],
    platformAdapter: fixturePlatform,
    executablePath: '/opt/nlc/NLC Node Host',
    stateRoot: '/fixture/state',
  });
  assert.deepEqual(result, { id: 'fixture-supervisor' });
  assert.deepEqual(calls, [{ executablePath: '/opt/nlc/NLC Node Host', stateRoot: '/fixture/state' }]);
});
