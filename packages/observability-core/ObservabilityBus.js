// packages/observability-core/ObservabilityBus.js
// Central event bus — thin wrapper over Node EventEmitter.
// All engine hooks call bus.emit(); all consumers call bus.on().

'use strict';

const { EventEmitter } = require('events');
const { v4: uuidv4 }  = require('uuid');
const { EventType }   = require('./types');

class ObservabilityBus extends EventEmitter {
  constructor() {
    super();
    // Allow high number of listeners (one per collector + websocket + incident engine)
    this.setMaxListeners(50);
    this._enabled = true;
  }

  /**
   * Emit a typed observability event.
   * Automatically stamps id and ts if not provided.
   *
   * @param {string} type  - EventType constant
   * @param {Object} payload
   * @returns {Object} the fully-stamped event
   */
  emit(type, payload = {}) {
    if (!this._enabled) return payload;

    const event = {
      id: uuidv4(),
      ts: Date.now(),
      queueName: '',
      ...payload,
      type,
    };

    // Emit on the specific event type channel
    super.emit(type, event);
    // Emit on wildcard channel for generic consumers (metrics collector, stream writer)
    super.emit('*', event);

    return event;
  }

  /** Pause all event emission (e.g., during tests) */
  disable() { this._enabled = false; }
  enable()  { this._enabled = true;  }
}

// Singleton — all engine modules share one bus in-process
const bus = new ObservabilityBus();

module.exports = { ObservabilityBus, bus };
