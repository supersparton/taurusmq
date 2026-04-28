const { Queue, Worker } = require('./src/index');

const queueName = 'concurrency-test';
const myQueue = new Queue(queueName);

// Create a worker with CONCURRENCY: 3
const myWorker = new Worker(queueName, async (job) => {
    console.log(`⏳ [${new Date().toLocaleTimeString()}] Worker started job: ${job.name} (Job Data: ${job.data.taskNum})`);
    
    // Simulate a slow task (3 seconds) like downloading a file or calling an API
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log(`✅ [${new Date().toLocaleTimeString()}] Worker FINISHED job: ${job.name} (Job Data: ${job.data.taskNum})`);
}, { concurrency: 3 });

async function runTest() {
    console.log("🚀 PHASE 3.5 ENGINE TEST STARTING (CONCURRENCY)...");
    
    // Start the multi-core worker
    myWorker.start();
    
    console.log("📥 Adding 6 jobs to the queue all at once...\n");
    
    // Add 6 jobs instantly
    for (let i = 1; i <= 6; i++) {
        await myQueue.add('parallel-task', { taskNum: i });
    }

    console.log("\n👀 Watch the timestamps! You should see 3 jobs start immediately... then exactly 3 seconds later, they finish and the next 3 start.\n");
}

runTest().catch(console.error);
