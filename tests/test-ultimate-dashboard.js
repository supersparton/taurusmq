// tests/test-ultimate-dashboard.js
//
// Ultimate infinite dashboard load generator for TaurusMQ.
// Generates:
//   - Multiple queues: orders-queue, payment-queue, inventory-queue, notification-queue, report-queue, analytics-queue
//   - Workers processing concurrently with realistic execution delays (100ms - 1500ms)
//   - Randomly triggered worker exceptions (5% to 15%) to fire alerts & populate Incident Center
//   - Pre-configured dynamic Alert Rules directly in Redis
//   - All job configurations: normal, priority, delayed, cron (repeatable)
//   - Complex DAG Flows:
//       - Fan-Out: parent -> multiple children
//       - Fan-In: multiple children -> parent (consolidator)
//       - Multi-Level Tree: parent -> middle nodes -> leaf nodes
//

'use strict';

require('dotenv').config();
const { Queue, Worker, Scheduler, FlowProducer } = require('../src/index');
const { attachObservability } = require('../packages/observability');
const redis = require('../src/utils/redis');
const { v4: uuidv4 } = require('uuid');

// Disable authentication verification for easy testing
process.env.TAURUSMQ_AUTH_DISABLED = 'true';

const QUEUES = [
  'orders-queue',
  'payment-queue',
  'inventory-queue',
  'notification-queue',
  'report-queue',
  'analytics-queue'
];

