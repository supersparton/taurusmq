// test-queue-getters.js
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

async function runTests() {
    console.log("====================================================");
    console.log("🔬 QUEUE GETTER METHODS TEST SUITE");
    console.log("====================================================");

    const connectionOpts = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const connection = new Redis(connectionOpts, {
        maxRetriesPerRequest: null,
    });

    const prefix = 'getter_test';
    const queueName = 'test-getter-q';

    // Clean keys
    const keys = await connection.keys(`${prefix}:*`);
    if (keys.length > 0) {
        await connection.del(...keys);
    }

    const queue = new Queue(queueName, { connection: connectionOpts, prefix });
    const queueEvents = new QueueEvents(queueName, { connection: connectionOpts, prefix });

    const waitForEvent = (eventName, jobId) => {
        return new Promise((resolve) => {
            const listener = (data) => {
                if (data.jobId === jobId) {
                    queueEvents.off(eventName, listener);
                    resolve(data);
                }
            };
            queueEvents.on(eventName, listener);
        });
    };

    // 1. Add some jobs in different states
    console.log("\n1. Enqueuing jobs of different states...");
    
    // Add delayed job
    const jDelayed = await queue.add('job-delayed', { state: 'delayed' }, { delay: 100000 });

    // Add active, completed, and failed jobs using a worker
    const worker = new Worker(queueName, async (job) => {
        if (job.name === 'job-active-target') {
            // Keep it active for a long time so we can query active state
            return new Promise((resolve) => {
                setTimeout(() => resolve({ activeDone: true }), 10000);
            });
        }
        if (job.name === 'job-fail-target') {
            throw new Error("Simulated job failure");
        }
        return { success: true };
    }, {
        connection: connectionOpts,
        prefix,
        concurrency: 1
    });

    await worker.start();

    // Add job to succeed (completed state)
    const jSuccess = await queue.add('job-success-target', { val: 1 });
    await waitForEvent('completed', jSuccess);
    console.log(`[Test] job-success-target completed: ${jSuccess}`);

    // Add job to fail (failed state)
    const jFail = await queue.add('job-fail-target', { val: 2 }, { maxretries: 1 });
    await waitForEvent('failed', jFail);
    console.log(`[Test] job-fail-target failed: ${jFail}`);

    // Add job that will remain active
    const jActive = await queue.add('job-active-target', { val: 3 });
    await waitForEvent('active', jActive);
    console.log(`[Test] job-active-target is now active: ${jActive}`);

    // Now that worker is busy, add the waiting job
    const jWaiting = await queue.add('job-waiting', { state: 'waiting' });
    console.log(`[Test] job-waiting added: ${jWaiting}`);

    // Wait a brief moment to ensure all updates settle on Redis side
    await new Promise(r => setTimeout(r, 200));

    console.log("\n2. Testing getJobCounts...");
    const counts = await queue.getJobCounts();
    console.log("Counts object:", counts);
    assert("Waiting count is 1", counts.waiting === 1);
    assert("Active count is 1", counts.active === 1);
    assert("Delayed count is 1", counts.delayed === 1);
    assert("Completed count is 1", counts.completed === 1);
    assert("Failed count is 1", counts.failed === 1);

    console.log("\n3. Testing getJob...");
    const jobWaiting = await queue.getJob(jWaiting);
    assert("Retrieved waiting job name matches", jobWaiting && jobWaiting.name === 'job-waiting');
    assert("Retrieved waiting job status matches", jobWaiting && jobWaiting.status === 'waiting');

    const jobSuccess = await queue.getJob(jSuccess);
    assert("Retrieved completed job status is completed", jobSuccess && jobSuccess.status === 'completed');
    assert("Retrieved completed job returnvalue is correct", jobSuccess && jobSuccess.returnvalue && jobSuccess.returnvalue.success === true);

    const jobFail = await queue.getJob(jFail);
    assert("Retrieved failed job status is dead", jobFail && jobFail.status === 'dead');

    console.log("\n4. Testing getJobs...");
    const waitingJobs = await queue.getJobs('waiting');
    assert("getJobs('waiting') returns 1 job", waitingJobs.length === 1);
    assert("getJobs('waiting')[0] ID matches jWaiting", waitingJobs[0].id === jWaiting);

    const activeJobs = await queue.getJobs('active');
    assert("getJobs('active') returns 1 job", activeJobs.length === 1);
    assert("getJobs('active')[0] ID matches jActive", activeJobs[0].id === jActive);

    const completedJobs = await queue.getJobs('completed');
    assert("getJobs('completed') returns 1 job", completedJobs.length === 1);
    assert("getJobs('completed')[0] ID matches jSuccess", completedJobs[0].id === jSuccess);

    const failedJobs = await queue.getJobs('failed');
    assert("getJobs('failed') returns 1 job", failedJobs.length === 1);
    assert("getJobs('failed')[0] ID matches jFail", failedJobs[0].id === jFail);

    const allJobs = await queue.getJobs();
    assert("getJobs() with no types returns all 5 jobs", allJobs.length === 5);

    // Stop worker and clean up
    await worker.stop();
    await queueEvents.close();
    await queue.close();
    
    const keysAfter = await connection.keys(`${prefix}:*`);
    if (keysAfter.length > 0) {
        await connection.del(...keysAfter);
    }
    await connection.quit();

    console.log("\n====================================================");
    console.log("🎉 ALL QUEUE GETTER TESTS PASSED!");
    console.log("====================================================");
    process.exit(0);
}

runTests().catch(err => {
    console.error("Test suite failed:", err);
    process.exit(1);
});
