const { Queue, Worker } = require('./src/index');

// 1. Initialize the Queue
// We'll call it 'email-tasks'
const emailQueue = new Queue('email-tasks');

// 2. Initialize the Worker
// Every time a job arrives, it will print "Processing..."
const emailWorker = new Worker('email-tasks', async (job) => {
    console.log(`✅ Worker received task "${job.name}" with ID: ${job.id}`);
    console.log(`   Payload:`, job.data);
});

// 3. Start the worker!
emailWorker.start();

// 4. Add some jobs to the queue
async function runTest() {
    console.log("🚀 Adding jobs to TaurusMQ...");

    await emailQueue.add('send-welcome', { email: 'user1@example.com', name: 'John Doe' });
    await emailQueue.add('send-receipt', { email: 'user2@example.com', amount: '$50.00' });

    console.log("📥 Jobs added successfully!");
}

runTest();
