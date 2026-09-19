// Phase-0 failing test: attempts accounting across stall recovery
// (FIX_PLAN Phase 3, items 1-2).
//
// dequeue.lua does attempts+1 unconditionally. A job that merely stalled
// (worker died, scheduler recovered it) pays TWO attempts for one stall:
// one baked in at recovery, one on re-dequeue. Recovery must be free —
// increment only when processedOn is still null (first pickup).
// EXPECTED RED until dequeue.lua gains the processedOn guard.

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

describe('stall recovery costs zero attempts', () => {
  it('recover + re-dequeue leaves attempts at 1 (first pickup only)', async () => {
    const prefix = uniquePrefix('attempts');
    const client = rawClient(url);
    const queue = makeQueue('q', url, prefix);
    try {
      const W = `${prefix}:q`;
      const A = `${prefix}:active:q`;
      const J = `${prefix}:jobs:q`;
      const P = `${prefix}:prioritized:q`;
      const S = `${prefix}:signal:q`;
      const D = `${prefix}:dlq:q`;

      const r = await queue.add('work', { n: 1 });
      const jobId = typeof r === 'string' ? r : r.id;

      // First pickup -> attempts 1, lease in active ZSET.
      const first = await client.dequeue(W, A, J, P, Date.now(), 30000, '');
      expect(JSON.parse(first).id).toBe(jobId);
      expect(JSON.parse(first).attempts).toBe(1);

      // Simulate worker death: expire the lease, run the watchdog script.
      await client.zadd(A, Date.now() - 1000, jobId);
      const recovered = await client.recoverStalled(A, W, S, P, J, D, Date.now(), 50000);
      expect(recovered).toBe(1);

      // Re-dequeue after recovery must NOT cost another attempt.
      const second = await client.dequeue(W, A, J, P, Date.now(), 30000, '');
      expect(JSON.parse(second).id).toBe(jobId);
      expect(JSON.parse(second).attempts).toBe(1);

      const vault = JSON.parse(await client.hget(J, jobId));
      expect(vault.attempts).toBe(1);
    } finally {
      await queue.close();
      await quitAll(client);
    }
  });
});
