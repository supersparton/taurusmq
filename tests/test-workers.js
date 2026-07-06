// test-workers.js
// Validates:
//   1. True parallel concurrency — wall-clock proves 3 jobs ran in parallel not serial
//   2. Graceful shutdown waits for in-flight jobs
//   3. Shutdown timeout guard (force-close when shutdownTimeout exceeded)
//   4. Idle worker stops quickly (no 60s blpop hang)
//   5. Regression: concurrency=1 processes all jobs correctly
//   6. Regression: __shutdown__ signal does not preempt a queued job signal
'use strict';

const { Queue, Worker } = require('../src/index');
const Redis = require('ioredis');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeConn() {
    return new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: null,
    });
}

async function runTests() {
    console.log('====================================================');
    console.log('🔬 WORKER CONCURRENCY & GRACEFUL SHUTDOWN TEST');
    console.log('====================================================\n');

    const prefix = 'tmq_wt';
    let qIdx = 0;
    function nextQ() { return `wq${++qIdx}`; }

    async function clean(c) {
        const keys = await c.keys(`${prefix}:*`);
        if (keys.length) await c.del(...keys);
    }

    let passed = 0, failed = 0;

    function assert(label, condition) {
        if (condition) { console.log(`  ✅ PASS  ${label}`); passed++; }
        else           { console.error(`  ❌ FAIL  ${label}`); failed++; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1 — True parallel concurrency
    // 3 jobs × 400ms each. If serial → wall-clock ≥ 1200ms. If parallel → ~400ms.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 1: True parallel concurrency ----------------------------');
    {
        const c = makeConn();
        const q = nextQ();
        await clean(c);

        const queue = new Queue(q, { connection: c, prefix });
        const startTimes = [], endTimes = [];
        let resolveDone;
        const allDone = new Promise(r => { resolveDone = r; });

        const worker = new Worker(q, async (job) => {
            startTimes.push(Date.now());
            await sleep(400);
            endTimes.push(Date.now());
            if (endTimes.length === 3) resolveDone();
        }, { connection: c, prefix, concurrency: 3 });

        // Add jobs BEFORE starting the worker so they are all picked up in parallel
        await queue.add('t', { n: 1 });
        await queue.add('t', { n: 2 });
        await queue.add('t', { n: 3 });

        // start() now pings all slot clients — they are connected before returning
        await worker.start();

        // Wait for all 3 to complete naturally (≤ 2s), then stop
        await Promise.race([allDone, sleep(2000)]);
        await worker.stop();

        const wall = startTimes.length === 3
            ? Math.max(...endTimes) - Math.min(...startTimes)
            : 9999;

        assert('all 3 jobs completed', endTimes.length === 3);
        // Serial would take ≥ 1200ms wall-clock; parallel should be ≈ 400ms
        assert(`wall-clock ${wall}ms < 1100ms (parallel, not serial)`, wall < 1100);

        await clean(c);
        await c.quit();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2 — Graceful shutdown waits for in-flight job
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 2: Graceful shutdown waits for in-flight job ------------');
    {
        const c = makeConn();
        const q = nextQ();
        await clean(c);

        const queue = new Queue(q, { connection: c, prefix });
        let jobDone = false;

        const worker = new Worker(q, async () => {
            await sleep(500);
            jobDone = true;
        }, { connection: c, prefix, concurrency: 1, shutdownTimeout: 5000 });

        await worker.start(); // slot TCP connected after start()

        await queue.add('slow', {});
        await sleep(80); // let the slot's blpop wake up and begin processing

        const t = Date.now();
        await worker.stop(); // must wait for the 500ms job
        const dur = Date.now() - t;

        assert('job completed before stop() resolved', jobDone === true);
        assert(`stop() waited ≥ 350ms (took ${dur}ms)`, dur >= 350);
        assert(`stop() resolved within 10000ms (took ${dur}ms)`, dur < 10000);

        await clean(c);
        await c.quit();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3 — Shutdown timeout guard
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 3: Shutdown timeout guard (force-close on timeout) ------');
    {
        const c = makeConn();
        const q = nextQ();
        await clean(c);

        const queue = new Queue(q, { connection: c, prefix });

        const worker = new Worker(q, async () => {
            await sleep(60000); // never finishes in time
        }, { connection: c, prefix, concurrency: 1, shutdownTimeout: 400 });

        await worker.start();
        await queue.add('stuck', {});
        await sleep(80); // let slot pick it up

        const t = Date.now();
        await worker.stop();
        const dur = Date.now() - t;

        assert(`force-close < 5000ms (took ${dur}ms)`, dur < 5000);
        assert(`honoured shutdownTimeout ≥ 380ms (took ${dur}ms)`, dur >= 380);

        await clean(c);
        await c.quit();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4 — Idle worker stops quickly (no 60s blpop hang)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 4: Idle worker stops quickly ----------------------------');
    {
        const c = makeConn();
        const q = nextQ();
        await clean(c);

        const worker = new Worker(q, async () => {}, {
            connection: c, prefix, concurrency: 2,
        });
        await worker.start();

        const t = Date.now();
        await worker.stop();
        const dur = Date.now() - t;

        assert(`idle stop < 2000ms (took ${dur}ms)`, dur < 2000);

        await clean(c);
        await c.quit();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5 — Regression: concurrency=1 processes all jobs in sequence
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 5: Regression — concurrency=1 processes all jobs --------');
    {
        const c = makeConn();
        const q = nextQ();
        await clean(c);

        const queue = new Queue(q, { connection: c, prefix });
        let count = 0;

        const worker = new Worker(q, async () => { count++; }, {
            connection: c, prefix, concurrency: 1,
        });
        await worker.start();

        await queue.add('r', { n: 1 });
        await queue.add('r', { n: 2 });

        let attempts = 0;
        while (count < 2 && attempts < 50) {
            await sleep(200);
            attempts++;
        }
        await worker.stop();

        assert(`concurrency=1 processed both jobs (count=${count})`, count === 2);

        await clean(c);
        await c.quit();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 6 — __shutdown__ does NOT preempt a queued job signal
    // Add a job, immediately stop — the job must still be processed.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 6: __shutdown__ does not preempt queued job signal ------');
    {
        const c = makeConn();
        const q = nextQ();
        await clean(c);

        const queue = new Queue(q, { connection: c, prefix });
        let processed = false;

        const worker = new Worker(q, async () => {
            processed = true;
        }, { connection: c, prefix, concurrency: 1, shutdownTimeout: 3000 });

        await worker.start();

        // Add job and call stop() in the same tick so both signals go to the list
        await queue.add('race-job', {});
        // stop() pushes __shutdown__ to tail via rpush — job signal at head goes first
        await worker.stop();

        assert('job was processed despite immediate stop()', processed === true);

        await clean(c);
        await c.quit();
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
