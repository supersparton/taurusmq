// test-phase1.js
//
// Real-data test script for TaurusMQ Phase 1 Dashboard Integration.
// This script will:
//   1. Attach the live observability stack.
//   2. Set up two queues: 'notifications' and 'image-resizer'.
//   3. Spin up workers that process some tasks successfully and fail others on purpose (to test DLQ/Retry).
//   4. Periodically queue new jobs to keep the dynamic dashboard feed moving.
//

'use strict';

const { Queue, Worker, Scheduler } = require('../src/index');
const { attachObservability } = require('../packages/observability');


const authDisabled = process.env.TAURUSMQ_AUTH_DISABLED === 'true';
if (!authDisabled) {
  if (!process.env.TAURUSMQ_USERNAME) process.env.TAURUSMQ_USERNAME = 'admin';
  if (!process.env.TAURUSMQ_PASSWORD) process.env.TAURUSMQ_PASSWORD = 'password';
}

async function main() {
  console.log('🚀 Starting Phase 1 Real Data Observability Test...');

  // 1. Attach Observability (starts Dashboard API on port 4000)
  await attachObservability({
    Queue,
    Worker,
    Scheduler,
    queues: ['notifications', 'image-resizer'],
    port: 4000,
  });

  // 2. Initialize Queues
  const notificationQueue = new Queue('notifications');
  const imageQueue        = new Queue('image-resizer');

  // 3. Initialize Workers
  // Worker for 'notifications'
  const notificationWorker = new Worker('notifications', async (job) => {
    console.log(`[Worker] Processing notification job ${job.id} (${job.name})`);
    
    // Simulate latency
    await new Promise(resolve => setTimeout(resolve, 300));

    // Force failure for specific jobs to populate DLQ
    if (job.name === 'send-alert-sms') {
      throw new Error('Twilio API Credentials Invalid — Authorization failed');
    }
    if (job.name === 'send-marketing-email') {
      throw new Error('SMTP Server connection timed out after 5000ms');
    }

    console.log(`[Worker] Completed notification job ${job.id}`);
  });

  // Worker for 'image-resizer'
  const imageWorker = new Worker('image-resizer', async (job) => {
    console.log(`[Worker] Processing image resize ${job.id} (${job.name})`);
    await new Promise(resolve => setTimeout(resolve, 800)); // longer task
    console.log(`[Worker] Completed image resize ${job.id}`);
  });

  // Start the workers & schedulers
  const notificationScheduler = new Scheduler('notifications');
  const imageScheduler        = new Scheduler('image-resizer');

  notificationWorker.start();
  imageWorker.start();

  notificationScheduler.start();
  notificationScheduler.delayedjobs();
  imageScheduler.start();
  imageScheduler.delayedjobs();

  // Helper to add initial jobs
  async function seedJobs() {
    console.log('\n📥 Seeding initial jobs...');

    // Successful notification tasks
    await notificationQueue.add('send-welcome-email', { userId: 101, email: 'john@example.com' });
    await notificationQueue.add('send-password-reset', { userId: 102, email: 'jane@example.com' });

    // Failed tasks (will go to DLQ so you can test retries)
    await notificationQueue.add('send-alert-sms', { phone: '+1234567890', msg: 'System offline!' });
    await notificationQueue.add('send-marketing-email', { listId: 45, subject: 'Weekly Deals' });

    // Image resizer tasks
    await imageQueue.add('resize-avatar', { path: '/uploads/avatar_12.png', width: 120, height: 120 });
    await imageQueue.add('resize-hero', { path: '/uploads/banner_99.png', width: 1920, height: 1080 });

    console.log('✅ Seeding complete. Open your dashboard to view real data!\n');
  }

  await seedJobs();

  // 4. Periodically add jobs to keep metrics/throughput active
  let counter = 1;
  const interval = setInterval(async () => {
    try {
      counter++;
      // Every 12 seconds, enqueue new jobs
      if (counter % 2 === 0) {
        await notificationQueue.add('send-welcome-email', { userId: 100 + counter, email: `user${counter}@example.com` });
      } else {
        await imageQueue.add('resize-avatar', { path: `/uploads/avatar_${counter}.png`, width: 100, height: 100 });
      }
    } catch (err) {
      console.error('[Test Error] Failed to auto-enqueue job:', err.message);
    }
  }, 12000);

  // Clean exit handling
  const cleanup = async () => {
    clearInterval(interval);
    console.log('\n🧹 Cleaning up test data and freeing Redis memory...');
    try {
      const redis = require('../src/utils/redis');
      
      // Flush database keys to free all memory
      await redis.flushdb();
      console.log('✅ Redis memory cleared successfully.');

      // Gracefully close Redis connections
      await notificationScheduler.stop();
      await imageScheduler.stop();

      await notificationQueue.client.quit();
      await imageQueue.client.quit();
      await notificationWorker.client.quit();
      await imageWorker.client.quit();
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
  if (err.message && err.message.includes('[TaurusMQ Error]')) {
    console.error(`❌ Failed to run test script: ${err.message}`);
  } else {
    console.error('❌ Failed to run test script:', err);
  }
});