async function main() {
  console.log('================================================================');
  console.log('🚀 TAURUSMQ ULTIMATE DASHBOARD LOAD GENERATOR & SIMULATOR');
  console.log('================================================================');

  // 1. Clean previous state
  console.log('🧹 Clearing Redis database...');
  await redis.flushdb();
  console.log('✅ Redis cleaned.');

  // 2. Configure Dynamic Alert Rules in Redis
  console.log('📝 Seeding alert rule configurations...');
  const alertRules = [
    {
      id: 'rule_payment_failures',
      name: 'Payment Failures Spike',
      queue: 'payment-queue',
      metric: 'failed',
      threshold: 3,
      severity: 'critical',
      webhook: ''
    },
    {
      id: 'rule_orders_backlog',
      name: 'Orders Backlog Warning',
      queue: 'orders-queue',
      metric: 'waiting',
      threshold: 8,
      severity: 'warning',
      webhook: ''
    }
  ];

  for (const rule of alertRules) {
    await redis.hset('taurusmq:obs:alert_rules', rule.id, JSON.stringify(rule));
  }
  console.log('✅ Seeding complete.');

  // 3. Attach Observability Stack
  console.log('📡 Launching dashboard API on port 4000...');
  await attachObservability({
    Queue,
    Worker,
    Scheduler,
    queues: QUEUES,
    port: 4000,
  });

  // 4. Initialize FlowProducer & Queues
  const flowProducer = new FlowProducer();
  const queueInstances = {};
  QUEUES.forEach(qName => {
    queueInstances[qName] = new Queue(qName);
  });

  // 5. Initialize Schedulers (for delayed & repeatable jobs)
  console.log('⏰ Starting Schedulers for promotion & stall watchdogs...');
  const schedulers = QUEUES.map(qName => {
    const sched = new Scheduler(qName);
    sched.delayedjobs(); // Promote delayed jobs automatically
    sched.start();       // Watchdog stall tracking loop
    return sched;
  });

  // 6. Setup Repeatable Cron Jobs
  console.log('📅 Registering cron tasks...');
  // Every minute report
  await queueInstances['report-queue'].add('hourly-financial-audit', { scope: 'global' }, { repeat: '*/1 * * * *' });
  // Every 2 minutes report
  await queueInstances['report-queue'].add('inventory-reconciliation', { target: 'warehouse-1' }, { repeat: '*/2 * * * *' });

  // 7. Setup Background Workers
  console.log('⚙️ Starting workers to process tasks concurrently...');
  const workers = [];

  const setupWorker = (queueName, delayRange, failureRate) => {
    const w = new Worker(queueName, async (job) => {
      // Simulate real-world execution delay
      const [minDelay, maxDelay] = delayRange;
      const delay = Math.floor(Math.random() * (maxDelay - minDelay)) + minDelay;
      await new Promise(resolve => setTimeout(resolve, delay));

      // Simulate random job failure
      if (Math.random() < failureRate) {
        throw new Error(`SimulationError: Resource connection timed out during execution [jobId=${job.id}]`);
      }

      // Return telemetry details
      return {
        processedBy: `Worker-${process.pid}`,
        executionTimeMs: delay,
        result: 'success',
        timestamp: Date.now()
      };
    }, { concurrency: 2 });

    w.start();
    workers.push(w);
  };

  // Assign workers with specific performance/failure properties
  setupWorker('orders-queue', [100, 300], 0.04);       // fast, 4% fail rate
  setupWorker('payment-queue', [300, 900], 0.15);      // slow, 15% fail rate (will trigger Alert rules)
  setupWorker('inventory-queue', [50, 200], 0.01);      // very fast, 1% fail rate
  setupWorker('notification-queue', [100, 400], 0.0);   // stable, 0% fail rate
  setupWorker('report-queue', [500, 1500], 0.0);       // heavy, 0% fail rate
  setupWorker('analytics-queue', [200, 600], 0.05);     // medium, 5% fail rate

  console.log('✅ Workers attached and listening.');

  // 8. Infinite Load Loop
  console.log('\n🌟 Start enqueuing continuous operations...');
  console.log('────────────────────────────────────────────────────────────────');
  console.log('👉 Dashboard URL: http://localhost:4000');
  console.log('👉 Flow URL:      http://localhost:4000/flow');
  console.log('👉 Press Ctrl+C to terminate the simulator');
  console.log('────────────────────────────────────────────────────────────────\n');

  let batchCount = 0;

  const enqueueBatch = async () => {
    batchCount++;
    try {
      // A. Normal Job (Random Priority & Name)
      const isPriority = Math.random() > 0.5;
      const orderId = `order_${uuidv4().slice(0, 8)}`;
      await queueInstances['orders-queue'].add(
        'create-order',
        { orderId, items: ['item_a', 'item_b'], total: 99.99 },
        isPriority ? { priority: Math.floor(Math.random() * 10) + 1, jobId: orderId } : { jobId: orderId }
      );

      // B. Delayed Job (Runs in 10 seconds)
      const payId = `pay_deferred_${uuidv4().slice(0, 8)}`;
      await queueInstances['payment-queue'].add(
        'process-payment-deferred',
        { paymentId: payId, amount: 250.00 },
        { delay: 10000, jobId: payId }
      );

      // C. Complex DAG Flow 1: Fan-Out (Campaign Email Dispatcher)
      // Parent: campaign-dispatch
      // Children: send-email-user-1, send-email-user-2, send-email-user-3
      const campaignId = `campaign_flow_${uuidv4().slice(0, 8)}`;
      const fanOutFlow = {
        name: 'campaign-dispatch-parent',
        queueName: 'notification-queue',
        opts: { jobId: campaignId },
        data: { campaignName: 'Summer Sale 2026' },
        children: [
          { name: 'send-email-user-1', queueName: 'notification-queue', data: { email: 'user1@example.com' } },
          { name: 'send-email-user-2', queueName: 'notification-queue', data: { email: 'user2@example.com' } },
          { name: 'send-email-user-3', queueName: 'notification-queue', data: { email: 'user3@example.com' } }
        ]
      };
      await flowProducer.add(fanOutFlow);

      // D. Complex DAG Flow 2: Fan-In (Invoice Consolidation)
      // Parent: invoice-consolidator
      // Children: charge-item-1, charge-item-2, charge-item-3
      const invoiceId = `invoice_flow_${uuidv4().slice(0, 8)}`;
      const fanInFlow = {
        name: 'invoice-consolidator-parent',
        queueName: 'payment-queue',
        opts: { jobId: invoiceId },
        data: { client: 'Enterprise Corp' },
        children: [
          { name: 'charge-item-1', queueName: 'payment-queue', data: { sku: 'SKU-001', price: 1200 } },
          { name: 'charge-item-2', queueName: 'payment-queue', data: { sku: 'SKU-002', price: 800 } },
          { name: 'charge-item-3', queueName: 'payment-queue', data: { sku: 'SKU-003', price: 150 } }
        ]
      };
      await flowProducer.add(fanInFlow);

      // E. Complex DAG Flow 3: Multi-Level Tree (Analytics Pipeline)
      // Top Parent: aggregate-analytics
      // Middle nodes: process-region-east, process-region-west
      // Leaf nodes: fetch-east-data, fetch-west-data
      const analyticsId = `analytics_flow_${uuidv4().slice(0, 8)}`;
      const multiLevelFlow = {
        name: 'aggregate-analytics-parent',
        queueName: 'analytics-queue',
        opts: { jobId: analyticsId },
        data: { reportDate: '2026-07-09' },
        children: [
          {
            name: 'process-region-east-middle',
            queueName: 'analytics-queue',
            data: { region: 'East' },
            children: [
              { name: 'fetch-east-data-leaf', queueName: 'analytics-queue', data: { endpoint: 's3://east-bucket' } }
            ]
          },
          {
            name: 'process-region-west-middle',
            queueName: 'analytics-queue',
            data: { region: 'West' },
            children: [
              { name: 'fetch-west-data-leaf', queueName: 'analytics-queue', data: { endpoint: 's3://west-bucket' } }
            ]
          }
        ]
      };
      await flowProducer.add(multiLevelFlow);

      console.log(`[Batch #${batchCount}] Enqueued: 1 normal, 1 delayed, 1 Fan-Out flow, 1 Fan-In flow, 1 Multi-Level Flow.`);
    } catch (err) {
      console.error(`Error enqueuing load batch #${batchCount}:`, err.message);
    }
  };

  // Enqueue a batch immediately and then every 4 seconds
  await enqueueBatch();
  const timer = setInterval(enqueueBatch, 4000);

  // Graceful shutdown
  const cleanup = async () => {
    console.log('\n🛑 Stopping simulator...');
    clearInterval(timer);
    
    console.log('⚙️ Stopping workers...');
    await Promise.all(workers.map(w => w.stop()));

    console.log('⏰ Stopping schedulers...');
    await Promise.all(schedulers.map(s => s.stop()));

    console.log('🔌 Closing queue client connections...');
    await Promise.all(QUEUES.map(qName => queueInstances[qName].close()));

    console.log('👋 Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(err => {
  console.error('Fatal simulator error:', err);
  process.exit(1);
});
