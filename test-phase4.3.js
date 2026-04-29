// test-worker-batching.js
const Queue = require('./src/core/queue');
const Worker = require('./src/core/worker');

const logQueue = new Queue('system-logs');

// CRITICAL: We pass batchsize: 10 in the options
const batchWorker = new Worker('system-logs', async (jobs) => {
    // Note: 'jobs' is an ARRAY here!
    console.log(`-------------------------------------------`);
    console.log(`[Batch-Worker] Received a tray of ${jobs.length} logs!`);
    
    const ids = jobs.map(j => j.data.logId).join(', ');
    console.log(`[Batch-Worker] Processing IDs: ${ids}`);
    
    // Simulate one single DB call for all 10 logs
    await new Promise(r => setTimeout(r, 500));
    console.log(`[Batch-Worker] Successfully saved batch to Database.`);
    console.log(`-------------------------------------------`);
}, { concurrency: 2, batchsize: 10 });

batchWorker.start();

async function runBatchingTest() {
    console.log("🚀 Filling queue with 30 logs...");
    
    const logs = [];
    for (let i = 1; i <= 30; i++) {
        logs.push({ name: 'System-Log', data: { logId: `LOG-X-${i}`, msg: 'CPU High' } });
    }

    // Add them in bulk to the queue
    await logQueue.addbulk(logs);
}

runBatchingTest();
