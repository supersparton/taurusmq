// test-repeatable-jobs.js
'use strict';

require('dotenv').config();
const { Queue } = require('../src/index');
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
    console.log("🔬 REPEATABLE JOBS MANAGEMENT TEST SUITE");
    console.log("====================================================");

    const connectionOpts = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const connection = new Redis(connectionOpts, {
        maxRetriesPerRequest: null,
    });

    const prefix = 'repeat_test';
    const queueName = 'test-repeat-q';

    // Clean keys
    const keys = await connection.keys(`${prefix}:*`);
    if (keys.length > 0) {
        await connection.del(...keys);
    }

    const queue = new Queue(queueName, { connection: connectionOpts, prefix });

    // 1. Verify getRepeatableJobs() returns empty initially
    console.log("\n1. Verifying initial state...");
    const initialJobs = await queue.getRepeatableJobs();
    assert("Initial repeatable jobs list is empty", initialJobs.length === 0);

    // 2. Add repeatable jobs
    console.log("\n2. Adding repeatable jobs...");
    const cron1 = "*/5 * * * *"; // every 5 mins
    const cron2 = "0 0 * * *";   // every day at midnight

    const key1 = await queue.add('repeat-job-1', { data: 1 }, { repeat: cron1 });
    const key2 = await queue.add('repeat-job-2', { data: 2 }, { repeat: cron2 });

    // 3. Verify getRepeatableJobs() lists both jobs
    console.log("\n3. Testing getRepeatableJobs()...");
    const jobs = await queue.getRepeatableJobs();
    assert("Repeatable jobs list length is 2", jobs.length === 2);

    const job1 = jobs.find(j => j.key === key1);
    assert("job1 name is correct", job1 && job1.name === 'repeat-job-1');
    assert("job1 cron is correct", job1 && job1.cron === cron1);
    assert("job1 has a valid next run time score", job1 && typeof job1.next === 'number' && job1.next > Date.now());

    const job2 = jobs.find(j => j.key === key2);
    assert("job2 name is correct", job2 && job2.name === 'repeat-job-2');
    assert("job2 cron is correct", job2 && job2.cron === cron2);
    assert("job2 has a valid next run time score", job2 && typeof job2.next === 'number' && job2.next > Date.now());

    // 4. Remove one repeatable job by cron expression
    console.log("\n4. Testing removeRepeatable() by cron expression...");
    await queue.removeRepeatable(cron1);

    const jobsAfterRemove1 = await queue.getRepeatableJobs();
    assert("Repeatable jobs list length is now 1", jobsAfterRemove1.length === 1);
    assert("job1 was removed", !jobsAfterRemove1.some(j => j.key === key1));
    assert("job2 remains", jobsAfterRemove1.some(j => j.key === key2));

    // 5. Remove the other repeatable job by repeat key directly
    console.log("\n5. Testing removeRepeatable() by key directly...");
    await queue.removeRepeatable(key2);

    const jobsAfterRemove2 = await queue.getRepeatableJobs();
    assert("Repeatable jobs list is empty again", jobsAfterRemove2.length === 0);

    // Verify key deletion in Redis ZSET and Jobs Hash
    const delayedZsetCard = await connection.zcard(`${prefix}:delayed:${queueName}`);
    const jobsHashLen = await connection.hlen(`${prefix}:jobs:${queueName}`);
    assert("Delayed ZSET is empty after removal", delayedZsetCard === 0);
    assert("Jobs Hash is empty after removal", jobsHashLen === 0);

    // Cleanup
    await queue.close();
    await connection.quit();

    console.log("\n====================================================");
    console.log("🎉 ALL REPEATABLE JOBS MANAGEMENT TESTS PASSED!");
    console.log("====================================================");
    process.exit(0);
}

runTests().catch(err => {
    console.error("Test runner crashed:", err);
    process.exit(1);
});
