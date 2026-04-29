// test-flow-false.js
const Queue = require('./src/core/queue');
const Worker = require('./src/core/worker');

const reverseQueue = new Queue('reverse-test');

const worker = new Worker('reverse-test', async (job) => {
    console.log(`[Worker] Executing: ${job.name}`);
}, { concurrency: 2 });

worker.start();

async function runReverseTest() {
    console.log("🚀 Starting Reverse Flow Test (flow: false)...");

    // 1. Target (This is the one that will be woken up)
    const targetId = await reverseQueue.add('Target-Job', {}, { flow: true });

    // 2. Trigger (This one is BLOCKED by the target)
    // We set flow: false so when it finishes, it pokes its PARENT (the target)
    const triggerId = await reverseQueue.add('Trigger-Job', {}, { 
        parent: [targetId], 
        flow: false 
    });

    console.log("✅ triggerId is now waiting for targetId.");
    console.log("✅ When triggerId eventually runs and finishes, it will poke targetId back!");
}

runReverseTest();
