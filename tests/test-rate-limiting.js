// test-rate-limiting.js
'use strict';

require('dotenv').config();
const { Queue, Worker } = require('../src/index');
const Redis = require('ioredis');

function assert(description, condition) {
    if (!condition) {
        console.error(`  ❌ FAIL  ${description}`);
        process.exit(1);
    } else {
        console.log(`  ✅ PASS  ${description}`);
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log("====================================================");
    console.log("🔬 WORKER RATE LIMITING TEST SUITE");
    console.log("====================================================");

    const connectionOpts = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const connection = new Redis(connectionOpts, {
        maxRetriesPerRequest: null,
    });

    const prefix = 'limit_test';
    const queueName = 'test-limit-q';

    // Clean keys
    const keys = await connection.keys(`${prefix}:*`);
    if (keys.length > 0) {
        await connection.del(...keys);
    }

    const queue = new Queue(queueName, { connection: connectionOpts, prefix });

    // Enqueue 2 jobs
    console.log("Enqueueing 2 jobs...");
    for (let i = 1; i <= 2; i++) {
        await queue.add(`job-${i}`, { id: i });
    }

    // Start Worker with a rate limiter of 1 job per 8000ms
    const processedTimestamps = [];
    const worker = new Worker(queueName, async (job) => {
        processedTimestamps.push(Date.now());
        console.log(`Processed job ${job.id} at ${Date.now()}`);
    }, {
        connection: connectionOpts,
        prefix,
        concurrency: 1,
        limiter: {
            max: 1,
            duration: 1000
        }
    });

    const startTime = Date.now();
    await worker.start();

    // Wait for both jobs to be processed
    console.log("Waiting for rate limiter to process all jobs...");
    const timeout = Date.now() + 20000;
    while (processedTimestamps.length < 2 && Date.now() < timeout) {
        await sleep(100);
    }

    await worker.stop();
    await queue.close();
    await connection.quit();

    assert("Processed all 2 jobs", processedTimestamps.length === 2);
    
    // Check the gap between Job 1 and Job 2
    const gap = processedTimestamps[1] - processedTimestamps[0];
    console.log(`Gap between Job 1 and Job 2 execution: ${gap}ms`);

    // Job 2 must have been throttled and executed after at least 1000ms from Job 1
    assert("Job 2 throttled (> 1000ms gap)", gap >= 950);

    console.log("\n====================================================");
    console.log("🎉 ALL WORKER RATE LIMITING TESTS PASSED!");
    console.log("====================================================");
    process.exit(0);
}

runTests().catch(err => {
    console.error("Test suite failed:", err);
    process.exit(1);
});
