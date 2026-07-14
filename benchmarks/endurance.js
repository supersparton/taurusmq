// taurusmq/benchmarks/endurance.js
'use strict';

const { Queue, Worker, Scheduler } = require('../src/index');
const fs = require('fs');
const path = require('path');

// Parse CLI Arguments
const args = {};
process.argv.slice(2).forEach(arg => {
  const [key, val] = arg.replace(/^--/, '').split('=');
  args[key] = val;
});

// Supports:
// --jobs=500000        (Stop after processing X jobs)
// --duration=10800     (Stop enqueuing after X seconds, e.g., 10800s = 3 hours)
// --concurrency=50     (Worker concurrency)
const CONCURRENCY = parseInt(args.concurrency || '50', 10);
const DURATION_LIMIT = args.duration ? parseInt(args.duration, 10) : null;
const NUM_JOBS_LIMIT = DURATION_LIMIT ? null : parseInt(args.jobs || '500000', 10);

const RECORD_INTERVAL_MS = 30000; // Log stats every 30 seconds as requested
const queueName = 'endurance-queue';
const connectionOpts = 'redis://127.0.0.1:6379';

const BUFFER_TARGET = 30000; // Keep 30k jobs in queue buffer to feed workers
const BATCH_ENQUEUE_SIZE = 5000;

function getMemoryUsageMB() {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024)
  };
}

