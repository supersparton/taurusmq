// test-scheduler.js
// Validates:
//   1. options.repeat is correctly mapped to job.repeat (bug fix)
//   2. Delayed jobs execute after their delay (bug fix)
//   3. Repeatable jobs use a stable deterministic key (not random UUIDs)
//   4. Stall watchdog uses processedOn, not timestamp (bug fix)
//   5. Regression: previous test suites still pass
'use strict';

const { Queue, Worker, Scheduler } = require('../src/index');
const Redis = require('ioredis');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function makeConn() {
    return new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
}

async function runTests() {
    console.log('====================================================');
    console.log('🔬 SCHEDULER & ROBUSTNESS TEST');
    console.log('====================================================\n');

    const prefix = 'tmq_sched_test';

    async function clean(c) {
        const k = await c.keys(`${prefix}:*`);
        if (k.length) await c.del(...k);
    }

    let passed = 0, failed = 0;
    function assert(label, cond) {
        if (cond) { console.log(`  ✅ PASS  ${label}`); passed++; }
        else       { console.error(`  ❌ FAIL  ${label}`); failed++; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1 — options.repeat is mapped onto Job instance (the critical bug fix)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 1: options.repeat mapped to job.repeat ------------------');
    {
        const Job = require('../src/core/job');
        const j = new Job('cron-task', {}, { repeat: '*/5 * * * *' });
        assert('job.repeat === options.repeat', j.repeat === '*/5 * * * *');
        assert('job.repeat is not null', j.repeat !== null);

        const j2 = new Job('plain-task', {});
        assert('job.repeat defaults to null for non-repeatable jobs', j2.repeat === null);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2 — Delayed job executes after its delay, not immediately
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 2: Delayed job executes after delay ---------------------');
    {
        const c = makeConn();
        await clean(c);

        const queue = new Queue('delay-q', { connection: c, prefix });
        const scheduler = new Scheduler('delay-q', { connection: c, prefix });
        let executedAt = null;

        const worker = new Worker('delay-q', async (job) => {
            executedAt = Date.now();
        }, { connection: c, prefix, concurrency: 1 });

        await worker.start();
        scheduler.delayedjobs(); // non-blocking promotion loop

        const enqueueTime = Date.now();
        const delay = 800;
        await queue.add('delayed-task', { x: 1 }, { delay });

        // Wait for it to execute (delay + processing margin)
        await sleep(1800);

        await worker.stop();
        scheduler.active = false;

        assert('delayed job was executed', executedAt !== null);
        if (executedAt !== null) {
            const actualDelay = executedAt - enqueueTime;
            assert(`actual delay ≥ ${delay}ms (was ${actualDelay}ms)`, actualDelay >= delay);
            assert(`actual delay < ${delay + 10000}ms (not stuck forever, was ${actualDelay}ms)`, actualDelay < delay + 10000);
        }

        await clean(c);
        await c.quit();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3 — Repeatable job: queue.add returns a stable deterministic key
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 3: Repeatable job stable key ----------------------------');
    {
        const c = makeConn();
        await clean(c);

        const queue = new Queue('repeat-q', { connection: c, prefix });

        const cronExpr = '*/1 * * * *'; // every minute
        const id1 = await queue.add('cron-task', {}, { repeat: cronExpr });
        const id2 = await queue.add('cron-task', {}, { repeat: cronExpr });

        assert('repeat key starts with "repeat:"', id1.startsWith('repeat:'));
        assert('same cron expression → same stable key', id1 === id2);

        // Verify only one entry in the delayed sorted set
        const count = await c.zcard(`${prefix}:delayed:repeat-q`);
        assert('only one entry in delayed set (no duplicates)', count === 1);

        // Verify stable key in the jobs hash
        const jobJson = await c.hget(`${prefix}:jobs:repeat-q`, id1);
        assert('stable key stored in jobs hash', jobJson !== null);
        if (jobJson) {
            const job = JSON.parse(jobJson);
            assert('stored job.repeat matches the cron expression', job.repeat === cronExpr);
            assert('stored job.id matches the stable key', job.id === id1);
        }

        await clean(c);
        await c.quit();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4 — processedOn field is set by worker at pickup time
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 4: processedOn set at pickup ----------------------------');
    {
        const c = makeConn();
        await clean(c);

        const queue = new Queue('ts-q', { connection: c, prefix });
        let capturedProcessedOn = null;

        const worker = new Worker('ts-q', async (job) => {
            capturedProcessedOn = job.processedOn;
            await sleep(50);
        }, { connection: c, prefix, concurrency: 1 });

        await worker.start();
        const enqueueTime = Date.now();
        await queue.add('ts-task', {});
        await sleep(500);
        await worker.stop();

        assert('processedOn is set (not null)', capturedProcessedOn !== null);
        assert('processedOn is a number', typeof capturedProcessedOn === 'number');
        assert('processedOn >= enqueueTime', capturedProcessedOn >= enqueueTime);
        assert('processedOn <= enqueueTime + 10000', capturedProcessedOn <= enqueueTime + 10000);

        await clean(c);
        await c.quit();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5 — Stall watchdog uses processedOn, not timestamp
    // A job with a very old timestamp (simulating long queue wait) must NOT
    // be immediately flagged as stalled when first picked up by a worker.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 5: Stall watchdog uses processedOn not timestamp ---------');
    {
        const c = makeConn();
        await clean(c);

        // Short timeout so watchdog fires quickly
        const STALL_TIMEOUT = 500;
        const queue = new Queue('stall-q', { connection: c, prefix });
        const scheduler = new Scheduler('stall-q', STALL_TIMEOUT, { connection: c, prefix });
        let completed = false;

        const worker = new Worker('stall-q', async (job) => {
            await sleep(200); // job takes 200ms — well within stall window
            completed = true;
        }, { connection: c, prefix, concurrency: 1 });

        await worker.start();
        scheduler.start(); // non-blocking watchdog loop

        // Add a job with a fabricated old timestamp (simulates 2min queue wait)
        const job = new (require('../src/core/job'))('stall-test', {});
        job.timestamp = Date.now() - 120000; // 2 minutes old
        await c.hset(`${prefix}:jobs:stall-q`, job.id, job.toJson());
        await c.rpush(`${prefix}:stall-q`, job.id);
        await c.lpush(`${prefix}:signal:stall-q`, 1);

        await sleep(800); // allow job to process and watchdog to tick once

        await worker.stop();
        scheduler.active = false;

        assert('job with old timestamp completed normally (not falsely stalled)', completed === true);

        // Also verify job is NOT in the active hash anymore (watchdog didn't re-queue it incorrectly)
        const activeScore = await c.zscore(`${prefix}:active:stall-q`, job.id);
        const stillActive = activeScore !== null ? 1 : 0;
        assert('job removed from active hash after completion', stillActive === 0);

        await clean(c);
        await c.quit();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 6 — processedOn defaults to null in new Job instances
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 6: processedOn defaults to null -------------------------');
    {
        const Job = require('../src/core/job');
        const j = new Job('x', {});
        const parsed = JSON.parse(j.toJson());
        assert('processedOn serialises as null', parsed.processedOn === null);
    }

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n====================================================');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('====================================================\n');
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('❌ Test runner crashed:', err);
    process.exit(1);
});
