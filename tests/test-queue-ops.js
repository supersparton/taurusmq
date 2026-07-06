const { Queue, Worker, QueueEvents } = require('../src/index');
const Redis = require('ioredis');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log("🚀 STARTING TAURUSMQ QUEUE OPERATIONS TEST SUITE...");

    const customConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: null,
    });
    
    const prefix = 'custom_prefix';
    const queueName = 'test-queue-ops';
    
    // Clear any leftover test data
    const keysBefore = await customConnection.keys(`${prefix}:*`);
    if (keysBefore.length > 0) {
        await customConnection.del(...keysBefore);
    }
    
    // 1. Verify Queue Creation & Connection sharing
    console.log("\n1. Testing Queue creation with custom prefix and shared connection...");
    const queue = new Queue(queueName, {
        connection: customConnection,
        prefix
    });
    
    const jobId1 = await queue.add('test-job', { value: 42 });
    console.log(`Job added. ID: ${jobId1}`);
    
    // Check if the keys in Redis are indeed namespaced with the prefix
    const keys = await customConnection.keys(`${prefix}:*`);
    console.log(`Found keys matching prefix '${prefix}:':`, keys);
    if (!keys.some(k => k.includes(`${prefix}:jobs:${queueName}`))) {
        throw new Error("FAIL: Custom prefix not applied to keys!");
    }
    console.log("PASS: Custom prefix successfully applied to Redis keys.");
    
    // 2. Testing Pause & Resume
    console.log("\n2. Testing Event-Driven Pause & Resume...");
    console.log("Pausing queue...");
    await queue.pause();
    
    const isPaused = await queue.isPaused();
    console.log(`Is queue paused? ${isPaused}`);
    if (!isPaused) {
        throw new Error("FAIL: Queue reports not paused after calling pause()!");
    }
    
    let processedCount = 0;
    const worker = new Worker(queueName, async (job) => {
        console.log(`[Worker] Processing job ${job.id}`);
        processedCount++;
    }, {
        connection: customConnection,
        prefix
    });
    
    await worker.start();
    
    // Add a job while paused
    const jobId2 = await queue.add('test-job-paused', { value: 100 });
    console.log(`Job ${jobId2} added while paused. Waiting 500ms to verify worker doesn't process it...`);
    await sleep(500);
    
    if (processedCount > 0) {
        throw new Error("FAIL: Worker processed job while the queue was paused!");
    }
    console.log("PASS: Worker remained idle while queue was paused.");
    
    console.log("Resuming queue...");
    const queueEvents = new QueueEvents(queueName, { connection: customConnection, prefix });
    const completedJobs = new Set();
    const onCompleted = (data) => {
        completedJobs.add(data.jobId);
    };
    queueEvents.on('completed', onCompleted);

    await queue.resume();
    const isPausedAfterResume = await queue.isPaused();
    console.log(`Is queue paused? ${isPausedAfterResume}`);
    if (isPausedAfterResume) {
        throw new Error("FAIL: Queue reports paused after calling resume()!");
    }
    
    // Wait for both jobs to complete
    let attempts = 0;
    while ((!completedJobs.has(jobId1) || !completedJobs.has(jobId2)) && attempts < 50) {
        await sleep(200);
        attempts++;
    }
    
    queueEvents.off('completed', onCompleted);
    await queueEvents.close();

    console.log(`Processed jobs count: ${processedCount}`);
    if (processedCount < 2) {
        throw new Error(`FAIL: Worker did not process the jobs after resume. Processed: ${processedCount}`);
    }
    console.log("PASS: Worker successfully resumed and processed jobs.");
    
    // 3. Testing Drain
    console.log("\n3. Testing Queue Drain...");
    // Pause worker to queue jobs up
    await worker.stop();
    await queue.add('drain-job-1', { value: 1 });
    await queue.add('drain-job-2', { value: 2 });
    
    console.log("Draining queue...");
    await queue.drain();
    
    // Verify no jobs remain in waiting list
    const len = await customConnection.llen(`${prefix}:${queueName}`);
    console.log(`Waiting jobs list length after drain: ${len}`);
    if (len > 0) {
        throw new Error("FAIL: Queue waiting list not empty after drain!");
    }
    console.log("PASS: Queue successfully drained.");
    
    // 4. Testing Clean
    console.log("\n4. Testing Queue Clean...");
    // Re-create worker to process a job and mark it complete
    const cleanWorker = new Worker(queueName, async (job) => {
        console.log(`[CleanWorker] Processing job ${job.id}`);
    }, {
        connection: customConnection,
        prefix
    });
    await cleanWorker.start();
    
    const cleanQueueEvents = new QueueEvents(queueName, { connection: customConnection, prefix });
    await sleep(500); // Wait for subscription to establish
    const cleanCompleted = new Promise((resolve) => {
        const listener = (data) => {
            if (data.jobId === jobIdClean) {
                cleanQueueEvents.off('completed', listener);
                resolve();
            }
        };
        cleanQueueEvents.on('completed', listener);
    });

    const jobIdClean = await queue.add('clean-job', { value: 99 });
    await cleanCompleted;
    await cleanQueueEvents.close();
    
    console.log("Cleaning completed jobs...");
    const cleaned = await queue.clean(0, 10, 'completed');
    console.log(`Cleaned jobs count: ${cleaned}`);
    if (cleaned === 0) {
        throw new Error("FAIL: No jobs cleaned!");
    }
    console.log("PASS: Queue successfully cleaned completed jobs.");
    await cleanWorker.stop();
    
    // 5. Testing Obliterate
    console.log("\n5. Testing Queue Obliterate...");
    console.log("Obliterating queue...");
    await queue.obliterate();
    
    const keysAfter = await customConnection.keys(`${prefix}:*`);
    console.log(`Remaining keys matching prefix '${prefix}:':`, keysAfter);
    if (keysAfter.length > 0) {
        throw new Error(`FAIL: Keys still exist after obliterate: ${keysAfter.join(', ')}`);
    }
    console.log("PASS: Queue successfully obliterated.");
    
    // Cleanup connection
    await customConnection.quit();
    console.log("\n🎉 ALL TESTS PASSED SUCCESSFULLY!");
    process.exit(0);
}

runTests().catch(err => {
    console.error("❌ TEST RUN FAILED:", err);
    process.exit(1);
});
