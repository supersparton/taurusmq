// taurusmq/benchmarks/run-suite.js
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAW_DIR = path.join(__dirname, 'raw');
if (!fs.existsSync(RAW_DIR)) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
}

// Relative paths updated for taurusmq/benchmarks/ location
const TAURUS_BENCH = path.resolve(__dirname, '../tests/benchmark.js');
const BULL_BENCH = path.resolve(__dirname, '../../benchmark/benchmark.js');
const TAURUS_OUT = path.resolve(__dirname, '../benchmark-results.json');
const BULL_OUT = path.resolve(__dirname, '../../benchmark/benchmark-results-bullmq.json');

const RUNS = 5;

// Helper to calculate statistics
function calculateStats(values) {
  if (values.length === 0) return { avg: 0, median: 0, min: 0, max: 0, stdDev: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = values.reduce((acc, v) => acc + v, 0);
  const avg = sum / values.length;
  
  // Median
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  
  // Standard Deviation
  const variance = values.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  
  return { avg, median, min, max, stdDev };
}

// Helper to aggregate results across multiple runs
function aggregateRuns(runDataList) {
  const perfMetrics = {
    enqueueThroughput: [],
    consumerThroughput: [],
    avgLatencyMs: [],
    p50Ms: [],
    p95Ms: [],
    p99Ms: [],
    cpuMs: [],
    peakRssMB: []
  };
  
  const stressMetrics = {}; // level -> metric -> []
  
  runDataList.forEach(run => {
    // Perf
    const p = run.results.performance;
    if (p) {
      Object.keys(perfMetrics).forEach(k => {
        if (p[k] !== undefined) perfMetrics[k].push(p[k]);
      });
    }
    
    // Stress
    const s = run.results.stress;
    if (s && Array.isArray(s)) {
      s.forEach(levelData => {
        const c = levelData.concurrency;
        if (!stressMetrics[c]) {
          stressMetrics[c] = {
            enqueueThroughput: [],
            consumerThroughput: [],
            avgLatencyMs: [],
            p50Ms: [],
            p95Ms: [],
            p99Ms: [],
            cpuMs: [],
            peakRssMB: []
          };
        }
        Object.keys(stressMetrics[c]).forEach(k => {
          if (levelData[k] !== undefined) stressMetrics[c][k].push(levelData[k]);
        });
      });
    }
  });
  
  const aggregated = {
    performance: {},
    stress: []
  };
  
  Object.keys(perfMetrics).forEach(k => {
    aggregated.performance[k] = calculateStats(perfMetrics[k]);
  });
  
  Object.keys(stressMetrics).forEach(c => {
    const cData = { concurrency: parseInt(c, 10) };
    Object.keys(stressMetrics[c]).forEach(k => {
      cData[k] = calculateStats(stressMetrics[c][k]);
    });
    aggregated.stress.push(cData);
  });
  
  aggregated.stress.sort((a, b) => a.concurrency - b.concurrency);
  
  return aggregated;
}

async function runSuite() {
  console.log('====================================================');
  console.log('🚀 STARTING AUTOMATED BENCHMARK SUITE (5 RUNS EACH)');
  console.log('====================================================');
  
  const taurusRuns = [];
  const bullRuns = [];
  
  for (let i = 1; i <= RUNS; i++) {
    console.log(`\n--- [RUN ${i}/${RUNS}] Running TaurusMQ Benchmark ---`);
    try {
      execSync(`node "${TAURUS_BENCH}" --jobs=50000 --concurrency=50`, { stdio: 'inherit' });
      const rawData = JSON.parse(fs.readFileSync(TAURUS_OUT, 'utf8'));
      fs.writeFileSync(path.join(RAW_DIR, `taurusmq-run-${i}.json`), JSON.stringify(rawData, null, 2));
      taurusRuns.push(rawData);
    } catch (err) {
      console.error(`❌ TaurusMQ Run ${i} failed:`, err.message);
    }
    
    console.log(`\n--- [RUN ${i}/${RUNS}] Running BullMQ Benchmark ---`);
    try {
      execSync(`node "${BULL_BENCH}" --jobs=50000 --concurrency=50`, { stdio: 'inherit' });
      const rawData = JSON.parse(fs.readFileSync(BULL_OUT, 'utf8'));
      fs.writeFileSync(path.join(RAW_DIR, `bullmq-run-${i}.json`), JSON.stringify(rawData, null, 2));
      bullRuns.push(rawData);
    } catch (err) {
      console.error(`❌ BullMQ Run ${i} failed:`, err.message);
    }
  }
  
  console.log('\n📊 Aggregating Results...');
  const taurusAggregated = aggregateRuns(taurusRuns);
  const bullAggregated = aggregateRuns(bullRuns);
  
  fs.writeFileSync(path.join(__dirname, 'taurusmq-results.json'), JSON.stringify(taurusAggregated, null, 2));
  fs.writeFileSync(path.join(__dirname, 'bullmq-results.json'), JSON.stringify(bullAggregated, null, 2));
  
  console.log('✅ Aggregated results written to:');
  console.log(`- ${path.join(__dirname, 'taurusmq-results.json')}`);
  console.log(`- ${path.join(__dirname, 'bullmq-results.json')}`);
  
  console.log('\n====================================================');
  console.log('🏆 SUITE EXECUTION COMPLETED');
  console.log('====================================================');
}

runSuite();
