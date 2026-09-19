// Phase-0 failing tests: batchdequeue.lua (FIX_PLAN Phase 1, items 1-2).
//
// EXPECTED RED until fixed:
//  1. Jobs with missing vault data are trimmed from the waiting list AND lost
//     (not in any state). They must be left in place.
//  2. Batch-dequeued jobs never get attempts incremented (infinite retries).
//  3. Concurrent batch dequeues can return the same IDs (ZRANGE + ZREM race).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startRedisOnce,
  stopRedisOnce,
  uniquePrefix,
  rawClient,
  makeQueue,
  quitAll,
} from '../helper/redis-harness.js';

let url;
beforeAll(async () => {
  url = await startRedisOnce();
});
afterAll(async () => {
  await stopRedisOnce();
});

describe('batchdequeue correctness', () => {
  it('does NOT lose jobs whose vault entry is missing', async () => {
    const prefix = uniquePrefix('batch');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      const r1 = await queue.add('a', {});
      const r2 = await queue.add('b', {});
      const r3 = await queue.add('c', {});
      const id1 = typeof r1 === 'string' ? r1 : r1.id;
      const id2 = typeof r2 === 'string' ? r2 : r2.id;
      const id3 = typeof r3 === 'string' ? r3 : r3.id;
      // Simulate a vault entry lost to eviction/crash (job still queued).
      await client.hdel(`${prefix}:jobs:q`, id2);

      const results = await client.batchdequeue(
        `${prefix}:q`,
        `${prefix}:active:q`,
        `${prefix}:jobs:q`,
        `${prefix}:prioritized:q`,
        3,
        Date.now() + 30000
      );
      expect(results).toHaveLength(2);

      // The vault-less job must still be discoverable — not silently dropped.
      const stillWaiting = await client.lrange(`${prefix}:q`, 0, -1);
      expect(stillWaiting).toContain(id2);
      void id1;
      void id3;
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });

  it('increments attempts on batch-dequeued jobs', async () => {
    const prefix = uniquePrefix('battempt');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      const ra = await queue.add('a', {});
      const ida = typeof ra === 'string' ? ra : ra.id;
      const results = await client.batchdequeue(
        `${prefix}:q`,
        `${prefix}:active:q`,
        `${prefix}:jobs:q`,
        `${prefix}:prioritized:q`,
        1,
        Date.now() + 30000
      );
      expect(results).toHaveLength(1);
      const job = JSON.parse(results[0]);
      expect(job.attempts).toBe(1);
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });

  it('concurrent batch dequeues never hand out the same job twice', async () => {
    const prefix = uniquePrefix('b race'.replace(' ', ''));
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      let duplicateSeen = null;
      for (let round = 0; round < 15 && !duplicateSeen; round++) {
        const ids = [];
        for (let i = 0; i < 10; i++) {
          const r = await queue.add(`job-${round}-${i}`, {});
          ids.push(typeof r === 'string' ? r : r.id);
        }
        const batches = await Promise.all(
          [0, 1, 2, 3].map(() =>
            client.batchdequeue(
              `${prefix}:q`,
              `${prefix}:active:q`,
              `${prefix}:jobs:q`,
              `${prefix}:prioritized:q`,
              10,
              Date.now() + 30000
            )
          )
        );
        const handedOut = batches.flat().map((j) => JSON.parse(j).id);
        const uniq = new Set(handedOut);
        if (uniq.size !== handedOut.length) {
          duplicateSeen = handedOut.filter((id, idx) => handedOut.indexOf(id) !== idx);
        }
        // Return leftovers to a clean state for the next round.
        await client.del(`${prefix}:q`, `${prefix}:active:q`, `${prefix}:prioritized:q`);
        await client.hdel(`${prefix}:jobs:q`, ...ids);
      }
      expect(duplicateSeen).toBeNull();
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });
});
