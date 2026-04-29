// test-bulk-tracking.js
const Queue = require('./src/core/queue');
const Worker = require('./src/core/worker');

const migrationQueue = new Queue('user-migration');

const worker = new Worker('user-migration', async (job) => {
    // Process single job
    console.log(`[Migration] Imported User: ${job.data.userId}`);
}, { concurrency: 10 });

worker.start();

async function runBulkTest() {
    const totalJobs = 50;
    const migrationData = [];
    
    for (let i = 1; i <= totalJobs; i++) {
        migrationData.push({
            name: 'Import-User',
            data: { userId: `USR-99${i}`, email: `user${i}@provider.com` },
            options: { maxretries: 2 }
        });
    }

    console.log(`🚀 Bulk enqueuing ${totalJobs} jobs...`);
    
    // We provide a custom batch ID for business tracking
    const myBatchId = 'MIGRATION_TASK_ALPHA';
    await migrationQueue.addbulk(migrationData, { batchid: myBatchId });

    console.log(`📡 Batch created: ${myBatchId}. Watch for 'Batch Completed' log.`);
}

runBulkTest();
