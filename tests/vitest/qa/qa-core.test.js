// QA — Core E2E + Race Conditions (Phase 1-3 + Phase 9 pool)
// Covers: normal add→process→complete, priority, delayed, bulk, dedup races,
// batch dequeue races, concurrent dequeue, worker concurrency & pool.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Worker = require('../../../src/core/worker');
const QueueEvents = require('../../../src/core/queue-events');
import {
  startRedisOnce,
  stopRedisOnce,
  uniquePrefix,
  rawClient,
  makeQueue,
  quitAll,
} from '../helper/redis-harness.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 8000, interval = 100) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error('waitFor timeout');
}

let url;
beforeAll(async () => { url = await startRedisOnce(); });
afterAll(async () => { await stopRedisOnce(); });

// ── Normal E2E ───────────────────────────────────────────────────────────
describe('QA core — normal operations', () => {
  it('immediate job: add → worker processes → completed + returnvalue', async () => {
    const prefix = uniquePrefix('qacore1');
    const queue = makeQueue('q', url, prefix);
    const processed = [];
    const worker = new Worker('q', async job => { processed.push(job.id); return 42; }, { connection: url, prefix, concurrency: 1 });
    await worker.start();
    try {
      const r = await queue.add('email', { to: 'a@b.com' });
      const jobId = typeof r === 'string' ? r : r.id;
      await waitFor(async () => (await queue.getJobCounts()).completed === 1);
      expect(processed).toContain(jobId);
      const job = await queue.getJob(jobId);
      expect(job.status).toBe('completed');
      expect(job.returnvalue).toBe(42);
      expect(await rawClient(url).zscore(`${prefix}:completed:q`, jobId)).not.toBeNull();
    } finally {
      await worker.stop(); await queue.close();
    }
  });

  it('priority: higher priority dequeued first regardless of insertion order', async () => {
    const prefix = uniquePrefix('qapri');
    const queue = makeQueue('q', url, prefix);
    const client = rawClient(url);
    try {
      const rl = await queue.add('low', {}, { priority: 1 });
      const rh = await queue.add('high', {}, { priority: 10 });
      const rm = await queue.add('mid', {}, { priority: 5 });
      const lowId = typeof rl === 'string' ? rl : rl.id;
      const highId = typeof rh === 'string' ? rh : rh.id;
      const midId = typeof rm === 'string' ? rm : rm.id;
      // In TaurusMQ lower priority number = higher urgency (score = priority*1e11 + ts)
      // So dequeue order is low(1) → mid(5) → high(10)
      const j1 = JSON.parse(await client.dequeue(`${prefix}:q`, `${prefix}:active:q`, `${prefix}:jobs:q`, `${prefix}:prioritized:q`, Date.now(), 30000, ''));
      const j2 = JSON.parse(await client.dequeue(`${prefix}:q`, `${prefix}:active:q`, `${prefix}:jobs:q`, `${prefix}:prioritized:q`, Date.now(), 30000, ''));
      const j3 = JSON.parse(await client.dequeue(`${prefix}:q`, `${prefix}:active:q`, `${prefix}:jobs:q`, `${prefix}:prioritized:q`, Date.now(), 30000, ''));
      expect(j1.id).toBe(lowId);
      expect(j2.id).toBe(midId);
      expect(j3.id).toBe(highId);
    } finally { await queue.close(); await quitAll(client); }
  });

  it('delayed: job sits in delayed ZSET then promotes to waiting', async () => {
    const prefix = uniquePrefix('qadelay');
    const queue = makeQueue('q', url, prefix);
    const client = rawClient(url);
    try {
      const r = await queue.add('remind', {}, { delay: 500 });
      const jobId = typeof r === 'string' ? r : r.id;
      expect(await client.zscore(`${prefix}:delayed:q`, jobId)).not.toBeNull();
      expect(await client.llen(`${prefix}:q`)).toBe(0);
      await sleep(700);
      // Simulate scheduler promotion (promote.lua)
      const now = Date.now();
      await client.promote(`${prefix}:delayed:q`, `${prefix}:q`, `${prefix}:signal:q`, `${prefix}:prioritized:q`, `${prefix}:jobs:q`, now);
      expect(await client.zscore(`${prefix}:delayed:q`, jobId)).toBeNull();
      expect(await client.lrange(`${prefix}:q`, 0, -1)).toContain(jobId);
    } finally { await queue.close(); await quitAll(client); }
  });

  it('bulk: 20 jobs via addBulk all enqueued and processed', async () => {
    const prefix = uniquePrefix('qabulk');
    const queue = makeQueue('q', url, prefix);
    const processed = [];
    const worker = new Worker('q', async job => { processed.push(job.id); }, { connection: url, prefix, concurrency: 3 });
    await worker.start();
    try {
      const items = Array.from({ length: 20 }, (_, i) => ({ name: `job-${i}`, data: { i } }));
      await queue.addBulk(items);
      await waitFor(async () => processed.length === 20, 10000);
      expect(processed).toHaveLength(20);
      expect(new Set(processed).size).toBe(20);
    } finally { await worker.stop(); await queue.close(); }
  });

  it('repeatable: stable repeatKey, SET index maintained', async () => {
    const prefix = uniquePrefix('qarepeat');
    const queue = makeQueue('q', url, prefix);
    const client = rawClient(url);
    try {
      const r1 = await queue.add('cron', {}, { repeat: '*/5 * * * *' });
      const id1 = typeof r1 === 'string' ? r1 : r1.id;
      const r2 = await queue.add('cron', {}, { repeat: '*/5 * * * *' });
      const id2 = typeof r2 === 'string' ? r2 : r2.id;
      expect(id1).toBe(id2); // stable key
      expect(await client.sismember(`${prefix}:repeatable:q`, id1)).toBe(1);
      const list = await queue.getRepeatableJobs();
      expect(list.length).toBe(1);
      expect(list[0].cron).toBe('*/5 * * * *');
      await queue.removeRepeatable(id1); // remove by stable id directly
      expect(await client.sismember(`${prefix}:repeatable:q`, id1)).toBe(0);
    } finally { await queue.close(); await quitAll(client); }
  });

  it('obliterate clears all keys including obs and repeatable', async () => {
    const prefix = uniquePrefix('qaobl');
    const queue = makeQueue('q', url, prefix);
    const client = rawClient(url);
    try {
      await queue.add('a', {});
      await queue.add('cron', {}, { repeat: '*/5 * * * *' });
      await client.set(`tmq:obs:events:q`, 'x');
      await queue.obliterate();
      expect(await client.exists(`${prefix}:q`)).toBe(0);
      expect(await client.exists(`${prefix}:jobs:q`)).toBe(0);
      expect(await client.exists(`${prefix}:repeatable:q`)).toBe(0);
      expect(await client.exists(`tmq:obs:events:q`)).toBe(0);
    } finally { await queue.close(); await quitAll(client); }
  });
});

