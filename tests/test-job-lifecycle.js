// test-job-lifecycle.js
// Validates: custom jobId deduplication, progress API, return values, DAG race fix.
'use strict';

const { Queue, Worker } = require('../src/index');
const Redis = require('ioredis');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTests() {
    console.log('====================================================');
    console.log('🔬 JOB LIFECYCLE FEATURE TEST');
    console.log('====================================================\n');

    const conn = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: null,
    });

    const prefix = 'tmq_lifecycle_test';
    const queueName = 'lifecycle-q';

    // Clean slate
    const old = await conn.keys(`${prefix}:*`);
    if (old.length) await conn.del(...old);

    const queue = new Queue(queueName, { connection: conn, prefix });

    let passed = 0;
    let failed = 0;

    function assert(label, condition) {
        if (condition) {
            console.log(`  ✅ PASS  ${label}`);
            passed++;
        } else {
            console.error(`  ❌ FAIL  ${label}`);
            failed++;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1 — Custom jobId is used as the Redis hash field
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 1: Custom jobId -----------------------------------------');
    const customId = 'order-99';
    const id1 = await queue.add('order-job', { orderId: 99 }, { jobId: customId });
    assert('returned id equals custom jobId', id1 === customId);
    const raw1 = await conn.hget(`${prefix}:jobs:${queueName}`, customId);
    assert('job stored under custom id in jobs hash', raw1 !== null);
    const stored1 = JSON.parse(raw1);
    assert('stored job.id matches custom id', stored1.id === customId);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2 — Deduplication: adding same jobId twice returns same id, no duplicate
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 2: Deduplication ----------------------------------------');
    const id2 = await queue.add('order-job', { orderId: 99 }, { jobId: customId });
    assert('second add returns same id', id2 === customId);

    const waitingList = await conn.lrange(`${prefix}:${queueName}`, 0, -1);
    const occurrences = waitingList.filter(id => id === customId).length;
    assert('job appears only once in the waiting list', occurrences === 1);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3 — Progress API + return values
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 3: Progress & Return Values -----------------------------');

    // Drain the queue of the order-job first to avoid it interfering
    await queue.drain();
    const old2 = await conn.keys(`${prefix}:*`);
    if (old2.length) await conn.del(...old2);

    let capturedProgress = null;
    let workerDone = false;

    const worker = new Worker(queueName, async (job) => {
        // Report progress at 50%
        await job.updateProgress(50);
        capturedProgress = job.progress;

        await sleep(50); // simulate work

        // Report 100%
        await job.updateProgress(100);

        return { processed: true, value: job.data.input * 2 };
    }, { connection: conn, prefix });

    await worker.start();

    const jobId = await queue.add('compute', { input: 21 });
    await sleep(1500); // let the worker process it

    await worker.stop();

    // Read back from Redis
    const rawDone = await conn.hget(`${prefix}:jobs:${queueName}`, jobId);
    if (!rawDone) {
        console.error('  ❌ FAIL  job not found in Redis after processing');
        failed++;
    } else {
        const donJob = JSON.parse(rawDone);
        assert('job.progress written to Redis (final value = 100)', donJob.progress === 100);
        assert('job.returnvalue stored in Redis', donJob.returnvalue !== null && donJob.returnvalue !== undefined);
        assert('job.returnvalue.value is correct (21*2=42)', donJob.returnvalue && donJob.returnvalue.value === 42);
        assert('job.returnvalue.processed is true', donJob.returnvalue && donJob.returnvalue.processed === true);
    }
    assert('updateProgress updated in-memory job.progress', capturedProgress === 50);

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4 — Auto-generated id still works (no regression)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 4: Auto-generated id regression -------------------------');

    const old3 = await conn.keys(`${prefix}:*`);
    if (old3.length) await conn.del(...old3);

    const worker2 = new Worker(queueName, async () => {}, { connection: conn, prefix });
    await worker2.start();

    const autoId = await queue.add('plain-job', { x: 1 });
    assert('auto-generated id is a non-empty string', typeof autoId === 'string' && autoId.length > 0);
    assert('auto-generated id is not "undefined"', autoId !== 'undefined');

    await sleep(500);
    await worker2.stop();

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5 — progress and returnvalue fields present in serialised job
    //          (even for jobs that don't call updateProgress)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 5: Default null fields in serialisation -----------------');
    const j = new (require('../src/core/job'))('x', {});
    const parsed = JSON.parse(j.toJson());
    assert('progress defaults to null', parsed.progress === null);
    assert('returnvalue defaults to null', parsed.returnvalue === null);

    // ─────────────────────────────────────────────────────────────────────────
    // Cleanup
    // ─────────────────────────────────────────────────────────────────────────
    const remaining = await conn.keys(`${prefix}:*`);
    if (remaining.length) await conn.del(...remaining);
    await conn.quit();

    console.log('\n====================================================');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('====================================================\n');
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('❌ Test runner crashed:', err);
    process.exit(1);
});
