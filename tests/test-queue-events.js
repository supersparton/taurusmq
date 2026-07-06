// test-queue-events.js
'use strict';

require('dotenv').config();
const { Queue, Worker, Scheduler, QueueEvents } = require('../src/index');
const { getRedisClient } = require('../src/utils/redis');
const Redis = require('ioredis');

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
    console.log("🚀 STARTING TAURUSMQ QUEUE EVENTS TEST SUITE...");

    const connectionOpts = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const connection = new Redis(connectionOpts, {
        maxRetriesPerRequest: null,
    });
    
    const prefix = 'events_test';
    const queueName = 'test-events-q';

    // Clear previous keys
    const keysBefore = await connection.keys(`${prefix}:*`);
    if (keysBefore.length > 0) {
        await connection.del(...keysBefore);
    }

    const queue = new Queue(queueName, { connection: connectionOpts, prefix });
    const queueEvents = new QueueEvents(queueName, { connection: connectionOpts, prefix });

    const receivedEvents = [];
    
    const eventHandler = (eventName) => (data) => {
        console.log(`[QueueEvents] Event received: ${eventName}`, data);
        receivedEvents.push({ event: eventName, ...data });
    };

    queueEvents.on('waiting', eventHandler('waiting'));
    queueEvents.on('active', eventHandler('active'));
    queueEvents.on('completed', eventHandler('completed'));
    queueEvents.on('failed', eventHandler('failed'));
    queueEvents.on('progress', eventHandler('progress'));
    queueEvents.on('paused', eventHandler('paused'));
    queueEvents.on('resumed', eventHandler('resumed'));
    queueEvents.on('drained', eventHandler('drained'));
    queueEvents.on('stalled', eventHandler('stalled'));
    queueEvents.on('removed', eventHandler('removed'));

    await sleep(500); // let subscriber connect

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: Pause / Resume events
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- TEST 1: Pause & Resume events ---");
    await queue.pause();
    await sleep(500);
    await queue.resume();
    await sleep(500);

    const hasPaused = receivedEvents.some(e => e.event === 'paused');
    const hasResumed = receivedEvents.some(e => e.event === 'resumed');
    console.log(`Has paused event? ${hasPaused}`);
    console.log(`Has resumed event? ${hasResumed}`);
    if (!hasPaused || !hasResumed) {
        throw new Error("FAIL: Pause/Resume events not received!");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: Job waiting, active, completed, progress, drained events
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- TEST 2: Job lifecycle events ---");
    const worker = new Worker(queueName, async (job) => {
        console.log(`Processing job ${job.id}`);
        await job.updateProgress(42);
        await sleep(100);
        return { ok: true };
    }, { connection: connectionOpts, prefix, concurrency: 1 });

    await worker.start();

    const jobId = await queue.add('test-job', { foo: 'bar' });
    console.log(`Enqueued job: ${jobId}`);

    // Wait for completion and drained events
    let done = false;
    for (let i = 0; i < 30; i++) {
        const hasCompleted = receivedEvents.some(e => e.event === 'completed' && e.jobId === jobId);
        const hasDrained = receivedEvents.some(e => e.event === 'drained');
        if (hasCompleted && hasDrained) {
            done = true;
            break;
        }
        await sleep(200);
    }

    if (!done) {
        throw new Error("FAIL: Completed or Drained events not received!");
    }

    const waitingEvent = receivedEvents.find(e => e.event === 'waiting' && e.jobId === jobId);
    const activeEvent = receivedEvents.find(e => e.event === 'active' && e.jobId === jobId);
    const progressEvent = receivedEvents.find(e => e.event === 'progress' && e.jobId === jobId);
    const completedEvent = receivedEvents.find(e => e.event === 'completed' && e.jobId === jobId);

    if (!waitingEvent) throw new Error("FAIL: Waiting event missing!");
    if (!activeEvent) throw new Error("FAIL: Active event missing!");
    if (!progressEvent || progressEvent.data !== 42) throw new Error("FAIL: Progress event missing or wrong data!");
    if (!completedEvent || completedEvent.returnvalue.ok !== true) throw new Error("FAIL: Completed event missing or wrong returnvalue!");

    console.log("SUCCESS: Basic lifecycle events verified!");

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3: Job failure event
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- TEST 3: Job failure event ---");
    const failId = await queue.add('fail-job', { fail: true });
    
    // Set worker handler to fail
    worker.handler = async (job) => {
        throw new Error("test-failure");
    };

    let failDone = false;
    for (let i = 0; i < 30; i++) {
        const hasFailed = receivedEvents.some(e => e.event === 'failed' && e.jobId === failId);
        if (hasFailed) {
            failDone = true;
            break;
        }
        await sleep(200);
    }

    if (!failDone) {
        throw new Error("FAIL: Failed event not received!");
    }

    const failedEvent = receivedEvents.find(e => e.event === 'failed' && e.jobId === failId);
    if (!failedEvent || failedEvent.failedReason !== "test-failure") {
        throw new Error("FAIL: Wrong failure details!");
    }

    console.log("SUCCESS: Failure event verified!");

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4: Job stall events
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- TEST 4: Job stall events ---");
    // Stop the worker so job remains active/stuck
    await worker.stop();

    const stallId = await queue.add('stall-job', {}, { maxretries: 2 });
    
    // Simulate pick up and crash using getRedisClient to register Lua commands
    const connectionSlot = getRedisClient(connectionOpts, true);
    await connectionSlot.blpop(queue.rediskeysignal, 1);
    const jobjson = await connectionSlot.dequeue(
        queue.rediskey,
        `${prefix}:active:${queueName}`,
        `${prefix}:jobs:${queueName}`,
        queue.rediskeyprioritized,
        Date.now() + 30000
    );
    connectionSlot.disconnect();

    const jobObj = JSON.parse(jobjson);
    // Move processedOn back to simulate stall timeout
    jobObj.processedOn = Date.now() - 5000;
    await connection.zadd(`${prefix}:active:${queueName}`, Date.now() - 1000, stallId);
    await connection.hset(`${prefix}:jobs:${queueName}`, stallId, JSON.stringify(jobObj));

    // Create scheduler with stall timeout of 200ms
    const scheduler = new Scheduler(queueName, { connection: connectionOpts, prefix, timeout: 200 });
    scheduler.start();

    let stallDone = false;
    for (let i = 0; i < 50; i++) {
        const hasStalled = receivedEvents.some(e => e.event === 'stalled' && e.jobId === stallId);
        if (hasStalled) {
            stallDone = true;
            break;
        }
        await sleep(200);
    }

    await scheduler.stop();

    if (!stallDone) {
        throw new Error("FAIL: Stalled event not received!");
    }
    console.log("SUCCESS: Stalled event verified!");

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5: Job removed event
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- TEST 5: Job removed event ---");
    const removeId = await queue.add('remove-job', {});
    await queue.removeJob(removeId);

    // Maintenance engine handles background deletion
    const { Maintenance } = require('../src/index');
    const maintenance = new Maintenance({ connection: connectionOpts, prefix });
    await maintenance.start();

    let removeDone = false;
    for (let i = 0; i < 30; i++) {
        const hasRemoved = receivedEvents.some(e => e.event === 'removed' && e.jobId === removeId);
        if (hasRemoved) {
            removeDone = true;
            break;
        }
        await sleep(200);
    }

    await maintenance.stop();

    if (!removeDone) {
        throw new Error("FAIL: Removed event not received!");
    }
    console.log("SUCCESS: Removed event verified!");

    // Cleanup
    await queueEvents.close();
    await queue.close();
    connection.disconnect();

    console.log("\n🎉 ALL TAURUSMQ QUEUE EVENTS TESTS PASSED!");
    process.exit(0);
}

runTests().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
