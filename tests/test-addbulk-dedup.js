// test-addbulk-dedup.js
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
    console.log("🔬 ADDBULK DEDUPLICATION TEST SUITE");
    console.log("====================================================");

    const connectionOpts = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const connection = new Redis(connectionOpts, {
        maxRetriesPerRequest: null,
    });

    const prefix = 'bulk_dedup_test';
    const queueName = 'test-bulk-q';

    // Clean keys
    const keys = await connection.keys(`${prefix}:*`);
    if (keys.length > 0) {
        await connection.del(...keys);
    }

    const queue = new Queue(queueName, { connection: connectionOpts, prefix });

    // 1. Initial bulk enqueue
    console.log("\n1. Enqueuing initial bulk jobs...");
    const jobs1 = [
        { name: 'job1', data: { x: 1 }, options: { jobId: 'dup-id-1' } },
        { name: 'job2', data: { x: 2 }, options: { jobId: 'dup-id-2' } }
    ];
    
    const batchId1 = await queue.addbulk(jobs1, { batchid: 'batch-1' });
    
    const initialListLen = await connection.llen(`${prefix}:${queueName}`);
    assert("Initial list has 2 jobs", initialListLen === 2);
    
    const batch1Count = await connection.get(`${prefix}:batch:batch-1:count`);
    assert("Batch 1 count tracking set to 2", parseInt(batch1Count, 10) === 2);

    // 2. Bulk enqueue with duplicate and new jobs
    console.log("\n2. Enqueuing mixed bulk jobs containing duplicates...");
    const jobs2 = [
        { name: 'job1-dup', data: { x: 10 }, options: { jobId: 'dup-id-1' } }, // Duplicate!
        { name: 'job3', data: { x: 3 }, options: { jobId: 'new-id-3' } }        // New!
    ];

    const batchId2 = await queue.addbulk(jobs2, { batchid: 'batch-2' });

    // Verify waiting list count (should only add job3)
    const listLenAfter = await connection.llen(`${prefix}:${queueName}`);
    assert("Waiting list has 3 jobs (only new job added)", listLenAfter === 3);

    // Verify batch count tracking of the second batch (should be 1 because only 1 job was enqueued)
    const batch2Count = await connection.get(`${prefix}:batch:batch-2:count`);
    assert("Batch 2 count tracking is set to 1 (excluding duplicate)", parseInt(batch2Count, 10) === 1);

    // Verify jobs hash has all three unique IDs
    const jobKeys = await connection.hkeys(`${prefix}:jobs:${queueName}`);
    assert("Jobs hash has exactly 3 unique job IDs", jobKeys.length === 3);
    assert("Jobs hash has dup-id-1", jobKeys.includes('dup-id-1'));
    assert("Jobs hash has dup-id-2", jobKeys.includes('dup-id-2'));
    assert("Jobs hash has new-id-3", jobKeys.includes('new-id-3'));

    // Cleanup
    await queue.close();
    await connection.quit();

    console.log("\n====================================================");
    console.log("🎉 ALL ADDBULK DEDUPLICATION TESTS PASSED!");
    console.log("====================================================");
    process.exit(0);
}

runTests().catch(err => {
    console.error("Test runner crashed:", err);
    process.exit(1);
});
