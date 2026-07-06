const { Queue, Worker, Scheduler } = require('../src/index');
const Redis = require('ioredis');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log("🚀 STARTING TAURUSMQ PRIORITY QUEUE & STALL RECOVERY TEST SUITE...");

    const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: null,
    });
    
    const prefix = 'priority_test';
    const queueName = 'test-priority-q';

    // Clear previous keys
    const keysBefore = await connection.keys(`${prefix}:*`);
    if (keysBefore.length > 0) {
        await connection.del(...keysBefore);
    }

    const queue = new Queue(queueName, { connection, prefix });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: Priority Sorting Order
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- TEST 1: Priority Sorting Order ---");
    
    // Add jobs out of order
    console.log("Enqueuing jobs with different priorities...");
    const idA = await queue.add('job-A', { val: 'A' }, { priority: 10 });
    const idB = await queue.add('job-B', { val: 'B' }, { priority: 1 }); // Highest priority
    const idC = await queue.add('job-C', { val: 'C' }, { priority: 5 });
    const idD = await queue.add('job-D', { val: 'D' }); // No priority (should be lowest)
    const idE = await queue.add('job-E', { val: 'E' }, { priority: 5 }); // Equal to C, enqueued later (FIFO test)

    console.log("Jobs enqueued:");
    console.log(` - Job A (priority 10): ${idA}`);
    console.log(` - Job B (priority 1): ${idB}`);
    console.log(` - Job C (priority 5): ${idC}`);
    console.log(` - Job D (no priority): ${idD}`);
    console.log(` - Job E (priority 5): ${idE}`);

    // Inspect Redis state
    const signalLen = await connection.llen(`${prefix}:signal:${queueName}`);
    const prioritizedRange = await connection.zrange(`${prefix}:prioritized:${queueName}`, 0, -1, 'WITHSCORES');
    const waitingList = await connection.lrange(`${prefix}:${queueName}`, 0, -1);
    const jobsKeys = await connection.hkeys(`${prefix}:jobs:${queueName}`);

    console.log("\n--- Redis state before worker starts ---");
    console.log("Signals count:", signalLen);
    console.log("Prioritized ZSET:", prioritizedRange);
    console.log("Waiting list:", waitingList);
    console.log("Jobs hash keys:", jobsKeys);
    console.log("----------------------------------------\n");

    const processedOrder = [];
    const worker = new Worker(queueName, async (job) => {
        console.log(`[Worker] Processing ${job.name} (id: ${job.id}, priority: ${job.priority})`);
        processedOrder.push(job.name);
        await sleep(20);
        console.log(`[Worker] Completed ${job.name}`);
    }, { connection, prefix, concurrency: 1 });

    await worker.start();
    await sleep(8000);
    await worker.stop();

    console.log("Execution order:", processedOrder);
    
    // Expectations:
    // 1. job-B (priority 1)
    // 2. job-C (priority 5)
    // 3. job-E (priority 5) - FIFO order relative to C
    // 4. job-A (priority 10)
    // 5. job-D (no priority)
    const expected = ['job-B', 'job-C', 'job-E', 'job-A', 'job-D'];
    for (let i = 0; i < expected.length; i++) {
        if (processedOrder[i] !== expected[i]) {
            throw new Error(`FAIL: Unexpected execution order at index ${i}. Expected ${expected[i]}, got ${processedOrder[i]}`);
        }
    }
    console.log("✅ PASS: Priority sorting order and FIFO preservation verified successfully!");

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: Stall Recovery & DLQ Migration
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- TEST 2: Stall Recovery & DLQ Migration ---");
    const stallQ = 'test-stall-q';
    
    // Clear stall queue keys
    const stallKeys = await connection.keys(`${prefix}:*:*${stallQ}*`);
    if (stallKeys.length > 0) {
        await connection.del(...stallKeys);
    }

    const qStall = new Queue(stallQ, { connection, prefix });
    
    // Add a job with priority 2, maxretries 2
    const jobId = await qStall.add('stall-job', { data: 123 }, { priority: 2, maxretries: 2 });
    console.log(`Stall job enqueued: ${jobId}`);

    // Create a worker that processes the job, but we'll stop it so the job remains in active state
    let workerActive = true;
    const workerStall = new Worker(stallQ, async (job) => {
        console.log(`[StallWorker] Processing job ${job.id}, attempts: ${job.attempts}`);
        // Keep the job active forever to simulate a crash/stall
        while (workerActive) {
            await sleep(100);
        }
    }, { connection, prefix, concurrency: 1, shutdownTimeout: 500 });

    await workerStall.start();
    await sleep(500); // let it pick it up and process

    // Stop the worker immediately. Since the job loop is stuck in the handler, 
    // it will be force closed on stop.
    console.log("Stopping StallWorker to simulate crash...");
    // Do not set workerActive = false so the job remains stuck in active state
    await workerStall.stop();

    // Now the job is in the active list. Let's verify it is in the active hash.
    const activeScore = await connection.zscore(`${prefix}:active:${stallQ}`, jobId);
    const activeExists = activeScore !== null ? 1 : 0;
    console.log(`Is job active? ${activeExists === 1}`);
    if (activeExists !== 1) {
        throw new Error("FAIL: Job was not in the active hash!");
    }

    // Set up the Scheduler with a very short stall timeout (500ms)
    const scheduler = new Scheduler(stallQ, { connection, prefix, timeout: 500 });
    
    // Let's run recoverStalled manually.
    // 1st Recovery: Attempts goes from 1 to 2. It is recovered to wait/prioritized queue.
    console.log("Triggering 1st stall recovery check...");
    let now = Date.now();
    
    // Force set processedOn to an old time so it's guaranteed to stall
    const jobRaw = await connection.hget(`${prefix}:jobs:${stallQ}`, jobId);
    const parsedJob = JSON.parse(jobRaw);
    parsedJob.processedOn = now - 5000;
    await connection.zadd(`${prefix}:active:${stallQ}`, parsedJob.processedOn + 500, jobId);
    await connection.hset(`${prefix}:jobs:${stallQ}`, jobId, JSON.stringify(parsedJob));

    let recovered = await scheduler.redisClient.recoverStalled(
        scheduler.rediskeyactive,
        scheduler.rediskeywaiting,
        scheduler.rediskeysignal,
        scheduler.rediskeyprioritized,
        `${scheduler.prefix}:jobs:${scheduler.queuename}`,
        `${scheduler.prefix}:dlq:${scheduler.queuename}`,
        now,
        500
    );
    console.log(`1st check: Recovered count: ${recovered}`);
    if (recovered !== 1) {
        throw new Error("FAIL: Job was not recovered during 1st watchdog pass!");
    }

    // Check that job is back in the prioritized ZSET
    const score = await connection.zscore(`${prefix}:prioritized:${stallQ}`, jobId);
    console.log(`Job prioritized ZSET score: ${score}`);
    if (!score) {
        throw new Error("FAIL: Job was not moved back to the prioritized ZSET!");
    }

    // Check attempts count in jobs hash
    const jobJson = await connection.hget(`${prefix}:jobs:${stallQ}`, jobId);
    const jobObj = JSON.parse(jobJson);
    console.log(`Attempts count: ${jobObj.attempts}`);
    if (jobObj.attempts !== 1) {
        throw new Error(`FAIL: Attempts count should be 1, got ${jobObj.attempts}`);
    }

    // 2nd Recovery: Attempts goes from 2 to 3. Since maxretries is 2, it exceeds maxretries.
    // So it must be moved to DLQ.
    // Let's simulate worker picking it up and stalling again.
    // Move it from ZSET to active manually
    await connection.zrem(`${prefix}:prioritized:${stallQ}`, jobId);
    jobObj.attempts = 2; // Simulate worker picking it up (attempts goes 1 -> 2)
    jobObj.processedOn = Date.now() - 5000;
    jobObj.status = 'active';
    await connection.zadd(`${prefix}:active:${stallQ}`, jobObj.processedOn + 500, jobId);
    await connection.hset(`${prefix}:jobs:${stallQ}`, jobId, JSON.stringify(jobObj));

    console.log("Triggering 2nd stall recovery check...");
    now = Date.now();
    recovered = await scheduler.redisClient.recoverStalled(
        scheduler.rediskeyactive,
        scheduler.rediskeywaiting,
        scheduler.rediskeysignal,
        scheduler.rediskeyprioritized,
        `${scheduler.prefix}:jobs:${scheduler.queuename}`,
        `${scheduler.prefix}:dlq:${scheduler.queuename}`,
        now,
        500
    );
    console.log(`2nd check: Recovered count: ${recovered}`);
    if (recovered !== 1) {
        throw new Error("FAIL: Job was not recovered during 2nd watchdog pass!");
    }

    // Verify it is NOT in active, NOT in prioritized, but IN DLQ
    const activeScore2 = await connection.zscore(`${prefix}:active:${stallQ}`, jobId);
    const inActive = activeScore2 !== null ? 1 : 0;
    const inPrioritized = await connection.zscore(`${prefix}:prioritized:${stallQ}`, jobId);
    const inDLQ = await connection.hexists(`${prefix}:dlq:${stallQ}`, jobId);
    
    console.log(`After 2nd recovery:\n - in active: ${inActive === 1}\n - in prioritized: ${inPrioritized !== null}\n - in DLQ: ${inDLQ === 1}`);
    
    if (inActive === 1 || inPrioritized !== null) {
        throw new Error("FAIL: Job still in active or waiting lists after exceeding maxretries!");
    }
    if (inDLQ !== 1) {
        throw new Error("FAIL: Job was not migrated to DLQ after exceeding maxretries!");
    }
    
    const dlqJson = await connection.hget(`${prefix}:dlq:${stallQ}`, jobId);
    const dlqObj = JSON.parse(dlqJson);
    console.log(`Final DLQ job status: ${dlqObj.status}, attempts: ${dlqObj.attempts}`);
    if (dlqObj.status !== 'dead' || dlqObj.attempts !== 2) {
        throw new Error(`FAIL: Incorrect DLQ job fields. Status: ${dlqObj.status}, attempts: ${dlqObj.attempts}`);
    }

    console.log("✅ PASS: Stall recovery and DLQ migration verified successfully!");

    // Clean up
    await scheduler.stop();
    await connection.quit();
    console.log("\n🎉 ALL PRIORITY & STALL TESTS PASSED SUCCESSFULLY!");
    process.exit(0);
}

runTests().catch(async err => {
    console.error("❌ TEST RUN FAILED:", err);
    const conn = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: null,
    });
    const prefix = 'priority_test';
    const queueName = 'test-priority-q';
    console.log("\n--- Redis state after failure ---");
    console.log("Signals list:", await conn.lrange(`${prefix}:signal:${queueName}`, 0, -1));
    console.log("Prioritized ZSET:", await conn.zrange(`${prefix}:prioritized:${queueName}`, 0, -1, 'WITHSCORES'));
    console.log("Waiting list:", await conn.lrange(`${prefix}:${queueName}`, 0, -1));
    console.log("Active Hash:", await conn.hgetall(`${prefix}:active:${queueName}`));
    console.log("Jobs Hash:", await conn.hkeys(`${prefix}:jobs:${queueName}`));
    console.log("---------------------------------\n");
    await conn.quit();
    process.exit(1);
});
