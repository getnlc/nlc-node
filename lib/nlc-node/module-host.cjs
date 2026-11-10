'use strict';

const { EventEmitter } = require('node:events');
const { createIdentity } = require('./identity.cjs');
const { resolveStartupOrder, validateDescriptor } = require('./module-contract.cjs');

function errorSummary(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown failure');
}

class ModuleHost extends EventEmitter {
  constructor({ version }) {
    super();
    this.version = version;
    this.lifecycle = 'idle';
    this.entries = new Map();
    this.startedIds = [];
  }

  identity() {
    return createIdentity({ version: this.version, lifecycle: this.lifecycle });
  }

  // The running module instances in start order (the dispatcher looks tools up in them).
  instances() {
    return this.startedIds
      .map((id) => this.entries.get(id))
      .filter((entry) => entry && entry.lifecycle === 'ready' && entry.instance)
      .map((entry) => entry.instance);
  }

  snapshot() {
    return Object.freeze({
      identity: this.identity(),
      lifecycle: this.lifecycle,
      modules: [...this.entries.values()].map((entry) => Object.freeze({
        ...entry.manifest,
        lifecycle: entry.lifecycle,
        error: entry.error || undefined,
      })),
    });
  }

  async register(descriptor) {
    const normalized = validateDescriptor(descriptor);
    if (this.entries.has(normalized.manifest.id)) {
      throw new Error(`NLC Node module ${normalized.manifest.id} is already registered.`);
    }
    const entry = {
      manifest: normalized.manifest,
      create: normalized.create,
      lifecycle: 'registered',
      instance: null,
      error: '',
    };
    this.entries.set(entry.manifest.id, entry);
    if (this.lifecycle === 'running') {
      try {
        await this._startPending();
      } catch (error) {
        this.entries.delete(entry.manifest.id);
        throw error;
      }
    }
    return entry.manifest;
  }

  async start() {
    if (this.lifecycle === 'running') return this.snapshot();
    if (this.lifecycle === 'starting' || this.lifecycle === 'stopping' || this.lifecycle === 'failed') {
      throw new Error(`NLC Node cannot start while ${this.lifecycle}.`);
    }
    this.lifecycle = 'starting';
    this.emit('lifecycle', this.snapshot());
    try {
      await this._startPending();
      this.lifecycle = 'running';
      this.emit('lifecycle', this.snapshot());
      return this.snapshot();
    } catch (error) {
      this.lifecycle = 'failed';
      this.emit('lifecycle', this.snapshot());
      throw error;
    }
  }

  async stop() {
    if (this.lifecycle === 'stopped' || this.lifecycle === 'idle') {
      this.lifecycle = 'stopped';
      return this.snapshot();
    }
    this.lifecycle = 'stopping';
    const errors = [];
    for (const id of [...this.startedIds].reverse()) {
      const entry = this.entries.get(id);
      if (!entry || entry.lifecycle !== 'ready') continue;
      try {
        await Promise.resolve(entry.instance.stop());
      } catch (error) {
        errors.push(errorSummary(error));
      }
      entry.lifecycle = 'stopped';
    }
    this.startedIds = [];
    this.lifecycle = 'stopped';
    this.emit('lifecycle', this.snapshot());
    if (errors.length) throw new Error(`NLC Node stopped with module errors: ${errors.join('; ')}`);
    return this.snapshot();
  }

  async health() {
    const modules = [];
    for (const entry of this.entries.values()) {
      let health = null;
      if (entry.lifecycle === 'ready') {
        try {
          health = await Promise.resolve(entry.instance.health());
        } catch (error) {
          entry.lifecycle = 'failed';
          entry.error = errorSummary(error);
          this.lifecycle = 'failed';
        }
      }
      modules.push(Object.freeze({ ...this._publicEntry(entry), health }));
    }
    return Object.freeze({ identity: this.identity(), lifecycle: this.lifecycle, modules });
  }

  async _startPending() {
    const startedThisAttempt = [];
    try {
      for (const entry of resolveStartupOrder(this.entries)) {
        if (entry.lifecycle === 'ready') continue;
        if (entry.lifecycle !== 'registered') continue;
        await this._startEntry(entry);
        startedThisAttempt.push(entry.manifest.id);
      }
    } catch (error) {
      await this._rollback(startedThisAttempt);
      throw error;
    }
  }

  async _startEntry(entry) {
    entry.lifecycle = 'starting';
    this.emit('lifecycle', this.snapshot());
    try {
      const context = Object.freeze({
        identity: this.identity(),
        getModule: (id) => this.entries.get(id) ? this._publicEntry(this.entries.get(id)) : null,
      });
      const instance = await Promise.resolve(entry.create(context));
      if (!instance || typeof instance.start !== 'function' || typeof instance.stop !== 'function' || typeof instance.health !== 'function') {
        throw new Error(`NLC Node module ${entry.manifest.id} must return start(), health(), and stop().`);
      }
      entry.instance = instance;
      await Promise.resolve(instance.start());
      entry.lifecycle = 'ready';
      this.startedIds.push(entry.manifest.id);
      this.emit('lifecycle', this.snapshot());
    } catch (error) {
      entry.lifecycle = 'failed';
      entry.error = errorSummary(error);
      this.emit('lifecycle', this.snapshot());
      throw error;
    }
  }

  async _rollback(ids) {
    for (const id of [...ids].reverse()) {
      const entry = this.entries.get(id);
      if (!entry || entry.lifecycle !== 'ready') continue;
      try {
        await Promise.resolve(entry.instance.stop());
      } catch {
        // The original start failure is more useful than a rollback failure.
      }
      entry.lifecycle = 'stopped';
      this.startedIds = this.startedIds.filter((startedId) => startedId !== id);
    }
  }

  _publicEntry(entry) {
    return Object.freeze({ ...entry.manifest, lifecycle: entry.lifecycle, error: entry.error || undefined });
  }
}

module.exports = { ModuleHost };
