// tests/benchmark.js
//
// TaurusMQ Automated Benchmarking & Validation Suite
// Performs:
//   1. Performance Testing (Throughput & Latency percentiles)
//   2. Stress Testing (Throughput & Latency vs Worker Concurrency)
//   3. Reliability & Failure Recovery (Chaos Testing: Worker crashes, zero job loss verification)
//   4. Resource Monitoring (CPU, RSS memory, Heap usage)
//
// Run with:
//   node tests/benchmark.js --jobs=10000 --concurrency=20
//

'use strict';

const { Queue, Worker, Scheduler, QueueEvents } = require('../src/index');
const redis = require('../src/utils/redis');

// Parse CLI Arguments
const args = {};
process.argv.slice(2).forEach(arg => {
  const [key, val] = arg.replace(/^--/, '').split('=');
  args[key] = val;
});

const NUM_JOBS = parseInt(args.jobs || process.env.BENCH_JOBS || '10000', 10);
const CONCURRENCY = parseInt(args.concurrency || process.env.BENCH_CONCURRENCY || '20', 10);
const PAYLOAD_SIZE = parseInt(args.payload || process.env.BENCH_PAYLOAD || '100', 10); // in bytes
const TEST_TYPE = args.type || 'all'; // all, perf, stress, reliability
const connectionOpts = 'redis://127.0.0.1:6379';

// Create dummy payload of specific size
const dummyPayload = {
  data: 'x'.repeat(PAYLOAD_SIZE),
};

// Percentile helper
function getPercentile(sortedList, p) {
  if (sortedList.length === 0) return 0;
  const index = Math.ceil(p * sortedList.length) - 1;
  return sortedList[Math.max(0, Math.min(index, sortedList.length - 1))];
}

// Memory tracking helper
function getMemoryUsageMB() {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
  };
}

