'use strict';

// Cross-architecture SEA builds (macOS x64 is built on an arm64 runner). Drives the real build entry point.
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSea, currentTarget } = require('../../scripts/nlc-node/build-sea.cjs');

const foreignTarget = currentTarget() === 'macos-arm64' ? 'macos-x64' : 'macos-arm64';

test('a SEA for another architecture is refused unless the matching Node binary is supplied, and the message says so', () => {
  assert.throws(
    () => buildSea({ target: foreignTarget, outputDir: path.join(os.tmpdir(), 'nlc-node-sea-refused') }),
    /--node-binary/,
  );
});

test('a supplied Node binary that is missing is refused in plain words before anything is built', () => {
  assert.throws(
    () => buildSea({ target: foreignTarget, nodeBinary: path.join(os.tmpdir(), 'nlc-node-no-such-node'), outputDir: path.join(os.tmpdir(), 'nlc-node-sea-refused') }),
    /Node binary .* cannot be used/,
  );
});
