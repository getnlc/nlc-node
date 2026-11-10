'use strict';

const { MODULE_API_VERSION, assertVersion } = require('./identity.cjs');

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

function invalid(message) {
  const error = new Error(message);
  error.code = 'NLC_NODE_INVALID_MODULE';
  return error;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw invalid('NLC Node module manifest must be an object.');
  }
  if (manifest.apiVersion !== MODULE_API_VERSION) {
    throw invalid(`NLC Node module apiVersion must be ${MODULE_API_VERSION}.`);
  }
  if (typeof manifest.id !== 'string' || !MODULE_ID_PATTERN.test(manifest.id)) {
    throw invalid('NLC Node module id must be lowercase letters, numbers, and hyphens.');
  }
  assertVersion(manifest.version, `module ${manifest.id} version`);
  const dependsOn = manifest.dependsOn === undefined ? [] : manifest.dependsOn;
  if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string' || !MODULE_ID_PATTERN.test(id))) {
    throw invalid(`NLC Node module ${manifest.id} dependsOn must be an array of module ids.`);
  }
  if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(manifest.id)) {
    throw invalid(`NLC Node module ${manifest.id} has duplicate or self dependencies.`);
  }
  return Object.freeze({
    apiVersion: manifest.apiVersion,
    id: manifest.id,
    version: manifest.version,
    dependsOn: Object.freeze([...dependsOn]),
  });
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw invalid('NLC Node module descriptor must be an object.');
  }
  const manifest = validateManifest(descriptor.manifest);
  if (typeof descriptor.create !== 'function') {
    throw invalid(`NLC Node module ${manifest.id} must define create(context).`);
  }
  return Object.freeze({ manifest, create: descriptor.create });
}

function resolveStartupOrder(entries) {
  const byId = entries instanceof Map ? entries : new Map(entries.map((entry) => [entry.manifest.id, entry]));
  const visiting = new Set();
  const visited = new Set();
  const order = [];

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw invalid(`NLC Node module dependency cycle includes ${id}.`);
    const entry = byId.get(id);
    if (!entry) throw invalid(`NLC Node module dependency ${id} is not registered.`);
    visiting.add(id);
    for (const dependency of entry.manifest.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    order.push(entry);
  }

  for (const id of byId.keys()) visit(id);
  return order;
}

module.exports = {
  MODULE_ID_PATTERN,
  resolveStartupOrder,
  validateDescriptor,
  validateManifest,
};
