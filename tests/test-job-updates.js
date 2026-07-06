// test-job-updates.js
'use strict';

require('dotenv').config();
const { Queue, Worker, Scheduler, QueueEvents } = require('../src/index');
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
    console.log("🔬 JOB UPDATE & DELAY CHANGE TEST SUITE");
    console.log("====================================================");

    const connectionOpts = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const connection = new Redis(connectionOpts, {
        maxRetriesPerRequest: null,
    });

    const prefix = 'update_test';
    const queueName = 'test-update-q';

    // Clean keys
    const keys = await connection.keys(`${prefix}:*`);
    if (keys.length > 0) {
        await connection.del(...keys);
    }

    const queue = new Queue(queueName, { connection: connectionOpts, prefix });
    const queueEvents = new QueueEvents(queueName, { connection: connectionOpts, prefix });

    // 1. Test Job.update on waiting job
    console.log("\n1. Testing Job.update() on waiting job...");
    const jobId1 = await queue.add('test-job-1', { original: true }, { maxretries: 1 });
    let job1 = await queue.getJob(jobId1);
    assert("Retrieved job has original data", job1.data.original === true);

    await job1.update({ original: false, updated: true });
    
    // Fetch again from queue to verify it persisted to Redis
    let job1Updated = await queue.getJob(jobId1);
    assert("Updated data persisted in Redis", job1Updated.data.updated === true && job1Updated.data.original === false);

    // 2. Test Queue.updateJob helper
    console.log("\n2. Testing Queue.updateJob() helper...");
    await queue.updateJob(jobId1, { helperUpdated: true });
    let job1HelperUpdated = await queue.getJob(jobId1);
    assert("Data updated via Queue helper persisted", job1HelperUpdated.data.helperUpdated === true);

    // 3. Test Job.update on a completed/failed job (DLQ)
    console.log("\n3. Testing Job.update() on DLQ job...");
    const worker = new Worker(queueName, async (job) => {
        throw new Error("Force fail");
    }, {
        connection: connectionOpts,
        prefix,
        concurrency: 1
    });
    await worker.start();

    const failedPromise = new Promise((resolve) => {
        const listener = (data) => {
            if (data.jobId === jobId1) {
                queueEvents.off('failed', listener);
                resolve();
            }
        };
        queueEvents.on('failed', listener);
    });

    // Let the worker process job1 (which will fail)
    await failedPromise;
    await worker.stop();

    let job1Failed = await queue.getJob(jobId1);
    assert("Job is in dead/failed status", job1Failed.status === 'dead');

    await job1Failed.update({ dlqUpdated: true });
    let job1DlqUpdated = await queue.getJob(jobId1);
    assert("DLQ job data updated successfully", job1DlqUpdated.data.dlqUpdated === true);

    // 4. Test Job.changeDelay on delayed job
    console.log("\n4. Testing Job.changeDelay() and Scheduler wakeup...");
    
    // Add job with 100-second delay
    const jobId2 = await queue.add('test-job-2', { step: 1 }, { delay: 100000 });
    let job2 = await queue.getJob(jobId2);
    assert("Job is originally delayed", job2.delay === 100000);

    // Start Scheduler
    const scheduler = new Scheduler(queueName, { connection: connectionOpts, prefix });
    scheduler.start();
    scheduler.delayedjobs();

    // Now change delay to 500ms
    await job2.changeDelay(500);

    // Setup worker and queue events to verify it gets processed quickly
    let processedJob2 = false;
    const worker2 = new Worker(queueName, async (job) => {
        if (job.id === jobId2) {
            processedJob2 = true;
        }
    }, {
        connection: connectionOpts,
        prefix,
        concurrency: 1
    });

    const completedPromise2 = new Promise((resolve) => {
        const listener = (data) => {
            if (data.jobId === jobId2) {
                queueEvents.off('completed', listener);
                resolve();
            }
        };
        queueEvents.on('completed', listener);
    });

    await worker2.start();

    // Await execution
    await completedPromise2;
    await worker2.stop();
    await scheduler.stop();

    assert("Delayed job was processed after changeDelay() promoted it", processedJob2 === true);

    // Cleanup
    await queueEvents.close();
    await queue.close();
    
    const keysAfter = await connection.keys(`${prefix}:*`);
    if (keysAfter.length > 0) {
        await connection.del(...keysAfter);
    }
    await connection.quit();

    console.log("\n====================================================");
    console.log("🎉 ALL JOB UPDATE & DELAY TESTS PASSED!");
    console.log("====================================================");
    process.exit(0);
}

runTests().catch(err => {
    console.error("Test suite failed:", err);
    process.exit(1);
});
