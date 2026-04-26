const { Queue, Worker, Scheduler } = require('./src/index');

const queueName = 'time-travel-test';
const myQueue = new Queue(queueName);
const myWorker = new Worker(queueName, async (job) => {
    console.log(`✅ [${new Date().toLocaleTimeString()}] Executing: ${job.name} (ID: ${job.id})`);
});
const myScheduler = new Scheduler(queueName);

async function runTest() {
    console.log("🚀 PHASE 3 ENGINE TEST STARTING...");
    
    // 1. Start the components
    myWorker.start();
    myScheduler.start(); // Watchdog loop
    myScheduler.delayedjobs(); // The signaling scheduling loop
    
    // TEST 1: DELAYED JOB (8 seconds)
    console.log("⏳ Scheduling a 8-second delayed job...");
    await myQueue.add('delayed-task', { info: 'late-arrival' }, { delay: 8000 });

    // TEST 2: CRON JOB (Every 5 seconds)
    console.log("🕒 Scheduling a Cron job (every 5 seconds)...");
    await myQueue.add('heartbeat', { info: 'thump-thump' }, { repeat: '*/5 * * * * *' });

    // TEST 3: SIGNAL INTERRUPT TEST
    console.log("📡 SIGNAL TEST: Scheduling a 1-minute job, then a 2-second job...");
    await myQueue.add('one-minute-job', {}, { delay: 60000 });
    
    await new Promise(r => setTimeout(r, 2000)); // Wait a bit
    
    console.log("📡 Adding the fast job now (should wake up scheduler instantly)...");
    await myQueue.add('fast-job', {}, { delay: 2000 });

    console.log("\n👀 Sit back and watch the logs for 30 seconds...\n");
}

runTest().catch(console.error);
