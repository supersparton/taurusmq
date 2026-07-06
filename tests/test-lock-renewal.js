// test-lock-renewal.js
'use strict';

require('dotenv').config();
const { Queue, Worker, Scheduler, QueueEvents } = require('../src/index');
const Redis = require('ioredis');

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(description, condition) {
    if (!condition) {
        console.error(`  ❌ FAIL  ${description}`);
        process.exit(1);
    } else {
        console.log(`  ✅ PASS  ${description}`);
    }
}

async function runTests() {
    console.log("====================================================");
    console.log("🔬 JOB LOCK / LEASE RENEWAL & WATCHDOG TEST SUITE");
    console.log("====================================================");

    const connectionOpts = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const connection = new Redis(connectionOpts, {
        maxRetriesPerRequest: null,
    });

    const prefix = 'lock_test';
    const queueName = 'test-lock-q';

    // Helper to clean keys
    async function clean() {
        const keys = await connection.keys(`${prefix}:*`);
        if (keys.length > 0) {
            await connection.del(...keys);
        }
    }

    await clean();

    // Register lua commands on the connection so we can call recoverStalled directly
    const fs = require('fs');
    const path = require('path');
    const recoverStalledLua = fs.readFileSync(path.join(__dirname, 'src', 'lua', 'recoverStalled.lua'), 'utf8');
    connection.defineCommand('recoverStalled', {
        numberOfKeys: 6,
        lua: recoverStalledLua
    });

    // ----------------------------------------------------
    // TEST 1: Active lock renewal prevents false stall recovery
    // ----------------------------------------------------
    console.log("\n--- TEST 1: Active lock renewal keeps job alive ------------------");

    const queue = new Queue(queueName, { connection: connectionOpts, prefix });
    
    // Worker lock duration is 600ms, renews every 200ms
    const worker = new Worker(queueName, async (job) => {
        // Job takes 1.2 seconds to run (longer than the 600ms watchdog timeout)
        console.log(`[Worker] Started processing job ${job.id}`);
        for (let i = 0; i < 6; i++) {
            await sleep(200);
            console.log(`[Worker] Processing... (${(i+1)*200}ms)`);
        }
        console.log(`[Worker] Finished processing job ${job.id}`);
        return { done: true };
    }, {
        connection: connectionOpts,
        prefix,
        concurrency: 1,
        lockDuration: 600,
        lockRenewTime: 200
    });

    const queueEvents = new QueueEvents(queueName, { connection: connectionOpts, prefix });
    let stalledEvents = 0;
    queueEvents.on('stalled', (data) => {
        console.log(`[QueueEvents] Stall event received:`, data);
        stalledEvents++;
    });

    await worker.start();

    // Add a job
    const jobId = await queue.add('test-job', { foo: 'bar' });
    console.log(`Job added: ${jobId}`);

    // Run a manual watchdog tick every 500ms for 6 seconds
    const watchdogInterval = setInterval(async () => {
        try {
            const now = Date.now();
            const recoveredCount = await connection.recoverStalled(
                `${prefix}:active:${queueName}`,
                `${prefix}:${queueName}`,
                `${prefix}:signal:${queueName}`,
                `${prefix}:prioritized:${queueName}`,
                `${prefix}:jobs:${queueName}`,
                `${prefix}:dlq:${queueName}`,
                now,
                600 // timeout = 600ms
            );
            if (recoveredCount > 0) {
                console.log(`[Watchdog Mock] Recovered ${recoveredCount} stalled job(s)`);
            }
        } catch (err) {
            console.error(`[Watchdog Mock] Error:`, err);
        }
    }, 500);

    // Wait for the job to complete
    await sleep(1800);

    clearInterval(watchdogInterval);
    await worker.stop();
    await queueEvents.close();

    // Assertions for Test 1
    assert('Job completed successfully without stalling', stalledEvents === 0);

    // Check attempts count in jobs hash
    const jobRaw = await connection.hget(`${prefix}:jobs:${queueName}`, jobId);
    const jobObj = JSON.parse(jobRaw);
    assert('Job has exactly 1 attempt', jobObj.attempts === 1);
    assert('Job status is completed', jobObj.status === 'completed');

    // ----------------------------------------------------
    // TEST 2: Stopped renewal causes job stall recovery
    // ----------------------------------------------------
    console.log("\n--- TEST 2: Expired lease causes stall recovery ------------------");
    await clean();

    const crashedWorker = new Worker(queueName, async (job) => {
        console.log(`[Worker] Started processing job ${job.id}`);
        // We simulate a crash by calling stop() on worker, which clears renewal timers
        console.log(`[Worker] Simulating crash / stopping worker...`);
        await crashedWorker.stop();
        // Await forever to hold connection or job in flight in the async handler
        await sleep(5000);
    }, {
        connection: connectionOpts,
        prefix,
        concurrency: 1,
        lockDuration: 600,
        lockRenewTime: 200
    });

    const queueEvents2 = new QueueEvents(queueName, { connection: connectionOpts, prefix });
    let stalledEvents2 = 0;
    let stalledJobId = null;
    queueEvents2.on('stalled', (data) => {
        console.log(`[QueueEvents] Stall event received:`, data);
        stalledEvents2++;
        stalledJobId = data.jobId;
    });

    await crashedWorker.start();

    // Add job with maxretries = 3
    const jobId2 = await queue.add('crashed-job', { test: 123 }, { maxretries: 3 });
    console.log(`Job added: ${jobId2}`);

    // Wait 1 second for worker to start processing
    await sleep(1000);

    // Now, run manual watchdog ticks. Since crashedWorker is stopped, lease is NOT renewed.
    // After 2000ms from processedOn, the watchdog should recover it.
    let recoveredCountTotal = 0;
    const watchdogInterval2 = setInterval(async () => {
        try {
            const now = Date.now();
            const recoveredCount = await connection.recoverStalled(
                `${prefix}:active:${queueName}`,
                `${prefix}:${queueName}`,
                `${prefix}:signal:${queueName}`,
                `${prefix}:prioritized:${queueName}`,
                `${prefix}:jobs:${queueName}`,
                `${prefix}:dlq:${queueName}`,
                now,
                600 // timeout = 600ms
            );
            if (recoveredCount > 0) {
                console.log(`[Watchdog Mock] Recovered ${recoveredCount} stalled job(s)`);
                recoveredCountTotal += recoveredCount;
            }
        } catch (err) {
            console.error(`[Watchdog Mock] Error:`, err);
        }
    }, 500);

    // Wait for watchdog to tick and recover the job
    await sleep(1500);

    clearInterval(watchdogInterval2);
    await queueEvents2.close();

    assert('Stalled event was received', stalledEvents2 > 0);
    assert('Stalled job matches', stalledJobId === jobId2);

    // Let's verify the job attempts is exactly 1 (worker dequeued it once)
    const jobRaw2 = await connection.hget(`${prefix}:jobs:${queueName}`, jobId2);
    const jobObj2 = JSON.parse(jobRaw2);
    console.log(`Attempts for crashed job: ${jobObj2.attempts}`);
    assert('Job has attempts === 1', jobObj2.attempts === 1);

    await clean();
    await connection.quit();
    console.log("\n====================================================");
    console.log("🎉 ALL LOCK RENEWAL TESTS PASSED!");
    console.log("====================================================");
    process.exit(0);
}

runTests().catch(err => {
    console.error("Test suite failed:", err);
    process.exit(1);
});
