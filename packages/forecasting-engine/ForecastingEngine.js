// packages/forecasting-engine/ForecastingEngine.js
// Pure-math capacity forecasting. No ML, no AI.
// All formulas are documented below.
//
// ── Formulas ────────────────────────────────────────────────────────────────
//
// Given:
//   E = enqueue rate (jobs/min)         — from materialized metrics
//   C = completion rate (jobs/min)      — from materialized metrics
//   D = current queue depth (waiting)   — from Redis LLEN / hgetall
//   W = current worker count            — from live worker state
//   Mc = completion rate per worker     — C / W  (when W > 0)
//
// Net growth rate:
//   G = E - C          (positive = queue growing, negative = draining)
//
// Time to overflow (when G > 0 and overflow threshold T is set):
//   timeToOverflowMs = ((T - D) / G) * 60_000
//   if D >= T → overflow NOW (0ms)
//   if G <= 0 → no overflow predicted
//
// Drain time (when G < 0):
//   drainTimeMs = (D / abs(G)) * 60_000
//
// Workers required to drain at target rate R (jobs/min):
//   workersNeeded = ceil(E / Mc)        when Mc > 0
//   workersNeeded = W + 2               fallback when no baseline
//
// Projected depth in T minutes:
//   depthAtT = D + (G * T)
//   clamped to >= 0

'use strict';

const redis = require('../../src/utils/redis');

const DEFAULT_OVERFLOW_THRESHOLD = 5000; // jobs — tune per queue

class ForecastingEngine {
  /**
   * Compute capacity forecast for a queue.
   *
   * @param {string} queueName
   * @param {Object} opts
   * @param {number} opts.overflowThreshold  - depth at which SLA breaks
   * @param {number} opts.horizonMinutes     - projection horizon (default 60)
   * @returns {Promise<Object>}
   */
  async forecastQueue(queueName, opts = {}) {
    const threshold      = opts.overflowThreshold ?? DEFAULT_OVERFLOW_THRESHOLD;
    const horizonMinutes = opts.horizonMinutes    ?? 60;

    // ── Read live materialized metrics ──────────────────────────────────
    const m = await redis.hgetall(`tmq:obs:materialized:${queueName}`) ?? {};
    const w = await this._countActiveWorkers(queueName);

    const depth          = parseInt(m.waiting      ?? '0', 10);
    const enqueueRate    = parseFloat(m.enqueueRate    ?? '0');  // jobs/min
    const completionRate = parseFloat(m.completionRate ?? '0');  // jobs/min

    // ── Core calculations ────────────────────────────────────────────────
    const netGrowthRate      = enqueueRate - completionRate; // G
    const projectedDepth1h   = Math.max(0, depth + (netGrowthRate * horizonMinutes));
    const completionPerWorker = w > 0 ? completionRate / w : 0; // Mc

    let timeToOverflowMs = null;
    if (depth >= threshold) {
      timeToOverflowMs = 0; // already overflowed
    } else if (netGrowthRate > 0) {
      const minutesToOverflow = (threshold - depth) / netGrowthRate;
      timeToOverflowMs = minutesToOverflow * 60_000;
    }

    let drainTimeMs = null;
    if (netGrowthRate < 0) {
      drainTimeMs = (depth / Math.abs(netGrowthRate)) * 60_000;
    } else if (depth === 0) {
      drainTimeMs = 0;
    }

    // Workers needed to drain: need completionRate > enqueueRate
    // workersNeeded = ceil(enqueueRate / completionPerWorker) + 1 safety margin
    let workersNeeded = 0;
    if (netGrowthRate > 0) {
      if (completionPerWorker > 0) {
        workersNeeded = Math.ceil((enqueueRate / completionPerWorker)) - w + 1;
      } else {
        workersNeeded = w > 0 ? w + 2 : 3; // fallback
      }
    }

    // Build recommendation text from the numbers
    const recommendation = this._buildRecommendation({
      queueName, netGrowthRate, timeToOverflowMs, workersNeeded,
      drainTimeMs, depth, projectedDepth1h, threshold,
    });

    return {
      queueName,
      currentDepth:       depth,
      enqueueRate:        Math.round(enqueueRate   * 100) / 100,
      completionRate:     Math.round(completionRate * 100) / 100,
      netGrowthRate:      Math.round(netGrowthRate  * 100) / 100,
      projectedDepth1h:   Math.round(projectedDepth1h),
      overflowThreshold:  threshold,
      timeToOverflowMs:   timeToOverflowMs !== null ? Math.round(timeToOverflowMs) : null,
      drainTimeMs:        drainTimeMs     !== null ? Math.round(drainTimeMs)      : null,
      workersNeeded,
      activeWorkers:      w,
      recommendation,
      computedAt:         Date.now(),
    };
  }

  /**
   * Forecast all known queues in parallel.
   * @param {string[]} queueNames
   */
  async forecastAll(queueNames, opts = {}) {
    return Promise.all(queueNames.map(q => this.forecastQueue(q, opts)));
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  async _countActiveWorkers(queueName) {
    const keys = await redis.keys('tmq:obs:worker:*:state');
    let count = 0;
    for (const key of keys) {
      const s = await redis.hgetall(key);
      if (s?.queue === queueName && s?.state === 'online') count++;
    }
    return count;
  }

  _buildRecommendation({ queueName, netGrowthRate, timeToOverflowMs, workersNeeded,
                          drainTimeMs, depth, projectedDepth1h, threshold }) {
    if (depth === 0 && netGrowthRate <= 0) {
      return 'Queue is empty and draining. No action needed.';
    }
    if (netGrowthRate > 0) {
      const mins = timeToOverflowMs != null
        ? `~${Math.round(timeToOverflowMs / 60_000)}m`
        : 'unknown';
      const workerText = workersNeeded > 0 ? ` Add ${workersNeeded} worker(s) immediately.` : '';
      return `Queue growing at ${netGrowthRate.toFixed(1)}/min. ` +
             `SLA threshold (${threshold}) reached in ${mins}.${workerText}`;
    }
    if (netGrowthRate < 0) {
      const drainMins = drainTimeMs != null ? `~${Math.round(drainTimeMs / 60_000)}m` : 'unknown';
      return `Queue draining at ${Math.abs(netGrowthRate).toFixed(1)}/min. ` +
             `Full drain estimated in ${drainMins}. Monitor for rate change.`;
    }
    return `Queue stable at ${depth} depth. Enqueue equals completion rate.`;
  }
}

module.exports = { ForecastingEngine };
