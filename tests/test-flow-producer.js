// test-flow-producer.js
'use strict';

require('dotenv').config();
const { FlowProducer, Queue, Worker, QueueEvents } = require('../src/index');
const Redis = require('ioredis');

function assert(description, condition) {
    if (!condition) {
        console.error(`  ❌ FAIL  ${description}`);
        throw new Error(`Assertion failed: ${description}`);
    } else {
        console.log(`  ✅ PASS  ${description}`);
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log("====================================================");
    console.log("🔬 FLOWPRODUCER (DAG FLOW) TEST SUITE");
    console.log("====================================================");

    const connectionOpts = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const connection = new Redis(connectionOpts, {
        maxRetriesPerRequest: null,
    });

    const prefix = `flow_test_${Date.now()}`;
    const parentQueueName = 'parent-q';
    const childQueueName = 'child-q';

    const flowProducer = new FlowProducer({ connection: connectionOpts, prefix });
    
    let childWorker = null;
    let parentWorker = null;
    let parentEvents = null;
    let parentQueue = null;
    let childQueue = null;

    try {
        // Define tree flow
        const flow = {
            name: 'parent-job',
            queueName: parentQueueName,
            data: { val: 'parent' },
            children: [
                { name: 'child-job-1', queueName: childQueueName, data: { val: 1 } },
                { name: 'child-job-2', queueName: childQueueName, data: { val: 2 } }
            ]
        };

        console.log(`Using unique prefix: ${prefix}`);
        console.log("Adding DAG tree flow using FlowProducer...");
        const parentJobId = await flowProducer.add(flow);
        console.log(`Flow created! Parent Job ID: ${parentJobId}`);

        // Verify initial states in Redis
        parentQueue = new Queue(parentQueueName, { connection: connectionOpts, prefix });
        childQueue = new Queue(childQueueName, { connection: connectionOpts, prefix });

        const parentJob = await parentQueue.getJob(parentJobId);
        assert("Parent job status is originally 'blocked'", parentJob.status === 'blocked');

        const childrenList = await connection.lrange(`${prefix}:${childQueueName}`, 0, -1);
        assert("Child queue contains exactly 2 waiting jobs", childrenList.length === 2);

        const executionOrder = [];

        // Start Worker for children
        childWorker = new Worker(childQueueName, async (job) => {
            executionOrder.push(job.name);
            console.log(`Processed child job: ${job.name}`);
        }, {
            connection: connectionOpts,
            prefix,
            concurrency: 1
        });

        // Start Worker for parent
        parentWorker = new Worker(parentQueueName, async (job) => {
            executionOrder.push(job.name);
            console.log(`Processed parent job: ${job.name}`);
        }, {
            connection: connectionOpts,
            prefix,
            concurrency: 1
        });

        // Setup QueueEvents to wait for parent completion
        parentEvents = new QueueEvents(parentQueueName, { connection: connectionOpts, prefix });
        const parentCompletedPromise = new Promise((resolve) => {
            const listener = (data) => {
                if (data.jobId === parentJobId) {
                    parentEvents.off('completed', listener);
                    resolve();
                }
            };
            parentEvents.on('completed', listener);
        });

        await childWorker.start();
        await parentWorker.start();

        // Await parent completion (which happens only after children are done)
        await parentCompletedPromise;

        // Verify execution order
        console.log("Execution Order:", executionOrder);
        assert("Three jobs were executed in total", executionOrder.length === 3);
        assert("Child job 1 was executed first", executionOrder[0].startsWith('child-job'));
        assert("Child job 2 was executed second", executionOrder[1].startsWith('child-job'));
        assert("Parent job was executed last", executionOrder[2] === 'parent-job');

        console.log("\n====================================================");
        console.log("🎉 ALL FLOWPRODUCER DAG TESTS PASSED!");
        console.log("====================================================");
    } finally {
        // Stop all workers and close connections
        console.log("Shutting down workers and connections...");
        if (childWorker) await childWorker.stop();
        if (parentWorker) await parentWorker.stop();
        if (parentEvents) await parentEvents.close();
        if (parentQueue) await parentQueue.close();
        if (childQueue) await childQueue.close();

        // Cleanup Redis keys for this prefix
        const keys = await connection.keys(`${prefix}:*`);
        if (keys.length > 0) {
            await connection.del(...keys);
        }
        await connection.quit();
    }
    process.exit(0);
}

runTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
