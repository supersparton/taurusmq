const { Queue, Worker, Scheduler } = require('./src/index');

const queueName = 'reliability-test';
const myQueue = new Queue(queueName);
const myScheduler = new Scheduler(queueName, 5000); // 5 second timeout for testing!

// 1. THIS WORKER WILL FAIL ON PURPOSE
const failingWorker = new Worker(queueName, async (job) => {
    console.log(`🎬 Processing job ${job.id} (Attempt ${job.attempts})...`);
    throw new Error("API_DOWN_ERROR");
});

async function runTest() {
    console.log("🚀 PHASE 2 TEST STARTING...");

    // TASK 1: TEST RETRIES & DLQ
    console.log("\n--- Testing Retries & DLQ ---");
    await myQueue.add('test-retry', { data: 'should-fail' });

    // Start the worker to process the failure
    failingWorker.start();

    // Wait 10 seconds to watch the retries happen
    await new Promise(r => setTimeout(r, 10000));
    failingWorker.active = false; // Stop this worker

    // TASK 2: TEST WATCHDOG (CRASH RECOVERY)
    console.log("\n--- Testing Watchdog (Recovery) ---");

    // We manually put a job in the "Active" hash to simulate a worker that died
    const redis = require('./src/utils/redis');
    const staleJob = { id: 'zombie-123', name: 'ghost-task', timestamp: Date.now() - 10000, attempts: 0, maxretries: 3 };

    console.log("👻 Simulating a crashed worker by placing a stale job in Redis...");
    await redis.hset(`taurusmq:active:${queueName}`, staleJob.id, JSON.stringify(staleJob));

    // Start the Scheduler (Watchdog)
    myScheduler.start();

    console.log("👀 Watchdog is looking for zombies... (Wait 10s)");
}

runTest();
