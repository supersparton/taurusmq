// packages/metrics-engine/MetricsAggregator.js
// Runs on a tick interval. Reads raw counters + ring buffers from Redis
// and computes materialized metrics (rates, percentiles, health scores).
// Writes results to tmq:obs:materialized:{queue} for dashboard API consumption.
//
// Aggregation formulas:
//
//   throughput (jobs/min)    = sum of last 5 per-minute tp buckets / 5
//   enqueue rate (jobs/min)  = delta(created) / elapsed minutes
//   completion rate (j/min)  = delta(completed) / elapsed minutes
//   error rate (%)           = failed / (completed + failed) over sliding window
//   retry rate (%)           = retries / (completed + failed)
//   avg latency (ms)         = mean of latency ring buffer
//   p50/p95/p99 latency (ms) = percentile of latency ring buffer (sorted)

'use strict';

const redis = require('../../src/utils/redis');

const TICK_MS       = 10_000; // aggregate every 10 seconds
const TP_WINDOW_MIN = 5;      // throughput = avg over 5 minutes

class MetricsAggregator {
  /**
   * @param {string[]} queueNames  — queues to aggregate (can be dynamic later)
   */
  constructor(queueNames = []) {
    this.queueNames = queueNames;
    this._timer     = null;
    // Snapshot for delta-rate calculations: { queueName: { completed, failed, created, ts } }
    this._prev = {};
  }

  start() {
    this._timer = setInterval(() => this._tick(), TICK_MS);
    console.log('[obs] MetricsAggregator started, tick every', TICK_MS / 1000, 's');
  }

  stop() {
    clearInterval(this._timer);
  }

  /** Register a queue discovered at runtime */
  addQueue(queueName) {
    if (!this.queueNames.includes(queueName)) {
      this.queueNames.push(queueName);
    }
  }

  async _tick() {
    for (const queue of this.queueNames) {
      try {
        await this._aggregateQueue(queue);
      } catch (err) {
        console.error('[obs] MetricsAggregator error for', queue, ':', err.message);
      }
    }
  }

