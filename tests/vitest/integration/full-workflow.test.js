// Integration — full producer → worker → complete workflow
// End-to-end through the real fetcher + executor pool (Phase 9),
// plus Scheduler-driven delayed promotion.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Worker = require('../../../src/core/worker');
const Scheduler = require('../../../src/core/scheduler');
import {
  startRedisOnce,
  stopRedisOnce,
  uniquePrefix,
  makeQueue,
} from '../helper/redis-harness.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 10000, interval = 100) {
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

describe('integration — producer → worker → complete', () => {
  it('add → worker processes → completed + returnvalue + counts', async () => {
    const prefix = uniquePrefix('intflow');
    const queue = makeQueue('flow', url, prefix);
    const seen = [];
    const worker = new Worker('flow', async job => {
      seen.push(job.id);
      return { ok: true, n: job.data.n };
    }, { connection: url, prefix, concurrency: 4 });
    await worker.start();
    try {
      const r = await queue.add('task', { n: 7 });
      const jobId = typeof r === 'string' ? r : r.id;
      await waitFor(async () => (await queue.getJobCounts()).completed === 1);
      expect(seen).toContain(jobId);
      const job = await queue.getJob(jobId);
      expect(job.status).toBe('completed');
      expect(job.returnvalue).toEqual({ ok: true, n: 7 });
    } finally {
      await worker.stop(); await queue.close();
    }
  });

  it('fail-once job is retried then completes (handler called twice)', async () => {
    const prefix = uniquePrefix('intretry');
    const queue = makeQueue('flow', url, prefix);
    // handleFailure parks retryable failures in delayed (default backoff 1s),
    // so a Scheduler promotion loop is required — fire-and-forget per convention.
    const scheduler = new Scheduler('flow', { connection: url, prefix, timeout: 200 });
    scheduler.delayedjobs();
    let calls = 0;
    const worker = new Worker('flow', async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom-first-attempt');
      return 'recovered';
    }, { connection: url, prefix, concurrency: 2 });
    await worker.start();
    try {
      const r = await queue.add('flaky', {}, { maxretries: 2 });
      const jobId = typeof r === 'string' ? r : r.id;
      await waitFor(async () => (await queue.getJobCounts()).completed === 1);
      expect(calls).toBe(2);
      const job = await queue.getJob(jobId);
      expect(job.status).toBe('completed');
      expect(job.returnvalue).toBe('recovered');
    } finally {
      await worker.stop(); await scheduler.stop(); await queue.close();
    }
  });

  it('bulk add with delay lands in delayed, promotes, then processes', async () => {
    const prefix = uniquePrefix('intbulkdelay');
    const queue = makeQueue('flow', url, prefix);
    const scheduler = new Scheduler('flow', { connection: url, prefix, timeout: 200 });
    scheduler.delayedjobs();
    const seen = [];
    const worker = new Worker('flow', async job => { seen.push(job.data.n); return job.data.n; }, {
      connection: url, prefix, concurrency: 2,
    });
    await worker.start();
    try {
      await queue.addBulk([
        { name: 'bulk-later', data: { n: 1 }, options: { delay: 700 } },
        { name: 'bulk-later', data: { n: 2 }, options: { delay: 700 } },
        { name: 'bulk-now', data: { n: 3 } },
      ]);
      // Immediate item completes first; delayed items wait for promotion
      await waitFor(async () => (await queue.getJobCounts()).completed === 3, 15000);
      expect(seen).toContain(3);
      expect(seen.slice().sort()).toEqual([1, 2, 3]);
    } finally {
      await worker.stop(); await scheduler.stop(); await queue.close();
    }
  });

  it('delayed job is promoted by Scheduler then processed', async () => {
    const prefix = uniquePrefix('intdelay');
    const queue = makeQueue('flow', url, prefix);
    const scheduler = new Scheduler('flow', { connection: url, prefix, timeout: 200 });
    const worker = new Worker('flow', async job => `done:${job.name}`, {
      connection: url, prefix, concurrency: 2,
    });
    // startAll()/delayedjobs() are infinite loops — never await them.
    scheduler.delayedjobs();
    await worker.start();
    try {
      const r = await queue.add('later', { x: 1 }, { delay: 700 });
      const jobId = typeof r === 'string' ? r : r.id;
      // Still delayed before the delay elapses
      expect((await queue.getJob(jobId)).status).toBe('delayed');
      await waitFor(async () => (await queue.getJobCounts()).completed === 1, 15000);
      expect((await queue.getJob(jobId)).status).toBe('completed');
    } finally {
      await worker.stop(); await scheduler.stop(); await queue.close();
    }
  });
});
