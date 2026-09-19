// Phase-0 characterization: DAG fan-in (unblock.lua).
//
// FIX_PLAN.md Phase 0 / Phase 1: call-chain verification showed unblock.lua
// is CORRECT for fan-in (only the loop variable name is misleading).
// These tests lock that behavior in — they are expected GREEN.
// The real DAG defects (JS-side promote race, dead-child semantics, fan-out)
// get their own tests in Phase 1.

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

describe('DAG fan-in: children finishing unblocks the parent', () => {
  it('parent stays blocked until ALL children finish, then promotes exactly once', async () => {
    const prefix = uniquePrefix('dag');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      const r1 = await queue.add('parent-job', { x: 1 }, { jobId: 'p1', parent: ['c1', 'c2'] });
      const parentId = typeof r1 === 'string' ? r1 : r1.id;

      // Blocked, counter = 2
      expect(await client.hexists(`${prefix}:blocked:q`, parentId)).toBe(1);
      expect(await client.get(`${prefix}:job:${parentId}:count`)).toBe('2');

      // First child finishes -> counter 1, still blocked
      await client.unblock('c1', 'parent', 'children', prefix);
      expect(await client.get(`${prefix}:job:${parentId}:count`)).toBe('1');
      expect(await client.hexists(`${prefix}:blocked:q`, parentId)).toBe(1);

      // Second child finishes -> promoted to waiting exactly once
      await client.unblock('c2', 'parent', 'children', prefix);
      expect(await client.hexists(`${prefix}:blocked:q`, parentId)).toBe(0);
      const waiting = await client.lrange(`${prefix}:q`, 0, -1);
      expect(waiting.filter((id) => id === parentId)).toHaveLength(1);
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });

  it('concurrent child completions never double-promote the parent', async () => {
    const prefix = uniquePrefix('dagrace');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      const r2 = await queue.add('parent-job', {}, { jobId: 'p1', parent: ['c1', 'c2', 'c3'] });
      const parentId = typeof r2 === 'string' ? r2 : r2.id;
      await Promise.all([
        client.unblock('c1', 'parent', 'children', prefix),
        client.unblock('c2', 'parent', 'children', prefix),
        client.unblock('c3', 'parent', 'children', prefix),
      ]);
      const waiting = await client.lrange(`${prefix}:q`, 0, -1);
      expect(waiting.filter((id) => id === parentId)).toHaveLength(1);
      expect(await client.hexists(`${prefix}:blocked:q`, parentId)).toBe(0);
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });

  it('repeat unblock for the same child is idempotent (no negative counter reuse)', async () => {
    const prefix = uniquePrefix('dagidem');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      const r3 = await queue.add('parent-job', {}, { jobId: 'p1', parent: ['c1'] });
      const parentId = typeof r3 === 'string' ? r3 : r3.id;
      await client.unblock('c1', 'parent', 'children', prefix);
      await client.unblock('c1', 'parent', 'children', prefix); // duplicate finalize
      const waiting = await client.lrange(`${prefix}:q`, 0, -1);
      expect(waiting.filter((id) => id === parentId)).toHaveLength(1);
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });
});