  async _aggregateQueue(queue) {
    const cKey       = `tmq:obs:metrics:${queue}:counters`;
    const latKey     = `tmq:obs:metrics:${queue}:latency`;
    const matKey     = `tmq:obs:materialized:${queue}`;
    const now        = Date.now();
    const minuteNow  = Math.floor(now / 60_000);

    // ── 1. Read raw counters ──────────────────────────────────────────
    const counters = await redis.hgetall(cKey) ?? {};
    const c = (f) => parseInt(counters[f] ?? '0', 10);

    const waiting   = c('waiting');
    const active    = c('active');
    const delayed   = c('delayed');
    const failed    = c('failed');
    const completed = c('completed');
    const created   = c('created');
    const retries   = c('retries');
    const totalDurMs = c('totalDurationMs');
    const totalComp  = c('totalCompleted');

    // ── 2. Throughput: avg completed/min over last TP_WINDOW_MIN buckets ─
    let tpSum = 0;
    const tpBuckets = await Promise.all(
      Array.from({ length: TP_WINDOW_MIN }, (_, i) => {
        const bk = minuteNow - i;
        return redis.zscore(`tmq:obs:tp:${queue}:${bk}`, 'count');
      })
    );
    tpBuckets.forEach(v => { tpSum += parseFloat(v ?? '0'); });
    const throughput = tpSum / TP_WINDOW_MIN; // jobs per minute, float

    // ── 3. Delta rates (requires previous snapshot) ───────────────────
    const prev     = this._prev[queue] ?? { completed: 0, failed: 0, created: 0, ts: now };
    const elapsedMin = Math.max((now - prev.ts) / 60_000, 0.001); // avoid div-by-0

    const completionRatePerMin = (completed - prev.completed) / elapsedMin;
    const enqueueRatePerMin    = (created   - prev.created)   / elapsedMin;

    this._prev[queue] = { completed, failed, created, ts: now };

    // ── 4. Error rate & retry rate ────────────────────────────────────
    const totalAttempted = completed + failed;
    const errorRate      = totalAttempted > 0 ? failed    / totalAttempted : 0;
    const retryRate      = totalAttempted > 0 ? retries   / totalAttempted : 0;

    // ── 5. Avg latency ────────────────────────────────────────────────
    const avgLatencyMs = totalComp > 0 ? totalDurMs / totalComp : 0;

    // ── 6. Percentile latency from ring buffer ────────────────────────
    const rawSamples = await redis.lrange(latKey, 0, -1);
    const samples    = rawSamples.map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    const p50 = this._pct(samples, 0.50);
    const p95 = this._pct(samples, 0.95);
    const p99 = this._pct(samples, 0.99);

    // ── 7. Net growth rate ────────────────────────────────────────────
    // Positive = queue is growing (enqueue > drain)
    const netGrowthRate = enqueueRatePerMin - completionRatePerMin;

    // ── 8. Health score (0-100, lower = worse) ────────────────────────
    // Formula: weighted penalties on error rate, latency, depth, retry rate
    const healthScore = this._computeHealthScore({
      errorRate, retryRate, waiting, active, avgLatencyMs, p99, netGrowthRate,
    });

    // ── 9. Write materialized metrics ─────────────────────────────────
    await redis.hset(matKey,
      'waiting',             String(waiting),
      'active',              String(active),
      'delayed',             String(delayed),
      'failed',              String(failed),
      'completed',           String(completed),
      'created',             String(created),
      'retries',             String(retries),
      'throughput',          String(Math.round(throughput * 100) / 100),
      'enqueueRate',         String(Math.round(enqueueRatePerMin * 100) / 100),
      'completionRate',      String(Math.round(completionRatePerMin * 100) / 100),
      'errorRate',           String(Math.round(errorRate * 10000) / 10000),
      'retryRate',           String(Math.round(retryRate * 10000) / 10000),
      'avgLatencyMs',        String(Math.round(avgLatencyMs)),
      'p50LatencyMs',        String(p50),
      'p95LatencyMs',        String(p95),
      'p99LatencyMs',        String(p99),
      'netGrowthRate',       String(Math.round(netGrowthRate * 100) / 100),
      'healthScore',         String(healthScore),
      'samplesCount',        String(samples.length),
      'updatedAt',           String(now),
    );

    // ── 10. Record history point for charts (keeps last 360 points / 1 hour) ──
    const historyItem = JSON.stringify({
      t: now,
      throughput: Math.round(throughput * 100) / 100,
      latency: Math.round(avgLatencyMs)
    });
    const histKey = `tmq:obs:metrics:${queue}:history`;
    await redis.rpush(histKey, historyItem);
    await redis.ltrim(histKey, -360, -1);

    // ── 11. Redesigned Alerts Threshold Evaluation (Push-Based) ───────
    try {
      const rulesRaw = await redis.hgetall('taurusmq:obs:alert_rules') ?? {};
      const activeIncidents = await redis.hgetall('tmq:obs:alerts') ?? {};

      for (const [ruleId, ruleJson] of Object.entries(rulesRaw)) {
        let rule;
        try {
          rule = JSON.parse(ruleJson);
        } catch (_) {
          continue;
        }

        if (rule.queue !== queue) {
          continue;
        }

        // Evaluate metric value
        let currentVal = 0;
        let metricLabel = '';
        let isViolation = false;

        switch (rule.metric) {
          case 'waiting':
            currentVal = waiting;
            metricLabel = 'waiting jobs';
            isViolation = waiting > rule.threshold;
            break;
          case 'active':
            currentVal = active;
            metricLabel = 'active jobs';
            isViolation = active > rule.threshold;
            break;
          case 'failed':
            currentVal = failed;
            metricLabel = 'failed jobs';
            isViolation = failed > rule.threshold;
            break;
          case 'error_rate':
          case 'failure_rate':
            currentVal = Math.round(errorRate * 10000) / 100; // in %
            metricLabel = 'failure rate';
            isViolation = currentVal > rule.threshold;
            break;
          case 'avg_latency_ms':
          case 'latency':
            currentVal = Math.round(avgLatencyMs);
            metricLabel = 'average latency';
            isViolation = currentVal > rule.threshold;
            break;
          case 'health_score':
          case 'health':
            currentVal = healthScore;
            metricLabel = 'health score';
            isViolation = healthScore < rule.threshold; // lower than threshold is bad
            break;
          default:
            continue;
        }

        const mapKey = ruleId;
        const wasFiring = !!activeIncidents[mapKey];

        if (isViolation) {
          const suffix = rule.metric.includes('rate') ? '%' : (rule.metric.includes('latency') ? 'ms' : '');
          const description = `Queue "${queue}" ${metricLabel} of ${currentVal}${suffix} violated threshold of ${rule.threshold}${suffix}.`;

          const incident = {
            id: ruleId,
            ruleId: ruleId,
            ruleName: rule.name || `${rule.metric} alert`,
            severity: rule.severity || 'critical',
            scope: 'queue',
            scopeTarget: queue,
            state: 'firing',
            firedAt: wasFiring ? JSON.parse(activeIncidents[mapKey]).firedAt : Date.now(),
            resolvedAt: null,
            evidence: [description],
            labels: { queue, metric: rule.metric, threshold: String(rule.threshold), current: String(currentVal) },
            consecutiveTicks: wasFiring ? (JSON.parse(activeIncidents[mapKey]).consecutiveTicks || 0) + 1 : 1,
          };

          // Save/Update incident in Redis
          const jsonStr = JSON.stringify(incident);
          await redis.pipeline()
            .hset('tmq:obs:incidents', ruleId, jsonStr)
            .hset('tmq:obs:alerts', ruleId, jsonStr)
            .exec();

          // If it just transitioned to firing, send webhook
          if (!wasFiring) {
            console.log(`[obs] ALERT FIRED: ${rule.name || rule.metric} on queue ${queue}`);
            if (rule.webhook) {
              await sendSlackNotification(rule.webhook, {
                text: `🚨 *[TaurusMQ ALERT FIRED]* *${rule.name || rule.metric}* on queue *${queue}*\n> Severity: ${rule.severity || 'critical'}\n> Description: ${description}`
              });
            }
          }
        } else {
          // If it was firing but now is normal, resolve it
          if (wasFiring) {
            const stored = JSON.parse(activeIncidents[mapKey]);
            stored.state = 'resolved';
            stored.resolvedAt = Date.now();
            const jsonStr = JSON.stringify(stored);

            await redis.pipeline()
              .hset('tmq:obs:incidents', ruleId, jsonStr)
              .hdel('tmq:obs:alerts', ruleId)
              .exec();

            console.log(`[obs] ALERT RESOLVED: ${rule.name || rule.metric} on queue ${queue}`);

            if (rule.webhook) {
              await sendSlackNotification(rule.webhook, {
                text: `✅ *[TaurusMQ ALERT RESOLVED]* *${rule.name || rule.metric}* on queue *${queue}*\n> Was resolved at: ${new Date(stored.resolvedAt).toISOString()}`
              });
            }
          }
        }
      }
    } catch (err) {
      console.error('[obs] Alert evaluation error for', queue, ':', err.message);
    }
  }

