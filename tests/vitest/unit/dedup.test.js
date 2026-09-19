// Phase-0 failing tests: dedup across add paths (FIX_PLAN Phase 2, F2).
//
// EXPECTED: immediate path GREEN (addJob.lua is atomic); delay / parent /
// bulk paths RED (no atomic dedup — same jobId enqueued twice).

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

describe('dedup by jobId across all add paths', () => {
  it('immediate: concurrent adds with same jobId enqueue exactly once', async () => {
    const prefix = uniquePrefix('dedup');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => queue.add('n', { i }, { jobId: 'dup-1' }))
      );
      const ids = results.map(r => typeof r === 'string' ? r : r.id);
      expect(new Set(ids).size).toBe(1);
      expect(await client.llen(`${prefix}:q`)).toBe(1);
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });

  it('delayed: concurrent duplicate adds emit exactly one wake signal', async () => {
    const prefix = uniquePrefix('dedupd');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      // ZSET member-uniqueness masks duplicate ENTRIES, but every duplicate
      // add pushes another wake signal (and last-writer-wins the vault).
      // Correct dedup: first write wins, duplicates are no-ops — one signal.
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          queue.add('n', { v: i }, { jobId: 'dup-delay', delay: 60000 })
        )
      );
      expect(await client.zcard(`${prefix}:delayed:q`)).toBe(1);
      expect(await client.llen(`${prefix}:signal:delayed:q`)).toBe(1);
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });

  it('parent (blocked): duplicate add does not overwrite the first write', async () => {
    const prefix = uniquePrefix('dedupp');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      const r1 = await queue.add('n', { v: 'first' }, { jobId: 'dup-parent', parent: ['c1'] });
      const r2 = await queue.add('n', { v: 'second' }, { jobId: 'dup-parent', parent: ['c1'] });
      const id1 = typeof r1 === 'string' ? r1 : r1.id;
      const id2 = typeof r2 === 'string' ? r2 : r2.id;
      expect(id1).toBe(id2);
      expect(await client.hlen(`${prefix}:blocked:q`)).toBe(1);
      const vault = JSON.parse(await client.hget(`${prefix}:jobs:q`, id1));
      expect(vault.data).toEqual({ v: 'first' });
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });

  it('bulk: duplicate jobIds inside one bulk enqueue exactly once', async () => {
    const prefix = uniquePrefix('dedupb');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      await queue.addBulk([
        { name: 'a', data: { v: 1 }, options: { jobId: 'dup-bulk' } },
        { name: 'a', data: { v: 2 }, options: { jobId: 'dup-bulk' } },
        { name: 'b', data: {}, options: { jobId: 'unique-bulk' } },
      ]);
      expect(await client.llen(`${prefix}:q`)).toBe(2);
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });
});
