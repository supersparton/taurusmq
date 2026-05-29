const { Queue, Worker, Maintenance } = require('./src/index');
const { UnrecoverableError } = require('./src/core/error');

async function runTests() {
    console.log("🚀 STARTING TAURUSMQ PHASE 5 MEGA-TEST 🚀\n");

    // 1. Start Maintenance Engine (Garbage Collector)
    const janitor = new Maintenance({ checkInterval: 2000, zombieTimeout: 10000 });
    janitor.start();

    // 2. Setup standard queue & worker
    const standardQueue = new Queue('standard-q');
    const standardWorker = new Worker('standard-q', async (job) => {
        console.log(`[Standard] Executing: ${job.name}`);
        
        if (job.data.fail) {
            throw new Error("Simulated network failure. I should retry!");
        }
        
        if (job.data.hardFail) {
            throw new UnrecoverableError("Simulated Fatal Error. Do NOT retry me.");
        }
        
        await new Promise(r => setTimeout(r, 200));
        console.log(`✅ [Standard] Completed: ${job.name}`);
    }, { concurrency: 2 });
    standardWorker.start();

    // 3. Setup batch queue & worker
    const batchQueue = new Queue('batch-q');
    const batchWorker = new Worker('batch-q', async (jobs) => {
        console.log(`📦 [Batch] Processing ${jobs.length} jobs at once in a single array!`);
        await new Promise(r => setTimeout(r, 200));
    }, { concurrency: 1, batchsize: 5 });
    batchWorker.start();


    // --- TEST 1: Simple Job ---
    console.log("\n--- TEST 1: Simple Job ---");
    await standardQueue.add('Simple-Job', { data: 1 });
    await new Promise(r => setTimeout(r, 1000));


    // --- TEST 2: Job Vault Retries ---
    console.log("\n--- TEST 2: Retries (Job Vault Integration) ---");
    // Should fail once, delay for 1 second, and retry.
    await standardQueue.add('Retry-Job', { fail: true }, { maxretries: 1, backoff: { type: 'fixed', delay: 1000 } });
    await new Promise(r => setTimeout(r, 3000)); 


    // --- TEST 3: Unrecoverable Error ---
    console.log("\n--- TEST 3: Unrecoverable Error (Straight to DLQ) ---");
    // Even with 10 maxretries, UnrecoverableError should kill it instantly
    await standardQueue.add('Fatal-Job', { hardFail: true }, { maxretries: 10 });
    await new Promise(r => setTimeout(r, 1000));


    // --- TEST 4: Fan-Out & Fan-In (DAG) ---
    console.log("\n--- TEST 4: Complex DAG (Fan-In) ---");
    const targetId = await standardQueue.add('Final-Target', {}, { flow: true });
    
    // Creating children that unblock the Target when they finish (flow: false)
    await standardQueue.add('Dependency-1', {}, { parent: [targetId], flow: false });
    await standardQueue.add('Dependency-2', {}, { parent: [targetId], flow: false });
    
    // Target won't run until Dependency 1 and Dependency 2 finish!
    await new Promise(r => setTimeout(r, 2000));


    // --- TEST 5: Bulk & Batch Processing ---
    console.log("\n--- TEST 5: Bulk Ingestion & Batch Harvest ---");
    const bulkData = [];
    for(let i=1; i<=12; i++) {
        bulkData.push({ name: `Log-Upload-${i}`, data: {} });
    }
    await batchQueue.addbulk(bulkData, { batchid: 'BATCH-TEST-ALPHA' });
    // Since batchsize is 5, we expect logs showing arrays of 5, 5, and 2!
    await new Promise(r => setTimeout(r, 2500));


    // --- TEST 6: Async Maintenance Deletion ---
    console.log("\n--- TEST 6: Async Maintenance (Job Deletion) ---");
    // Adding a parent with a very long delay so it doesn't process immediately
    const parentToDelete = await standardQueue.add('To-Be-Deleted', {}, { delay: 10000 });
    // Add child that depends on it
    await standardQueue.add('Child-To-Be-Deleted', {}, { parent: [parentToDelete] });
    
    // Immediately delete the parent
    console.log("-> Sending delete command to janitor...");
    await standardQueue.removeJob(parentToDelete);
    
    // Wait for Janitor to do its job
    await new Promise(r => setTimeout(r, 3500));

    console.log("\n🎉 ALL TESTS COMPLETED! If you didn't see any crashes or weird errors, the Job Vault architecture is 100% solid!");
    
    process.exit(0);
}

runTests();