  /**
   * Percentile calculation (nearest-rank method).
   * @param {number[]} sorted  - pre-sorted ascending array
   * @param {number}   pct     - 0.0–1.0
   */
  _pct(sorted, pct) {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(pct * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }

  /**
   * Health score formula (deterministic, no hardcoding):
   *
   *   Start at 100.
   *   - errorRate  > 0.01 → deduct up to 30 pts (proportional: errorRate/0.50 * 30)
   *   - p99Latency > 2000ms → deduct up to 20 pts (proportional: p99/30000 * 20)
   *   - retryRate  > 0.05 → deduct up to 15 pts
   *   - netGrowthRate > 10/min → deduct up to 20 pts (undrainable queue)
   *   - waiting    > 1000 → deduct up to 15 pts
   *
   * Result clamped to [0, 100].
   */
  _computeHealthScore({ errorRate, retryRate, waiting, avgLatencyMs, p99, netGrowthRate }) {
    let score = 100;
    score -= Math.min(30, (errorRate / 0.50) * 30);
    score -= Math.min(20, (p99 / 30_000)    * 20);
    score -= Math.min(15, (retryRate / 0.30) * 15);
    score -= Math.min(20, netGrowthRate > 10 ? (netGrowthRate / 200) * 20 : 0);
    score -= Math.min(15, waiting > 1000 ? (waiting / 10_000) * 15 : 0);
    return Math.max(0, Math.round(score));
  }
}

async function sendSlackNotification(url, payload) {
  if (!url) return;
  try {
    if (typeof fetch === 'function') {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        console.error('[obs] Webhook response not OK:', response.status);
      }
    } else {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? require('https') : require('http');
      const dataStr = JSON.stringify(payload);
      const req = client.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr),
        },
      }, (res) => {
        res.resume();
      });
      req.on('error', (err) => {
        console.error('[obs] Fallback webhook request error:', err.message);
      });
      req.write(dataStr);
      req.end();
    }
  } catch (err) {
    console.error('[obs] Failed to send slack alert notification:', err.message);
  }
}

module.exports = { MetricsAggregator };
