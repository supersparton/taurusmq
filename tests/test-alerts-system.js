// tests/test-alerts-system.js
//
// Real-data test script for TaurusMQ Redesigned Alerting & Incident Center.
// This script will:
//   1. Attach the live observability stack.
//   2. Configure a dynamic alert rule in Redis: Trigger when 'waiting' > 2 jobs.
//   3. Enqueue 4 jobs to trigger the alert.
//   4. Wait for the MetricsAggregator tick (10 seconds) and verify the alert fires.
//   5. Spin up a worker to process the jobs, bringing waiting count to 0.
//   6. Wait for the next aggregator tick and verify the alert resolves.
//   7. Perform assertions and print results.
//

'use strict';

const { Queue, Worker, Scheduler } = require('../src/index');
const { attachObservability } = require('../packages/observability');
const redis = require('../src/utils/redis');

// Disable authentication verification for easy testing
process.env.TAURUSMQ_AUTH_DISABLED = 'true';

async function main() {
  console.log('🚀 Starting Redesigned Alerting System Integration Test...');

  const queueName = 'alert-test-queue';

  // 1. Attach Observability (starts Dashboard API on port 4000)
  const { aggregator } = await attachObservability({
    Queue,
    Worker,
    Scheduler,
    queues: [queueName],
    port: 4000,
  });

  // 2. Configure the alert rule directly in Redis
  console.log('\n📝 Configuring alert rule: waiting > 2 jobs on queue:', queueName);
  const ruleId = 'rule_test_waiting_depth';
  const rule = {
    id: ruleId,
    name: 'Test Waiting Backlog Alert',
    queue: queueName,
    metric: 'waiting',
    threshold: 2,
    severity: 'critical',
    webhook: '', // No webhook for manual test
  };
  await redis.hset('taurusmq:obs:alert_rules', ruleId, JSON.stringify(rule));

  // 3. Initialize Queue
  const q = new Queue(queueName);

  // Seed 4 jobs (to trigger the threshold > 2)
  console.log('📥 Enqueuing 4 jobs...');
  await q.add('job-1', { data: 'ok' });
  await q.add('job-2', { data: 'ok' });
  await q.add('job-3', { data: 'ok' });
  await q.add('job-4', { data: 'ok' });

  console.log('⌛ Waiting 11 seconds for MetricsAggregator aggregation tick...');
  await new Promise(resolve => setTimeout(resolve, 11000));

  // 4. Verify the alert is firing
  console.log('🔍 Checking if alert is firing in Redis...');
  const firing = await redis.hgetall('tmq:obs:alerts') ?? {};
  if (firing[ruleId]) {
    const alert = JSON.parse(firing[ruleId]);
    console.log(`✅ SUCCESS: Alert "${alert.ruleName}" is FIRING!`);
    console.log(`   Evidence: ${alert.evidence[0]}`);
  } else {
    console.error('❌ FAILURE: Alert did not fire.');
    process.exit(1);
  }

  // 5. Spin up a worker to drain the queue (bring waiting count to 0)
  console.log('\n⚙️ Starting worker to process jobs and resolve alert...');
  const worker = new Worker(queueName, async (job) => {
    console.log(`   [Worker] Processing job ${job.id}`);
  });
  const scheduler = new Scheduler(queueName);
  worker.start();
  scheduler.start();

  console.log('⌛ Waiting 4 seconds for worker to process all jobs...');
  await new Promise(resolve => setTimeout(resolve, 4000));

  console.log('⌛ Waiting 15 seconds for next MetricsAggregator aggregation tick...');
  await new Promise(resolve => setTimeout(resolve, 15000));

  // 6. Verify the alert is resolved
  console.log('🔍 Checking if alert is resolved in Redis...');
  const activeAlerts = await redis.hgetall('tmq:obs:alerts') ?? {};
  const allIncidents = await redis.hgetall('tmq:obs:incidents') ?? {};

  if (!activeAlerts[ruleId] && allIncidents[ruleId]) {
    const alert = JSON.parse(allIncidents[ruleId]);
    if (alert.state === 'resolved') {
      console.log(`✅ SUCCESS: Alert "${alert.ruleName}" was RESOLVED successfully!`);
      console.log(`   Resolved At: ${new Date(alert.resolvedAt).toISOString()}`);
    } else {
      console.error('❌ FAILURE: Alert in incidents list is not resolved. State:', alert.state);
      process.exit(1);
    }
  } else {
    console.error('❌ FAILURE: Alert is still active or missing from history.');
    console.log('Active Alerts in Redis:', activeAlerts);
    console.log('All Incidents in Redis:', allIncidents);
    process.exit(1);
  }

  // 7. Cleanup
  console.log('\n🧹 Cleaning up test data...');
  try {
    await redis.flushdb();
    await worker.stop();
    await scheduler.stop();
  } catch (_) {}

  console.log('🎉 Integration test passed successfully!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
