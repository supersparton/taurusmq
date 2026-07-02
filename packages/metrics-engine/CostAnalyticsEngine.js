// packages/metrics-engine/CostAnalyticsEngine.js
// Computes actual cost per queue from worker runtime telemetry.
//
// ── Cost Formulas ────────────────────────────────────────────────────────────
//
// Input (per worker, per aggregation window):
//   memoryBytes  = process.memoryUsage().rss   (collected every 15s)
//   cpuPercent   = cpu delta / elapsed time * 100
//   windowSec    = time since last resource sample (default 15s)
//
// EC2 equivalent pricing (configurable via COST_CONFIG):
//   CPU cost:    $0.0000048 per vCPU-second   (based on c5.large: $0.085/hr / 2vCPU / 3600)
//   Memory cost: $0.0000006 per GB-second      (based on $0.0085/GB-hr / 3600)
//
// Per-sample cost:
//   cpuCost(sample)    = (cpuPercent/100) * windowSec * CPU_COST_PER_VCPU_SEC
//   memoryCost(sample) = (memoryBytes / 1e9) * windowSec * MEM_COST_PER_GB_SEC
//   sampleCost         = cpuCost + memoryCost
//
// Accumulated in Redis:
//   tmq:obs:cost:{queue}:totalUSD       — INCRBYFLOAT accumulator
//   tmq:obs:cost:{queue}:successfulJobs — INCR
//   tmq:obs:cost:{queue}:failedJobCost  — INCRBYFLOAT (cost of jobs that failed)
//
// Derived:
//   costPerSuccessfulJob = totalUSD / successfulJobs
//   wastedCostUSD        = failedJobCost
//   wastePercent         = wastedCostUSD / totalUSD * 100

'use strict';

const redis      = require('../../src/utils/redis');
const { bus }    = require('../observability-core/ObservabilityBus');
const { EventType } = require('../observability-core/types');

const COST_CONFIG = {
  CPU_COST_PER_VCPU_SEC: parseFloat(process.env.COST_CPU_PER_VCPU_SEC ?? '0.0000048'),
  MEM_COST_PER_GB_SEC:   parseFloat(process.env.COST_MEM_PER_GB_SEC   ?? '0.0000006'),
  WINDOW_SEC:            15, // resource sample interval
};

// Track last CPU/mem sample per worker to compute per-sample costs
const _workerLastSample = new Map(); // workerId → { ts, costUSD }

class CostAnalyticsEngine {
  start() {
    // Accumulate cost on every resource event
    bus.on(EventType.WORKER_MEMORY, (e) => this._onMemory(e));
    bus.on(EventType.WORKER_CPU,    (e) => this._onCpu(e));

    // Track which queue a completed/failed job belongs to for waste attribution
    bus.on(EventType.JOB_COMPLETED, (e) => this._onJobCompleted(e));
    bus.on(EventType.JOB_FAILED,    (e) => this._onJobFailed(e));

    console.log('[obs] CostAnalyticsEngine started');
  }

  async _onCpu({ workerId, queueName, cpuPercent }) {
    const sample = _workerLastSample.get(workerId) ?? { ts: Date.now() };
    const windowSec = Math.min((Date.now() - sample.ts) / 1000, 60); // cap at 60s

    const cpuCost = (cpuPercent / 100) * windowSec * COST_CONFIG.CPU_COST_PER_VCPU_SEC;
    const prevCost = sample.lastTotalCost ?? 0;
    const newCost  = prevCost + cpuCost;

    _workerLastSample.set(workerId, { ts: Date.now(), lastTotalCost: newCost, cpuPercent, queueName });

    if (queueName && cpuCost > 0) {
      await redis.incrbyfloat(`tmq:obs:cost:${queueName}:totalUSD`, cpuCost);
    }
  }

  async _onMemory({ workerId, queueName, memoryBytes }) {
    const sample    = _workerLastSample.get(workerId) ?? { ts: Date.now() };
    const windowSec = Math.min((Date.now() - sample.ts) / 1000, 60);
    const memGb     = memoryBytes / 1e9;
    const memCost   = memGb * windowSec * COST_CONFIG.MEM_COST_PER_GB_SEC;

    if (queueName && memCost > 0) {
      await redis.incrbyfloat(`tmq:obs:cost:${queueName}:totalUSD`, memCost);
    }

    _workerLastSample.set(workerId, {
      ...(_workerLastSample.get(workerId) ?? {}),
      memoryBytes, queueName,
    });
  }

  async _onJobCompleted({ queueName, durationMs }) {
    if (!queueName) return;
    // Attribute proportional cost to this job based on its duration
    const jobCostUSD = this._estimateJobCost(durationMs);
    await redis.pipeline()
      .incr(`tmq:obs:cost:${queueName}:successfulJobs`)
      .incrbyfloat(`tmq:obs:cost:${queueName}:successfulJobCost`, jobCostUSD)
      .exec();
  }

  async _onJobFailed({ queueName, durationMs }) {
    if (!queueName) return;
    const jobCostUSD = this._estimateJobCost(durationMs);
    await redis.pipeline()
      .incr(`tmq:obs:cost:${queueName}:failedJobs`)
      .incrbyfloat(`tmq:obs:cost:${queueName}:failedJobCost`, jobCostUSD)
      .exec();
  }

  /**
   * Estimate cost of a single job from its duration.
   * Uses a single-worker baseline: 1 vCPU, avg memory during job.
   * This is an approximation — real attribution requires per-job resource sampling.
   *
   * costUSD ≈ durationSec × (CPU_COST_PER_VCPU_SEC + avgMemGb × MEM_COST_PER_GB_SEC)
   */
  _estimateJobCost(durationMs) {
    const durationSec  = (durationMs ?? 0) / 1000;
    const avgMemGb     = 0.25; // conservative baseline; replace with sampled value if available
    return durationSec * (COST_CONFIG.CPU_COST_PER_VCPU_SEC + avgMemGb * COST_CONFIG.MEM_COST_PER_GB_SEC);
  }

  /**
   * Read cost summary for a queue.
   * @param {string} queueName
   * @returns {Promise<Object>}
   */
  async getCostSummary(queueName) {
    const [
      totalUSD, successfulJobs, failedJobs, failedJobCost, successfulJobCost,
    ] = await Promise.all([
      redis.get(`tmq:obs:cost:${queueName}:totalUSD`),
      redis.get(`tmq:obs:cost:${queueName}:successfulJobs`),
      redis.get(`tmq:obs:cost:${queueName}:failedJobs`),
      redis.get(`tmq:obs:cost:${queueName}:failedJobCost`),
      redis.get(`tmq:obs:cost:${queueName}:successfulJobCost`),
    ]);

    const total   = parseFloat(totalUSD        ?? '0');
    const success = parseInt(successfulJobs    ?? '0', 10);
    const failed  = parseInt(failedJobs        ?? '0', 10);
    const waste   = parseFloat(failedJobCost   ?? '0');
    const usedCost = parseFloat(successfulJobCost ?? '0');

    return {
      queueName,
      estimatedCostUSD:      Math.round(total  * 1e6) / 1e6,
      successfulJobs:        success,
      failedJobs:            failed,
      wastedCostUSD:         Math.round(waste  * 1e6) / 1e6,
      costPerSuccessfulJob:  success > 0 ? Math.round((usedCost / success) * 1e8) / 1e8 : 0,
      wastePercent:          total > 0 ? Math.round((waste / total) * 10000) / 100 : 0,
    };
  }
}

module.exports = { CostAnalyticsEngine, COST_CONFIG };