// ── Race conditions ─────────────────────────────────────────────────────
describe('QA core — race conditions', () => {
  it('concurrent dedup: 20 parallel adds same jobId → 1 waiting entry + deduplicated events', async () => {
    const prefix = uniquePrefix('qaracededup');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    // Subscribe to deduplicated events via raw pubsub is heavy; test via return flags
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => queue.add('n', { v: 1 }, { jobId: 'race-dup' })));
      const created = results.filter(r => !r.deduplicated);
      const deduped = results.filter(r => r.deduplicated);
      expect(created.length).toBe(1);
      expect(deduped.length).toBe(19);
      expect(await client.llen(`${prefix}:q`)).toBe(1);
    } finally { await queue.close(); await quitAll(client); }
  });

  it('concurrent batch dequeues never duplicate IDs', async () => {
    const prefix = uniquePrefix('qaracebatch');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      for (let i = 0; i < 20; i++) await queue.add(`j-${i}`, {});
      const batches = await Promise.all([0, 1, 2, 3].map(() => client.batchdequeue(`${prefix}:q`, `${prefix}:active:q`, `${prefix}:jobs:q`, `${prefix}:prioritized:q`, 10, Date.now() + 30000)));
      const ids = batches.flat().map(j => JSON.parse(j).id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(20);
    } finally { await queue.close(); await quitAll(client); }
  });

  it('two workers racing to dequeue same single job → only one gets it', async () => {
    const prefix = uniquePrefix('qarace2w');
    const queue = makeQueue('q', url, prefix);
    const c1 = rawClient(url);
    const c2 = rawClient(url);
    try {
      await queue.add('once', {});
      const [a, b] = await Promise.all([
        c1.dequeue(`${prefix}:q`, `${prefix}:active:q`, `${prefix}:jobs:q`, `${prefix}:prioritized:q`, Date.now(), 30000, ''),
        c2.dequeue(`${prefix}:q`, `${prefix}:active:q`, `${prefix}:jobs:q`, `${prefix}:prioritized:q`, Date.now(), 30000, ''),
      ]);
      const got = [a, b].filter(Boolean);
      expect(got.length).toBe(1);
    } finally { await queue.close(); await quitAll(c1, c2); }
  });

  it('worker pool concurrency respected: max 2 concurrent handlers', async () => {
    const prefix = uniquePrefix('qapool');
    const queue = makeQueue('q', url, prefix);
    let concurrent = 0; let maxConcurrent = 0;
    const worker = new Worker('q', async () => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(150);
      concurrent--;
    }, { connection: url, prefix, concurrency: 2 });
    await worker.start();
    try {
      for (let i = 0; i < 6; i++) await queue.add(`j-${i}`, {});
      await waitFor(async () => maxConcurrent >= 2, 5000);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
      await waitFor(async () => (await queue.getJobCounts()).completed === 6, 10000);
    } finally { await worker.stop(); await queue.close(); }
  });

  it('deduplicated event emitted on second add (via QueueEvents)', async () => {
    const prefix = uniquePrefix('qadedup');
    const queue = makeQueue('q', url, prefix);
    const events = new QueueEvents('q', { connection: url, prefix });
    const seen = [];
    events.on('deduplicated', d => seen.push(d));
    // Give subscribe time
    await sleep(200);
    try {
      await queue.add('n', {}, { jobId: 'ev-dup' });
      await queue.add('n', {}, { jobId: 'ev-dup' });
      await waitFor(async () => seen.length === 1, 3000);
      expect(seen[0].jobId).toBe('ev-dup');
    } finally { await events.close(); await queue.close(); }
  });
});
