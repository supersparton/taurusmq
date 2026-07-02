// packages/observability-core/EventStreamWriter.js
// Persists every ObservabilityBus event into a Redis Stream.
// Redis Streams give ordered, replayable event log with consumer groups.
//
// Key:  tmq:obs:events
// Retention: MAXLEN ~500000 entries (≈24h at high load) via approximate trimming

'use strict';

const { bus }     = require('./ObservabilityBus');
const redis       = require('../../src/utils/redis');

const STREAM_KEY  = 'tmq:obs:events';
const MAXLEN      = 500_000; // approximate cap (~24h at high throughput)

class EventStreamWriter {
  /**
   * Start persisting all bus events to Redis Stream.
   * Call once at application startup.
   */
  start() {
    bus.on('*', (event) => this._write(event));
    console.log('[obs] EventStreamWriter: listening on bus, writing to', STREAM_KEY);
  }

  /**
   * Write one event to the Redis Stream.
   * Uses XADD with MAXLEN to enforce retention without a separate cleanup job.
   *
   * Redis Stream entry fields (all strings as required by Redis):
   *   id        — event UUID
   *   type      — e.g. "job.completed"
   *   queueName — queue this event belongs to
   *   ts        — unix ms as string
   *   payload   — full event JSON (for rich consumers)
   */
  async _write(event) {
    try {
      await redis.xadd(
        STREAM_KEY,
        'MAXLEN', '~', String(MAXLEN),
        '*',                    // auto-generate Redis stream ID
        'id',        event.id,
        'type',      event.type,
        'queueName', event.queueName || '',
        'ts',        String(event.ts),
        'payload',   JSON.stringify(event),
      );
    } catch (err) {
      // Never let observability errors crash the engine
      console.error('[obs] EventStreamWriter write error:', err.message);
    }
  }

  /**
   * Read events from the stream for a given time range.
   * Used by the dashboard API for initial page-load event history.
   *
   * @param {number} fromMs   - start timestamp (unix ms)
   * @param {number} toMs     - end timestamp (unix ms), defaults to now
   * @param {number} count    - max entries to return
   * @returns {Promise<Object[]>} array of parsed event objects
   */
  async readRange(fromMs, toMs = Date.now(), count = 500) {
    // Redis Stream IDs can be millisecond timestamps
    const fromId = `${fromMs}-0`;
    const toId   = `${toMs}-9999`;

    const entries = await redis.xrange(STREAM_KEY, fromId, toId, 'COUNT', count);
    if (!entries || entries.length === 0) return [];

    return entries.map(([streamId, fields]) => {
      // fields is flat array: ['id', val, 'type', val, ...]
      const obj = {};
      for (let i = 0; i < fields.length; i += 2) {
        obj[fields[i]] = fields[i + 1];
      }
      try { return JSON.parse(obj.payload); }
      catch { return obj; }
    });
  }
}

module.exports = { EventStreamWriter };