async function runEnduranceTest() {
  console.log('====================================================');
  console.log('⏳ TAURUSMQ ENDURANCE & HEALTH BENCHMARK');
  console.log('====================================================');
  if (DURATION_LIMIT) {
    console.log(`Config: Run Duration = ${DURATION_LIMIT}s (${(DURATION_LIMIT/3600).toFixed(1)} hours), Concurrency = ${CONCURRENCY}`);
  } else {
    console.log(`Config: Target Jobs = ${NUM_JOBS_LIMIT.toLocaleString()}, Concurrency = ${CONCURRENCY}`);
  }
  console.log(`Buffer Target: ${BUFFER_TARGET} jobs | Retention: removeOnComplete/Fail = 1000`);
  
  const queue = new Queue(queueName, { connection: connectionOpts });
  await queue.client.flushall(); // complete Redis wipe for clean telemetry
  await queue.obliterate(); // clean slate
  
  const scheduler = new Scheduler(queueName, { connection: connectionOpts, checkInterval: 1000 });
  scheduler.start();
  
  const memoryStart = getMemoryUsageMB().rss;
  
  // Track metrics
  const logs = [];
  let completed = 0;
  let failed = 0;
  let peakThroughput = 0;
  let lastProcessed = 0;
  let startTime = Date.now();
  let enqueuedCount = 0;
  let enqueuingActive = true;
  let enqueuingInProgress = false;
  
  let resolveDone;
  const donePromise = new Promise(resolve => { resolveDone = resolve; });
  
  const worker = new Worker(queueName, async (job) => {
    // Simulate lightweight task CPU load
    let sum = 0;
    for (let k = 0; k < 100; k++) sum += Math.sin(k);
  }, { 
    concurrency: CONCURRENCY, 
    connection: connectionOpts,
    lockDuration: 10000,
    removeOnComplete: 1000, // keep memory stable
    removeOnFail: 1000
  });
  
  const prefix = queue.prefix || 'taurusmq';
  
  // Helper to maintain queue buffer
  const fillQueueBuffer = async () => {
    if (!enqueuingActive || enqueuingInProgress) return;
    
    // Check if duration limit reached
    if (DURATION_LIMIT) {
      const elapsedSec = (Date.now() - startTime) / 1000;
      if (elapsedSec >= DURATION_LIMIT) {
        console.log(`\n⏱️ Duration limit of ${DURATION_LIMIT}s reached. Stopping enqueues.`);
        enqueuingActive = false;
        return;
      }
    }
    
    // Check if job-count limit reached
    if (NUM_JOBS_LIMIT && enqueuedCount >= NUM_JOBS_LIMIT) {
      enqueuingActive = false;
      return;
    }
    
    enqueuingInProgress = true;
    try {
      const waiting = await queue.client.llen(`${prefix}:${queueName}`);
      if (waiting < BUFFER_TARGET) {
        let toEnqueue = BATCH_ENQUEUE_SIZE;
        
        // If job-count limited, don't exceed target
        if (NUM_JOBS_LIMIT) {
          const remaining = NUM_JOBS_LIMIT - enqueuedCount;
          if (remaining <= 0) {
            enqueuingActive = false;
            return;
          }
          toEnqueue = Math.min(BATCH_ENQUEUE_SIZE, remaining);
        }
        
        const batchJobs = [];
        const dummyPayload = { data: 'x'.repeat(100) };
        for (let j = 0; j < toEnqueue; j++) {
          batchJobs.push({ name: 'endurance-task', data: dummyPayload });
        }
        
        await queue.addBulk(batchJobs);
        enqueuedCount += toEnqueue;
      }
    } catch (err) {
      console.error('Error filling queue buffer:', err);
    } finally {
      enqueuingInProgress = false;
    }
  };

  const checkCompletion = async () => {
    const processed = completed + failed;
    if (NUM_JOBS_LIMIT && processed >= NUM_JOBS_LIMIT) {
      resolveDone();
      return;
    }
    
    if (DURATION_LIMIT && !enqueuingActive) {
      // If we stopped enqueuing, wait until Redis is empty
      const waiting = await queue.client.llen(`${prefix}:${queueName}`);
      const active = await queue.client.zcard(`${prefix}:active:${queueName}`);
      if (waiting === 0 && active === 0) {
        resolveDone();
      }
    }
  };
  
  worker.on('completed', () => {
    completed++;
    checkCompletion();
  });
  
  worker.on('failed', () => {
    failed++;
    checkCompletion();
  });
  
  // Initial fill
  console.log(`\n📥 Priming queue with initial ${BUFFER_TARGET.toLocaleString()} jobs...`);
  const dummyPayload = { data: 'x'.repeat(100) };
  for (let i = 0; i < BUFFER_TARGET; i += BATCH_ENQUEUE_SIZE) {
    const batchJobs = [];
    for (let j = 0; j < BATCH_ENQUEUE_SIZE; j++) {
      batchJobs.push({ name: 'endurance-task', data: dummyPayload });
    }
    await queue.addBulk(batchJobs);
    enqueuedCount += BATCH_ENQUEUE_SIZE;
  }
  console.log(`✅ Queue primed.`);
  
  console.log('\n🟢 Starting worker loops and telemetry recording...');
  await worker.start();
  
  // Periodic queue filling loop (every 200ms) to prevent thundering herd
  const enqueueInterval = setInterval(async () => {
    await fillQueueBuffer();
  }, 200);
  
  // Set up telemetry recorder interval
  const recordInterval = setInterval(async () => {
    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    const processed = completed + failed;
    
    // Interval throughput
    const deltaProcessed = processed - lastProcessed;
    const intervalSec = RECORD_INTERVAL_MS / 1000;
    const throughput = deltaProcessed / intervalSec;
    if (throughput > peakThroughput) peakThroughput = throughput;
    
    lastProcessed = processed;
    
    const mem = getMemoryUsageMB();
    const waiting = await queue.client.llen(`${prefix}:${queueName}`);
    const active = await queue.client.zcard(`${prefix}:active:${queueName}`);
    
    const logEntry = {
      time: `${elapsedSeconds}s`,
      seconds: elapsedSeconds,
      processed,
      throughput,
      rss: mem.rss,
      heap: mem.heapUsed,
      waiting,
      active,
      completed,
      failed
    };
    
    logs.push(logEntry);
    
    console.log(`[${logEntry.time}] Processed: ${processed.toLocaleString()} | Throughput: ${throughput.toFixed(0)} jobs/s | RSS: ${mem.rss}MB | Heap: ${mem.heapUsed}MB | Wait: ${waiting} | Active: ${active}`);
  }, RECORD_INTERVAL_MS);
  
  // Wait for completion
  await donePromise;
  
  // Cleanup
  clearInterval(recordInterval);
  clearInterval(enqueueInterval);
  await worker.stop();
  await scheduler.stop();
  
  const totalDurationMs = Date.now() - startTime;
  const totalDurationSec = totalDurationMs / 1000;
  const totalProcessed = completed + failed;
  const avgThroughput = totalProcessed / totalDurationSec;
  const memoryEnd = getMemoryUsageMB().rss;
  
  const finalWaiting = await queue.client.llen(`${prefix}:${queueName}`);
  const finalActive = await queue.client.zcard(`${prefix}:active:${queueName}`);
  
  const isSuccess = (finalWaiting === 0) && (finalActive === 0);
  
  console.log('\n====================================================');
  console.log('🏆 ENDURANCE TEST SUMMARY REPORT');
  console.log('====================================================');
  console.log(`Jobs               : ${totalProcessed.toLocaleString()}`);
  console.log(`Duration           : ${Math.floor(totalDurationSec / 3600)}h ${Math.floor((totalDurationSec % 3600) / 60)}m ${Math.round(totalDurationSec % 60)}s`);
  console.log(`Average Throughput : ${avgThroughput.toFixed(2)} jobs/sec`);
  console.log(`Peak Throughput    : ${peakThroughput.toFixed(2)} jobs/sec`);
  console.log(`Memory Start       : ${memoryStart} MB`);
  console.log(`Memory End         : ${memoryEnd} MB`);
  console.log(`Completed          : ${completed}`);
  console.log(`Failed             : ${failed}`);
  console.log(`Waiting            : ${finalWaiting}`);
  console.log(`Active             : ${finalActive}`);
  console.log(`Status             : ${isSuccess ? 'PASS' : 'FAIL'}`);
  console.log('====================================================');
  
  // Write logs to json
  const RAW_DIR = path.join(__dirname, 'raw');
  if (!fs.existsSync(RAW_DIR)) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
  }
  const reportPath = path.join(RAW_DIR, 'endurance-results.json');
  const summaryReport = {
    jobs: totalProcessed,
    durationSec: totalDurationSec,
    avgThroughput,
    peakThroughput,
    memoryStart,
    memoryEnd,
    completed,
    failed,
    waiting: finalWaiting,
    active: finalActive,
    status: isSuccess ? 'PASS' : 'FAIL',
    timeline: logs
  };
  
  fs.writeFileSync(reportPath, JSON.stringify(summaryReport, null, 2));
  console.log(`💾 Timeline records written to: ${reportPath}`);
  
  await queue.close();
  process.exit(isSuccess ? 0 : 1);
}

runEnduranceTest().catch(err => {
  console.error('Fatal error in endurance test:', err);
  process.exit(1);
});