// Format numbers
function formatNum(num) {
  return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1: Performance Benchmark
// ─────────────────────────────────────────────────────────────────────────────
async function runPerformanceTest(queueName, numJobs, concurrency, useAddBulk = true) {
  console.log(`\n--- 🚀 Running Performance Benchmark: Queue="${queueName}", Jobs=${numJobs}, Concurrency=${concurrency}, Method=${useAddBulk ? 'addBulk' : 'add'} ---`);

  const queue = new Queue(queueName, { connection: connectionOpts });
  await queue.obliterate(); // Clean slate

  const startMem = getMemoryUsageMB();
  const startTime = Date.now();

  // 1. Producer Phase: Enqueueing
  console.log(`📥 Enqueueing ${numJobs} jobs...`);
  const enqueueStart = Date.now();

  if (useAddBulk) {
    // Enqueue in batches of 1000 to maximize performance
    const batchSize = 1000;
    for (let i = 0; i < numJobs; i += batchSize) {
      const batchJobs = [];
      const currentBatchSize = Math.min(batchSize, numJobs - i);
      for (let j = 0; j < currentBatchSize; j++) {
        batchJobs.push({ name: 'benchmark-task', data: dummyPayload });
      }
      await queue.addBulk(batchJobs);
    }
  } else {
    // Sequential enqueue
    for (let i = 0; i < numJobs; i++) {
      await queue.add('benchmark-task', dummyPayload);
    }
  }

  const enqueueEnd = Date.now();
  const enqueueDurationSec = (enqueueEnd - enqueueStart) / 1000;
  const enqueueThroughput = numJobs / enqueueDurationSec;

  console.log(`✅ Enqueued ${numJobs} jobs in ${formatNum(enqueueDurationSec)}s (${formatNum(enqueueThroughput)} jobs/sec).`);

  // 2. Consumer Phase: Processing
  const latencies = [];
  let processedCount = 0;
  let processingResolve;
  const processingPromise = new Promise(resolve => { processingResolve = resolve; });

  const startCpu = process.cpuUsage();
  const consumerStart = Date.now();

  const worker = new Worker(queueName, async (job) => {
    const now = Date.now();
    // Latency = time from job creation (job.timestamp) to execution start
    const latency = now - job.timestamp;
    latencies.push(latency);

    // Simulate light CPU processing
    let sum = 0;
    for (let k = 0; k < 100; k++) sum += Math.sin(k);
  }, { concurrency, removeOnComplete: 99999, connection: connectionOpts });

  const onJobProcessed = () => {
    processedCount++;
    if (processedCount >= numJobs) {
      processingResolve();
    }
  };

  worker.on('completed', onJobProcessed);
  worker.on('failed', onJobProcessed);

  await worker.start();

  // Wait for all jobs to complete
  await processingPromise;

  const consumerEnd = Date.now();
  const consumerDurationSec = (consumerEnd - consumerStart) / 1000;
  const consumerThroughput = numJobs / consumerDurationSec;

  const endCpu = process.cpuUsage(startCpu);
  const totalCpuTime = (endCpu.user + endCpu.system) / 1000; // total CPU ms

  // Stop worker and cleanup
  await worker.stop();
  await queue.close();

  // Sort latencies for percentiles
  latencies.sort((a, b) => a - b);
  const avgLatency = latencies.reduce((sum, val) => sum + val, 0) / latencies.length;
  const p50 = getPercentile(latencies, 0.50);
  const p95 = getPercentile(latencies, 0.95);
  const p99 = getPercentile(latencies, 0.99);

  const endMem = getMemoryUsageMB();

  const result = {
    jobs: numJobs,
    concurrency,
    enqueueTimeSec: enqueueDurationSec,
    enqueueThroughput,
    consumerTimeSec: consumerDurationSec,
    consumerThroughput,
    avgLatencyMs: avgLatency,
    p50Ms: p50,
    p95Ms: p95,
    p99Ms: p99,
    cpuMs: totalCpuTime,
    ramDeltaRss: endMem.rss - startMem.rss,
    peakRssMB: endMem.rss
  };

  console.log(`✅ Processed ${numJobs} jobs in ${formatNum(consumerDurationSec)}s (${formatNum(consumerThroughput)} jobs/sec).`);
  console.log(`📊 Latencies: Avg = ${formatNum(avgLatency)} ms, P50 = ${p50} ms, P95 = ${p95} ms, P99 = ${p99} ms`);
  console.log(`💻 Resource: RAM delta = ${result.ramDeltaRss} MB (Peak RSS = ${result.peakRssMB} MB), CPU execution time = ${formatNum(totalCpuTime)} ms`);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2: Stress Test
// ─────────────────────────────────────────────────────────────────────────────
async function runStressTest(queueName) {
  console.log('\n====================================================');
  console.log('🔥 STARTING PHASE 2: STRESS TEST (CONCURRENCY SCALING)');
  console.log('====================================================');

  const concurrencyLevels = [5, 10, 20, 50, 100];
  const results = [];

  // Run a smaller set of jobs per test to complete in reasonable time
  const testJobs = Math.min(5000, NUM_JOBS);

  for (const level of concurrencyLevels) {
    try {
      const res = await runPerformanceTest(`${queueName}-stress-${level}`, testJobs, level, true);
      results.push({ concurrency: level, ...res });
      await sleep(1000);
    } catch (err) {
      console.error(`❌ Stress test failed at concurrency=${level}:`, err);
    }
  }

  console.log('\n📊 STRESS TEST RESULTS COMPARISON TABLE:');
  console.log('| Concurrency | Throughput (jobs/sec) | Avg Latency | P95 Latency | Peak RAM (MB) |');
  console.log('| ----------- | --------------------: | ----------: | ----------: | ------------: |');
  results.forEach(r => {
    console.log(`| ${r.concurrency} | ${formatNum(r.consumerThroughput)} | ${formatNum(r.avgLatencyMs)} ms | ${r.p95Ms} ms | ${r.peakRssMB} MB |`);
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 & 4: Reliability and Failure Recovery (Chaos Testing)
// ─────────────────────────────────────────────────────────────────────────────
async function runReliabilityTest(queueName) {
  console.log('\n====================================================');
  console.log('🛡️ STARTING PHASE 3 & 4: RELIABILITY & FAILURE RECOVERY');
  console.log('====================================================');

  const numJobs = Math.min(5000, NUM_JOBS);
  const queue = new Queue(queueName, { connection: connectionOpts });
  await queue.obliterate(); // Clean slate

  // 1. Seed jobs with predictable unique IDs
  console.log(`📥 Enqueueing ${numJobs} jobs for reliability run...`);
  const batchJobs = [];
  for (let i = 0; i < numJobs; i++) {
    // Generate a predictable jobId to track uniqueness
    batchJobs.push({ 
      name: 'chaos-task', 
      data: { idx: i }, 
      options: { jobId: `chaos-${queueName}-${i}`, maxretries: 3 } 
    });
  }
  
  // Add in chunks of 1000 to prevent pipeline overflows
  const chunkSize = 1000;
  for (let i = 0; i < batchJobs.length; i += chunkSize) {
    const chunk = batchJobs.slice(i, i + chunkSize);
    await queue.addBulk(chunk);
  }

  // 2. Initialize Scheduler (configured with aggressive 2s lock timeout)
  // This allows us to recover crashed jobs quickly.
  const scheduler = new Scheduler(queueName, 2000, { connection: connectionOpts });
  scheduler.start();
  scheduler.delayedjobs();

  const completedSet = new Set();
  const permanentlyFailedSet = new Set();
  let runningWorkers = [];

  let resolveReliability;
  const reliabilityPromise = new Promise(resolve => { resolveReliability = resolve; });

  const handler = async (job) => {
    // Random failures (e.g. 5% chance) to trigger retry code path
    if (Math.random() < 0.05) {
      throw new Error('Simulated transient processing error');
    }

    // Heavy CPU simulation
    await sleep(20);
  };

  // Start 3 workers with a high completed-job retention limit to prevent Redis from trimming them
  const worker1 = new Worker(queueName, handler, { concurrency: 10, lockDuration: 2000, removeOnComplete: 99999, connection: connectionOpts });
  const worker2 = new Worker(queueName, handler, { concurrency: 10, lockDuration: 2000, removeOnComplete: 99999, connection: connectionOpts });
  const worker3 = new Worker(queueName, handler, { concurrency: 10, lockDuration: 2000, removeOnComplete: 99999, connection: connectionOpts });

  // Use QueueEvents for centralized event monitoring (robust against worker termination)
  const queueEvents = new QueueEvents(queueName, { connection: connectionOpts });
  await sleep(200); // Allow QueueEvents subscription to establish in Redis

  const monitorProgress = () => {
    const totalProcessed = completedSet.size + permanentlyFailedSet.size;
    if (totalProcessed >= numJobs) {
      resolveReliability();
    }
  };

  queueEvents.on('completed', ({ jobId }) => {
    completedSet.add(jobId);
    monitorProgress();
  });

  queueEvents.on('failed', async ({ jobId }) => {
    try {
      const jobJson = await queue.client.hget(`${queue.prefix}:jobs:${queueName}`, jobId);
      if (jobJson) {
        const job = JSON.parse(jobJson);
        if (job.status === 'dead') {
          permanentlyFailedSet.add(jobId);
        }
      }
    } catch (_) {}
    monitorProgress();
  });

  console.log('🟢 Booting up 3 workers (total concurrency = 30)...');
  await Promise.all([worker1.start(), worker2.start(), worker3.start()]);
  runningWorkers.push(worker1, worker2, worker3);

  // Fallback polling to guarantee test completion even if pub/sub events are missed
  const pollInterval = setInterval(async () => {
    try {
      const completedCount = await queue.client.zcard(`${queue.prefix}:completed:${queueName}`);
      const dlqCount = await queue.client.hlen(queue.rediskeydlq);
      const totalProcessed = completedCount + dlqCount;
      if (totalProcessed >= numJobs) {
        resolveReliability();
      }
    } catch (_) {}
  }, 1000);

  // 3. Chaos injection: Kill Worker-2 programmatically halfway through
  const halfProcessed = Math.floor(numJobs / 2);
  console.log(`⏱️ Waiting until ${halfProcessed} jobs are completed to inject chaos...`);

  const chaosTimer = setInterval(async () => {
    const totalProcessed = completedSet.size + permanentlyFailedSet.size;
    if (totalProcessed >= halfProcessed && runningWorkers.includes(worker2)) {
      clearInterval(chaosTimer);
      console.log('\n💥 [CHAOS INJECTED] Hard-killing Worker-2 during active processing!');
      
      // Stop the worker immediately without running the graceful cleanup.
      // In a real environment, this is equivalent to process.exit() or container termination.
      // We clear its active lock renewal timers and close the connections.
      for (const [jobId, timer] of worker2.activeLockTimers.entries()) {
        clearInterval(timer);
      }
      worker2.active = false;
      worker2._slotClients.forEach(c => {
        try { c.disconnect(false); } catch (_) {}
      });
      try { worker2.redisClient.disconnect(); } catch (_) {}
      
      runningWorkers = runningWorkers.filter(w => w !== worker2);
      console.log('⚡ Worker-2 connections aborted. Stalled active locks will now be orphaned.');

      // Periodically trigger the Scheduler's recovery script manually to speed up the test
      const recoveryTrigger = setInterval(async () => {
        if (completedSet.size + permanentlyFailedSet.size >= numJobs) {
          clearInterval(recoveryTrigger);
          return;
        }
        try {
          const now = Date.now();
          await scheduler.redisClient.recoverStalled(
            scheduler.rediskeyactive,
            scheduler.rediskeywaiting,
            scheduler.rediskeysignal,
            scheduler.rediskeyprioritized,
            `${scheduler.prefix}:jobs:${scheduler.queuename}`,
            `${scheduler.prefix}:dlq:${scheduler.queuename}`,
            now,
            scheduler.timeout
          );
        } catch (_) {}
      }, 500);
    }
  }, 100);

  // Wait for completion
  await reliabilityPromise;
  clearInterval(chaosTimer);
  clearInterval(pollInterval);

  // 4. Shutdown remaining workers, queue events, and scheduler
  console.log('🧹 Cleaning up workers and scheduler...');
  await Promise.all(runningWorkers.map(w => w.stop()));
  await queueEvents.close();
  await scheduler.stop();

  // Read final state from Redis
  const counts = await queue.getJobCounts();
  const dlqCount = await queue.client.hlen(queue.rediskeydlq);

  const completedCount = await queue.client.zcard(`${queue.prefix}:completed:${queueName}`);
  const failedCount = parseInt(dlqCount, 10);

  console.log('\n📊 CHAOS TEST METRICS:');
  console.log(`- Target Job Count      : ${numJobs}`);
  console.log(`- Completed Successfully: ${completedCount}`);
  console.log(`- Permanently Failed    : ${failedCount}`);
  console.log(`- Waiting Queue Depth   : ${counts.waiting}`);
  console.log(`- Active Queue Depth    : ${counts.active}`);
  console.log(`- Jobs in DLQ           : ${dlqCount}`);
  console.log(`- Recovery Rate         : ${formatNum(((completedCount + failedCount) / numJobs) * 100)}%`);

  const jobLoss = numJobs - (completedCount + failedCount);
  if (jobLoss === 0) {
    console.log('✅ SUCCESS: 100% data integrity verified. Zero jobs were lost or dropped during worker crash!');
  } else {
    console.log(`❌ FAILURE: Lost ${jobLoss} jobs during execution.`);
  }

  await queue.close();

  return {
    targetJobs: numJobs,
    completed: completedCount,
    failed: failedCount,
    dlq: parseInt(dlqCount, 10),
    jobLoss,
    recoveryRate: ((completedCount + failedCount) / numJobs) * 100
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Master Runner
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('====================================================');
  console.log('🐃 TAURUSMQ BENCHMARK & SYSTEM VALIDATION SUITE');
  console.log('====================================================');
  console.log(`Environment Configuration:`);
  console.log(`- Target Jobs         : ${NUM_JOBS}`);
  console.log(`- Default Concurrency: ${CONCURRENCY}`);
  console.log(`- Payload Size        : ${PAYLOAD_SIZE} bytes`);
  console.log(`- Redis URL           : ${'redis://127.0.0.1:6379'}`);
  console.log('====================================================');

  const baseQueueName = `benchmark-queue-${Date.now()}`;
  const finalReport = {
    timestamp: new Date().toISOString(),
    config: {
      targetJobs: NUM_JOBS,
      concurrency: CONCURRENCY,
      payloadSize: PAYLOAD_SIZE,
      redisUrl: 'redis://127.0.0.1:6379'
    },
    results: {}
  };

  try {
    if (TEST_TYPE === 'perf' || TEST_TYPE === 'all') {
      finalReport.results.performance = await runPerformanceTest(baseQueueName, NUM_JOBS, CONCURRENCY, true);
    }

    if (TEST_TYPE === 'stress' || TEST_TYPE === 'all') {
      finalReport.results.stress = await runStressTest(baseQueueName);
    }

    if (TEST_TYPE === 'reliability' || TEST_TYPE === 'all') {
      finalReport.results.reliability = await runReliabilityTest(baseQueueName);
    }

    // Print a complete final summary of all test phases
    console.log('\n====================================================');
    console.log('🏆 FINAL BENCHMARK SUMMARY REPORT');
    console.log('====================================================');

    if (finalReport.results.performance) {
      const p = finalReport.results.performance;
      console.log('\n🚀 PHASE 1: PERFORMANCE');
      console.log(`  - Total Jobs           : ${p.jobs}`);
      console.log(`  - Concurrency          : ${p.concurrency}`);
      console.log(`  - Enqueue Throughput   : ${formatNum(p.enqueueThroughput)} jobs/sec`);
      console.log(`  - Consumer Throughput  : ${formatNum(p.consumerThroughput)} jobs/sec`);
      console.log(`  - Avg Latency          : ${formatNum(p.avgLatencyMs)} ms`);
      console.log(`  - Latency (P50/P95/P99): ${p.p50Ms}ms / ${p.p95Ms}ms / ${p.p99Ms}ms`);
      console.log(`  - CPU Processing Time  : ${p.cpuMs} ms`);
      console.log(`  - Peak RSS Memory      : ${p.peakRssMB} MB`);
    }

    if (finalReport.results.stress) {
      console.log('\n📈 PHASE 2: STRESS TEST COMPARISON');
      console.log('  Concurrency | Enqueue throughput | Consumer throughput | Avg Latency | Peak RAM');
      console.log('  ------------|--------------------|---------------------|-------------|---------');
      finalReport.results.stress.forEach(s => {
        console.log(`  ${s.concurrency.toString().padEnd(11)} | ${formatNum(s.enqueueThroughput).padEnd(18)} | ${formatNum(s.consumerThroughput).padEnd(19)} | ${formatNum(s.avgLatencyMs).padEnd(11)}ms | ${s.peakRssMB} MB`);
      });
    }

    if (finalReport.results.reliability) {
      const r = finalReport.results.reliability;
      console.log('\n🛡️ PHASE 3 & 4: RELIABILITY & CHAOS RECOVERY');
      console.log(`  - Target Job Count     : ${r.targetJobs}`);
      console.log(`  - Completed Jobs       : ${r.completed}`);
      console.log(`  - Permanently Failed   : ${r.failed}`);
      console.log(`  - DLQ Count            : ${r.dlq}`);
      console.log(`  - Recovery Rate        : ${formatNum(r.recoveryRate)}%`);
      console.log(`  - Status               : ${r.jobLoss === 0 ? '✅ SUCCESS (0 jobs lost)' : `❌ FAILURE (${r.jobLoss} jobs lost)`}`);
    }
    console.log('\n====================================================');

    const fs = require('fs');
    const path = require('path');
    const reportPath = path.join(__dirname, '../benchmark-results.json');
    fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));

    console.log(`\n💾 Detailed JSON report written to: ${reportPath}`);
    console.log('\n🎉 Benchmarking suite run completed successfully!');
  } catch (err) {
    console.error('❌ Fatal error in benchmark suite:', err);
  } finally {
    // Force exit to ensure no dangling Redis sockets block terminal
    process.exit(0);
  }
}

main();
