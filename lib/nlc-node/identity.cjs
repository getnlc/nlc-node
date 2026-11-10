'use strict';

const NODE_API_VERSION = 'nlc-node/v1';
const MODULE_API_VERSION = 'nlc-node.module/v1';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function assertVersion(version, label = 'version') {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`NLC Node ${label} must be a semantic version.`);
  }
  return version;
}

function createIdentity({ version, lifecycle = 'idle' }) {
  return Object.freeze({
    id: 'nlc-node',
    apiVersion: NODE_API_VERSION,
    version: assertVersion(version),
    lifecycle,
  });
}

module.exports = {
  MODULE_API_VERSION,
  NODE_API_VERSION,
  VERSION_PATTERN,
  assertVersion,
  createIdentity,
};
