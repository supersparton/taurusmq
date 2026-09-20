// QA — Chaos & crash safety (Phase D)
// Proves the at-least-once claims skeptics poke at: abrupt worker death,
// lease-expiry races, eviction interplay, pause-drain. All green = no loss,
// no duplicates in completion records (handler re-execution under death is
// expected and asserted as such — at-least-once execution, exactly-once
// completion records).

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
async function waitFor(fn, timeout = 12000, interval = 150) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error('waitFor timeout');
}

// Simulate SIGKILL: loops halted, timers cleared, connections severed with
// in-flight finalizes unsettled. The worker object is abandoned afterwards
// (never stop()ped — a dead process runs no graceful shutdown).
function killWorker(w) {
  w.active = false;
  for (const [, t] of w.activeLockTimers) {
    try { clearTimeout(t); } catch (_) {}
  }
  w.activeLockTimers.clear();
  for (const c of [w.redisClient, w._fetcherClient, w.pubsubClient]) {
    try { c?.disconnect(); } catch (_) {}
  }
}

let url;
beforeAll(async () => { url = await startRedisOnce(); });
afterAll(async () => { await stopRedisOnce(); });

describe('QA chaos — death and recovery', () => {
  it('abrupt death mid-batch: zero loss, exactly-once completion records', async () => {
    const prefix = uniquePrefix('qakill');
    const queue = makeQueue('q', url, prefix);
    const scheduler = new Scheduler('q', { connection: url, prefix, timeout: 200 });
    scheduler.delayedjobs();
    scheduler.start(); // stall watchdog (recoverStalled) — without this nothing recovers
    const N = 50;
    for (let i = 0; i < N; i++) await queue.add(`job-${i}`, { n: i });
    const executed = new Set();
    const doomed = new Worker('q', async job => {
      await sleep(50);
      executed.add(job.id);
      return job.data.n;
    }, { connection: url, prefix, concurrency: 10, lockDuration: 1500 });
    await doomed.start();
    await sleep(150); // let it chew through the first jobs, then kill it
    killWorker(doomed);
    // Fresh worker recovers everything via lease expiry + watchdog.
    // `executed` spans BOTH workers: jobs finished pre-kill ran on the doomed
    // worker, the rest on the fresh one. At-least-once execution is correct
    // here; completion records must be exactly-once (idempotent finalize).
    const seen = new Set();
    const worker = new Worker('q', async job => {
      executed.add(job.id);
      seen.add(job.id);
      return job.data.n;
    }, { connection: url, prefix, concurrency: 10, lockDuration: 1500 });
    await worker.start();
    try {
      await waitFor(async () => (await queue.getJobCounts()).completed === N);
      const counts = await queue.getJobCounts();
      expect(counts.failed).toBe(0);
      expect(executed.size).toBe(N); // every job executed at least once overall
      expect(seen.size).toBeGreaterThan(0); // recovery worker did real work
      // Completion records are idempotent even though some jobs executed twice
      const ids = [...seen];
      for (const id of ids.slice(0, 5)) {
        expect((await queue.getJob(id)).status).toBe('completed');
      }
    } finally {
      await worker.stop(); await scheduler.stop(); await queue.close();
    }
  });

  it('lease expiry mid-run: recovery costs no extra attempt, one completion', async () => {
    const prefix = uniquePrefix('qalease');
    const queue = makeQueue('q', url, prefix);
    const scheduler = new Scheduler('q', { connection: url, prefix, timeout: 200 });
    scheduler.delayedjobs();
    scheduler.start(); // stall watchdog
    let runs = 0;
    // Renewal disabled (lockRenewTime >> run) so the 300ms lease dies mid-handler
    const w1 = new Worker('q', async () => {
      runs += 1;
      await sleep(800);
      return 'slow-ok';
    }, { connection: url, prefix, concurrency: 1, lockDuration: 300, lockRenewTime: 60000 });
    await w1.start();
    const r = await queue.add('slow', {});
    const jobId = typeof r === 'string' ? r : r.id;
    await sleep(450); // lease (300ms) expired; watchdog recovered; w1 still running handler
    const w2 = new Worker('q', async () => { runs += 1; return 'recovered'; }, {
      connection: url, prefix, concurrency: 1, lockDuration: 5000,
    });
    await w2.start();
    try {
      await waitFor(async () => (await queue.getJobCounts()).completed === 1);
      // Both workers race this job: let the slower one settle before reading.
      // Completed-set membership is idempotent, so the count must STAY 1.
      await sleep(900);
      expect((await queue.getJobCounts()).completed).toBe(1);
      expect((await queue.getJobCounts()).failed).toBe(0);
      const job = await queue.getJob(jobId);
      expect(job.status).toBe('completed');
      // Stall recovery must not cost an attempt (first pickup already counted)
      expect(job.attempts).toBe(1);
      // Both executions happened (at-least-once), one record (idempotent)
      expect(runs).toBe(2);
    } finally {
      w1.active = false;
      try { await w1.stop(); } catch (_) {}
      await w2.stop(); await scheduler.stop(); await queue.close();
    }
  });

  it('eviction caps: trimmed completed set stays consistent under pagination', async () => {
    const prefix = uniquePrefix('qaevict');
    const queue = makeQueue('q', url, prefix);
    const done = new Set();
    const worker = new Worker('q', async job => { done.add(job.id); return job.data.n; }, {
      connection: url, prefix, concurrency: 4, removeOnComplete: 5, removeOnFail: 5,
    });
    await worker.start();
    try {
      const ids = [];
      for (let i = 0; i < 20; i++) {
        const r = await queue.add(`j-${i}`, { n: i });
        ids.push(typeof r === 'string' ? r : r.id);
      }
      // Wait for ALL handler executions (completed set caps at 5, so it
      // cannot be used as the drain signal — the last jobs may still run
      // when the cap is first hit).
      await waitFor(async () => done.size === 20);
      await waitFor(async () => (await queue.getJobCounts()).completed === 5);
      // Capped at 5 retained
      expect((await queue.getJobCounts()).completed).toBe(5);
      const page = await queue.getJobs('completed', 0, 2);
      expect(page.length).toBeLessThanOrEqual(3);
      // Evicted jobs are gone from the vault (null), survivors resolve
      const survivor = await queue.getJob(ids[19]);
      expect(survivor.status).toBe('completed');
      expect(survivor.returnvalue).toBe(19);
      const evicted = await queue.getJob(ids[0]);
      expect(evicted).toBeNull();
    } finally {
      await worker.stop(); await queue.close();
    }
  });

  it('pause mid-drain stalls without loss; resume completes exactly once', async () => {
    const prefix = uniquePrefix('qapause');
    const queue = makeQueue('q', url, prefix);
    const done = new Set();
    const worker = new Worker('q', async job => {
      await sleep(20);
      done.add(job.id);
      return 1;
    }, { connection: url, prefix, concurrency: 2 });
    await worker.start();
    try {
      const N = 20;
      for (let i = 0; i < N; i++) await queue.add(`p-${i}`, {});
      await waitFor(async () => (await queue.getJobCounts()).completed >= 3);
      await queue.pause();
      // In-flight jobs landing right after pause is correct — only NEW
      // pickups must stop. Let stragglers land, then assert a hard freeze.
      await sleep(400);
      const frozenAt = (await queue.getJobCounts()).completed;
      await sleep(1000);
      expect((await queue.getJobCounts()).completed).toBe(frozenAt);
      const mid = await queue.getJobCounts();
      expect(mid.waiting).toBeGreaterThan(0); // parked, not lost
      expect(mid.waiting + mid.active + mid.delayed + frozenAt).toBe(N);
      await queue.resume();
      await waitFor(async () => (await queue.getJobCounts()).completed === N);
      expect(done.size).toBe(N);
    } finally {
      await worker.stop(); await queue.close();
    }
  });

  it('stall storm: watchdog reclaims everything for a fresh worker', async () => {
    const prefix = uniquePrefix('qastorm');
    const queue = makeQueue('q', url, prefix);
    const scheduler = new Scheduler('q', { connection: url, prefix, timeout: 200 });
    scheduler.delayedjobs();
    scheduler.start(); // stall watchdog (recoverStalled) — without this nothing recovers
    const N = 10;
    for (let i = 0; i < N; i++) await queue.add(`s-${i}`, { n: i });
    const executed = new Set();
    const doomed = new Worker('q', async job => { executed.add(job.id); await sleep(200); return 1; }, {
      connection: url, prefix, concurrency: 5, lockDuration: 500,
    });
    await doomed.start();
    await sleep(300); // jobs picked up, then the floor falls away
    killWorker(doomed);
    const seen = new Set();
    const worker = new Worker('q', async job => { executed.add(job.id); seen.add(job.id); return 1; }, {
      connection: url, prefix, concurrency: 5, lockDuration: 5000,
    });
    await worker.start();
    try {
      await waitFor(async () => (await queue.getJobCounts()).completed === N);
      expect(executed.size).toBe(N); // at-least-once across both workers
      expect(seen.size).toBeGreaterThan(0); // recovery worker did real work
      expect((await queue.getJobCounts()).failed).toBe(0);
    } finally {
      await worker.stop(); await scheduler.stop(); await queue.close();
    }
  });
});
