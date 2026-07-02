'use strict';

const { Queue, Worker, Scheduler } = require('./src/index');
const { attachObservability } = require('./packages/observability');

const authDisabled = process.env.TAURUSMQ_AUTH_DISABLED === 'true';
if (!authDisabled) {
  if (!process.env.TAURUSMQ_USERNAME) process.env.TAURUSMQ_USERNAME = 'admin';
  if (!process.env.TAURUSMQ_PASSWORD) process.env.TAURUSMQ_PASSWORD = 'password';
}

async function main() {
  console.log('🚀 Starting Advanced Workflows Test (Dynamic Child Generation + 5s Delay)...');

  // 1. Attach Observability (starts Dashboard API on port 4000)
  await attachObservability({
    Queue,
    Worker,
    Scheduler,
    queues: ['complex-queue'],
    port: 4000,
  });

  // 2. Initialize Queue
  const queue = new Queue('complex-queue');

  // 3. Initialize Worker & Scheduler
  const worker = new Worker('complex-queue', async (job) => {
    console.log(`[Worker] Processing Job ID: ${job.id} | Name: "${job.name}"`);
    
    // Simulate some processing delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    const iteration = job.data?.iteration || 1;

    // Dynamic Child Creation Scenario:
    // When the root task completes, it dynamically adds 2 child jobs scheduled with a 5-second delay
    if (job.name === 'root-task') {
      console.log(`[Worker] root-task (Iteration ${iteration}) completed. Dynamically scheduling 2 child jobs with a 5-second delay...`);
      
      const child1Id = await queue.add('child-task-1', { parentJobId: job.id, iteration }, { delay: 5000 });
      const child2Id = await queue.add('child-task-2', { parentJobId: job.id, iteration }, { delay: 5000 });
      
      console.log(`[Worker] Enqueued child-task-1 (ID: ${child1Id}) with 5s delay`);
      console.log(`[Worker] Enqueued child-task-2 (ID: ${child2Id}) with 5s delay`);
    } else if (job.name === 'child-task-1' || job.name === 'child-task-2') {
      const redis = require('./src/utils/redis');
      const count = await redis.incr(`complex-test:finished:${iteration}`);
      
      console.log(`[Worker] Child task completed. Iteration ${iteration} progress: ${count}/2`);
      
      if (count === 2) {
        console.log(`[Worker] Both children for iteration ${iteration} completed! Triggering next loop...`);
        await redis.del(`complex-test:finished:${iteration}`);
        
        // Add root-task for the next iteration (never-ending loop)
        const nextRootId = await queue.add('root-task', { iteration: iteration + 1 });
        console.log(`[Worker] Triggered root-task for Iteration ${iteration + 1} (ID: ${nextRootId})`);
      }
    }

    console.log(`[Worker] Completed Job ID: ${job.id} | Name: "${job.name}"`);
  });

  const scheduler = new Scheduler('complex-queue');

  worker.start();
  scheduler.start();
  scheduler.delayedjobs();

  // Helper to seed jobs
  async function seedJobs() {
    console.log('\n📥 Seeding parent root-task...');
    const rootJobId = await queue.add('root-task', { iteration: 1, info: 'I will generate 2 delayed children' });
    console.log(`Added root job: ${rootJobId}`);

    // Let's also keep a Cron Job to show regular background scheduling
    const cronJobId = await queue.add('cron-task', { type: 'cron' }, { repeat: '*/10 * * * * *' });
    console.log(`Added cron job: ${cronJobId} (runs every 10s)`);

    console.log('✅ Seeding complete. Open your dashboard at http://localhost:3000 to view the workflows in real-time!\n');
  }

  await seedJobs();

  // Keep process alive
  const interval = setInterval(() => {}, 10000);

  // Clean exit handling
  const cleanup = async () => {
    clearInterval(interval);
    console.log('\n🧹 Cleaning up test data and freeing Redis memory...');
    try {
      const redis = require('./src/utils/redis');
      await redis.flushdb();
      console.log('✅ Redis memory cleared successfully.');

      await scheduler.stop();
      await queue.client.quit();
      await worker.client.quit();
      await redis.quit();
      console.log('🔌 Redis connections closed.');
    } catch (err) {
      console.error('⚠️ Error during cleanup:', err.message);
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(err => {
  console.error('❌ Failed to run test script:', err);
  process.exit(1);
});
