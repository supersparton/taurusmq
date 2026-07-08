// tests/test-analytics-trends.js
//
// Real-data test script for TaurusMQ Redesigned Analytics & Performance Trends.
// This script will:
//   1. Attach the live observability stack.
//   2. Create a test queue and add some jobs.
//   3. Process 3 jobs successfully and fail 2 jobs using a worker.
//   4. Wait 1-2 seconds for internal events to process.
//   5. Query the GET /api/queues/:name/analytics API to verify data points.
//   6. Print results and exit successfully.
//

'use strict';

const { Queue, Worker, Scheduler } = require('../src/index');
const { attachObservability } = require('../packages/observability');
const redis = require('../src/utils/redis');
const http = require('http');

// Disable authentication verification for easy testing
process.env.TAURUSMQ_AUTH_DISABLED = 'true';

// Helper to make local HTTP requests
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('🚀 Starting Analytics & Performance Trends Integration Test...');

  const queueName = 'analytics-test-queue';

  // Clean old Redis stats for this queue
  const keys = await redis.keys(`taurusmq:obs:metrics:${queueName}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
    console.log(`🧹 Cleaned ${keys.length} existing analytics keys for ${queueName}`);
  }

  // 1. Attach Observability (starts Dashboard API on port 4000)
  await attachObservability({
    Queue,
    Worker,
    Scheduler,
    queues: [queueName],
    port: 4000,
  });

  // 2. Initialize Queue
  const q = new Queue(queueName);

  console.log('📥 Enqueuing 5 test jobs...');
  await q.add('job-1', { value: 10 });
  await q.add('job-2', { value: 20 });
  await q.add('job-3', { value: 30 });
  await q.add('job-4', { value: 40 });
  await q.add('job-5', { value: 50 });

  // 3. Process jobs with a worker
  console.log('👷 Starting worker to process jobs (3 success, 2 failed)...');
  let processedCount = 0;
  const worker = new Worker(queueName, async (job) => {
    processedCount++;
    console.log(`⏳ Processing job ${job.id} (val: ${job.data.value})`);
    
    // Simulate some delay/latency
    await new Promise(r => setTimeout(r, 100));

    if (processedCount > 3) {
      throw new Error('Simulated processing failure');
    }
    return { ok: true };
  });

  await worker.start();

  // Wait for all 5 jobs to be processed
  while (processedCount < 5) {
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('✅ Worker processed all 5 jobs.');
  await worker.stop();

  // Wait 1 second for the metrics to settle in the event handlers
  await new Promise(r => setTimeout(r, 1000));

  // 4. Query the analytics API endpoint
  console.log('\n📡 Querying API: GET http://localhost:4000/api/queues/analytics-test-queue/analytics');
  try {
    const analyticsPoints = await getJson(`http://localhost:4000/api/queues/${queueName}/analytics?range=24h`);
    console.log('📊 Analytics Response:');
    console.log(JSON.stringify(analyticsPoints, null, 2));

    // Find the current hour bucket
    const currentHourPoint = analyticsPoints.find(p => p.processed > 0 || p.failed > 0);

    if (currentHourPoint) {
      console.log('\n✨ Integration Test Assertions:');
      console.log(`- Processed Jobs Count: ${currentHourPoint.processed} (Expected: 3)`);
      console.log(`- Failed Jobs Count: ${currentHourPoint.failed} (Expected: 2)`);
      console.log(`- Average Latency: ${currentHourPoint.avgLatencyMs}ms (Expected: ~100ms)`);
      console.log(`- Average Wait Time: ${currentHourPoint.avgWaitMs}ms (Expected: >0ms)`);

      if (currentHourPoint.processed === 3 && currentHourPoint.failed === 2 && currentHourPoint.avgLatencyMs > 0) {
        console.log('\n🎉 SUCCESS: Analytics & Performance Trends feature works flawlessly!');
        process.exit(0);
      } else {
        console.error('\n❌ FAILURE: Metrics do not match expected outcomes.');
        process.exit(1);
      }
    } else {
      console.error('\n❌ FAILURE: No analytics data points recorded for the current hour.');
      process.exit(1);
    }
  } catch (err) {
    console.error('\n❌ Error fetching analytics:', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error running integration test:', err);
  process.exit(1);
});
