// test-fault-tolerance.js
// Offline Integration & Fault Injection Suite using Node.js node:test
// Evaluates Worker resilience under network cuts and command failures.

'use strict';

const EventEmitter = require('events');
const assert = require('node:assert');
const { test, describe } = require('node:test');

// 1. Setup Mock ioredis in CJS cache
class MockRedis extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options || {};
    this.store = new Map();
    this.signals = new Map(); // for blpop mock
    this.isClosed = false;

    // Simulate connection
    process.nextTick(() => {
      this.emit('connect');
      this.emit('ready');
    });
  }

  duplicate() {
    const dup = new MockRedis(this.url, this.options);
    // Link store and signals for shared state
    dup.store = this.store;
    dup.signals = this.signals;
    return dup;
  }

  defineCommand(name, opts) {
    // Stub custom Lua commands
    this[name] = async (...args) => {
      if (this.isClosed) {
        throw new Error('Connection is closed.');
      }
      
      // addJob(jobsHashKey, queueKey, signalKey, prioritizedKey, id, jobJson, priority, timestamp)
      if (name === 'addJob') {
        const jobsHashKey = args[0];
        const queueKey = args[1];
        const signalKey = args[2];
        const id = args[4];
        const jobJson = args[5];

        if (!this.store.has(jobsHashKey)) this.store.set(jobsHashKey, new Map());
        this.store.get(jobsHashKey).set(id, jobJson);
        
        if (!this.store.has(queueKey)) this.store.set(queueKey, []);
        this.store.get(queueKey).push(id);
        
        // Notify any waiting blpop
        if (this.signals.has(signalKey)) {
          const resolve = this.signals.get(signalKey);
          this.signals.delete(signalKey);
          resolve([signalKey, '1']);
        }
        return id;
      }
      
      // dequeue(queueKey, activeKey, jobsHashKey, prioritizedKey, lockExpirationTime)
      if (name === 'dequeue') {
        const queueKey = args[0];
        const jobsHashKey = args[2];
        
        const list = this.store.get(queueKey);
        if (list && list.length > 0) {
          const id = list.shift();
          const hash = this.store.get(jobsHashKey);
          if (hash && hash.has(id)) {
            const jobJson = hash.get(id);
            const parsed = JSON.parse(jobJson);
            parsed.status = 'active';
            hash.set(id, JSON.stringify(parsed));
            return JSON.stringify(parsed);
          }
        }
        return null;
      }

      // finalizeJob(jobsHashKey, activeKey, completedKey, failedKey, id, status, result, ...)
      if (name === 'finalizeJob') {
        const jobsHashKey = args[0];
        const id = args[4];
        const status = args[5];
        const result = args[6];
        
        const hash = this.store.get(jobsHashKey);
        if (hash && hash.has(id)) {
          const parsed = JSON.parse(hash.get(id));
          parsed.status = status;
          parsed.returnvalue = result;
          hash.set(id, JSON.stringify(parsed));
        }
        return 1;
      }

      // rateLimit(key, now, windowMs, limit)
      if (name === 'rateLimit') {
        const [key, now, windowMs, limit] = args;
        if (!this.store.has(key)) {
          this.store.set(key, []);
        }
        const times = this.store.get(key);
        const cutoff = now - windowMs;
        const activeTimes = times.filter(t => t > cutoff);
        if (activeTimes.length >= limit) {
          const waitTime = activeTimes[0] + windowMs - now;
          return [0, waitTime];
        }
        activeTimes.push(now);
        this.store.set(key, activeTimes);
        return [1, 0];
      }

      return null;
    };
  }

  async ping() {
    if (this.isClosed) throw new Error('Connection is closed.');
    return 'PONG';
  }

  async get(key) {
    if (this.isClosed) throw new Error('Connection is closed.');
    return this.store.get(key) || null;
  }

  async set(key, val) {
    if (this.isClosed) throw new Error('Connection is closed.');
    this.store.set(key, val);
    return 'OK';
  }

  async del(key) {
    if (this.isClosed) throw new Error('Connection is closed.');
    return this.store.delete(key) ? 1 : 0;
  }

  async hget(key, field) {
    if (this.isClosed) throw new Error('Connection is closed.');
    const hash = this.store.get(key);
    return hash ? hash.get(field) : null;
  }

  async hgetall(key) {
    if (this.isClosed) throw new Error('Connection is closed.');
    const hash = this.store.get(key);
    if (!hash) return {};
    const obj = {};
    for (const [k, v] of hash.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  async hset(key, field, val) {
    if (this.isClosed) throw new Error('Connection is closed.');
    if (!this.store.has(key)) this.store.set(key, new Map());
    this.store.get(key).set(field, val);
    return 1;
  }

  async zadd(key, score, member) {
    if (this.isClosed) throw new Error('Connection is closed.');
    return 1;
  }

  async zrem(key, member) {
    if (this.isClosed) throw new Error('Connection is closed.');
    return 1;
  }

  async zcard(key) {
    if (this.isClosed) throw new Error('Connection is closed.');
    return 0;
  }

  async llen(key) {
    if (this.isClosed) throw new Error('Connection is closed.');
    const list = this.store.get(key);
    return list ? list.length : 0;
  }

  async publish(channel, message) {
    if (this.isClosed) throw new Error('Connection is closed.');
    return 1;
  }

  async subscribe(channel) {
    if (this.isClosed) throw new Error('Connection is closed.');
    return 1;
  }

  async unsubscribe(channel) {
    if (this.isClosed) throw new Error('Connection is closed.');
    return 1;
  }

  async blpop(key, timeout) {
    if (this.isClosed) {
      throw new Error('Connection is closed.');
    }
    // Deduce the queue list key from the signal key
    // Signal key: e.g. "taurusmq:signal:mock-q"
    // Queue key: "taurusmq:mock-q"
    const queueKey = key.replace(':signal:', ':');
    const list = this.store.get(queueKey);
    if (list && list.length > 0) {
      return [key, '1'];
    }

    return new Promise(resolve => {
      this.signals.set(key, resolve);
    });
  }

  async quit() {
    this.isClosed = true;
    this.emit('end');
    return 'OK';
  }

  disconnect() {
    this.isClosed = true;
    this.emit('end');
  }
}

// Inject Mock into Node require cache
require.cache[require.resolve('ioredis')] = {
  exports: MockRedis
};

// Now import Queue and Worker (they will use MockRedis instead of real Redis!)
const Queue = require('../src/core/queue');
const Worker = require('../src/core/worker');

describe('TaurusMQ Offline Fault-Tolerance Test Suite', () => {

  test('Worker successfully boots and dequeues jobs offline via MockRedis', async () => {
    const q = new Queue('mock-q');
    
    // Enqueue a job in our MockRedis
    const jobId = await q.add('test-job', { data: 42 });
    assert.ok(jobId, 'Should successfully enqueue a job to mock store');

    let processedData = null;
    const worker = new Worker('mock-q', async (job) => {
      processedData = job.data;
    });

    await worker.start();

    // Allow time for the dequeue loop to poll and process
    await new Promise(r => setTimeout(r, 100));

    assert.deepStrictEqual(processedData, { data: 42 }, 'Worker must run handler on enqueued job');
    await worker.stop();
  });

  test('Worker survives simulated Redis connection faults during polling', async () => {
    const worker = new Worker('mock-q', async () => {});
    await worker.start();

    // Retrieve worker's internal blocking client and trigger a connection error
    const client = worker.pubsubClient;
    
    let errorEmitted = false;
    worker.on('error', () => {
      errorEmitted = true;
    });

    // Simulate network error
    client.isClosed = true;
    client.emit('error', new Error('Connection lost'));

    // Wait a brief period to let worker digest error
    await new Promise(r => setTimeout(r, 100));

    // Restore connection
    client.isClosed = false;

    // Verify worker didn't crash and remains running
    assert.strictEqual(worker.active, true, 'Worker must remain active after transient Redis error');
    
    await worker.stop();
  });
});
