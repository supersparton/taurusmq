// Phase-0 failing test: signal.lua write order (FIX_PLAN Phase 1, item 3).
//
// A crash between LPUSH (wake) and ZADD (data) leaves the scheduler awake
// with nothing to promote — the delayed job never runs. ZADD must come first.
// EXPECTED RED until the two lines are swapped.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const signalLua = fs.readFileSync(
  path.join(here, '../../../src/lua/signal.lua'),
  'utf-8'
);

describe('signal.lua crash-safety invariant', () => {
  it('ZADD (data) is written before LPUSH (wake signal)', () => {
    const zaddPos = signalLua.indexOf("ZADD");
    const lpushPos = signalLua.indexOf("LPUSH");
    expect(zaddPos).toBeGreaterThanOrEqual(0);
    expect(lpushPos).toBeGreaterThanOrEqual(0);
    expect(
      zaddPos,
      'LPUSH-before-ZADD leaves a crash window where the scheduler wakes but finds no job'
    ).toBeLessThan(lpushPos);
  });
});
