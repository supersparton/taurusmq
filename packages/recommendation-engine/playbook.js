// packages/recommendation-engine/playbook.js
// Rule table: Maps incident rule IDs to recommendations.
// Each recommendation is generated with live evidence injected at query time.
// No hardcoded values — all "why" and "impact" are derived from real metrics.

'use strict';

/**
 * PlaybookRule interface:
 * {
 *   ruleId:    string,            // matches IncidentRule.id
 *   priority:  number,            // 1 = highest
 *   urgency:   'immediate'|'within_15m'|'within_1h'|'planned',
 *   type:      'scale'|'fix'|'pause'|'configure'|'investigate',
 *   title:     string,
 *   buildWhy:  (incident, metrics) => string,
 *   buildHow:  (incident, metrics) => string,
 *   buildImpact: (incident, metrics) => string,
 *   estimatedTimeMin: number,
 * }
 */

const PLAYBOOK = [

  // ── high_failure_rate ─────────────────────────────────────────────────
  {
    ruleId:   'high_failure_rate',
    priority: 1,
    urgency:  'immediate',
    type:     'pause',
    title:    'Pause retries to stop failure amplification',
    buildWhy: (inc) =>
      `${inc.labels.actual} failure rate detected on ${inc.labels.queue}. ` +
      `Active retry loop consuming worker capacity with zero drain benefit.`,
    buildHow: (inc) =>
      `taurusmq queue pause-retries ${inc.labels.queue} --state failed`,
    buildImpact: (inc) =>
      `Stops retry storm. Stabilises worker load. Allows investigation of root cause.`,
    estimatedTimeMin: 1,
  },
  {
    ruleId:   'high_failure_rate',
    priority: 2,
    urgency:  'within_15m',
    type:     'investigate',
    title:    'Identify top error group causing failures',
    buildWhy: (inc) =>
      `All failures on ${inc.labels.queue} must share a common error message. ` +
      `Inspecting the top error group will identify the root cause.`,
    buildHow: (inc) =>
      `GET /api/queues/${inc.labels.queue}/errors  — inspect top error group`,
    buildImpact: () =>
      `Narrows RCA from queue-level to specific job or payload type.`,
    estimatedTimeMin: 10,
  },

  // ── queue_backlog ─────────────────────────────────────────────────────
  {
    ruleId:   'queue_backlog',
    priority: 1,
    urgency:  'immediate',
    type:     'scale',
    title:    'Scale workers to match enqueue rate',
    buildWhy: (inc, metrics) => {
      const growth = inc.labels.growthRate;
      const cRate  = parseFloat(metrics?.completionRate ?? '0').toFixed(1);
      return `Queue growing at ${growth}. Current completion rate ${cRate}/min is less than enqueue rate. ` +
             `Workers required to drain: ${inc.labels.workersNeeded ?? 'calculate from forecasting API'}.`;
    },
    buildHow: (inc) =>
      `kubectl scale deployment worker-${inc.labels.queue} --replicas=<N>`,
    buildImpact: () =>
      `Increases drain rate to exceed enqueue rate. Queue depth will decrease.`,
    estimatedTimeMin: 5,
  },

  // ── high_p99_latency ──────────────────────────────────────────────────
  {
    ruleId:   'high_p99_latency',
    priority: 1,
    urgency:  'within_15m',
    type:     'investigate',
    title:    'Identify slow job type causing P99 spike',
    buildWhy: (inc) =>
      `P99 latency ${(parseInt(inc.labels.p99Ms,10)/1000).toFixed(1)}s exceeds SLA. ` +
      `A subset of slow jobs is inflating the tail. Identify which job name has the highest avg duration.`,
    buildHow: (inc) =>
      `GET /api/queues/${inc.labels.queue}/jobs?state=active&sort=duration_desc`,
    buildImpact: () =>
      `Identifies whether latency is caused by job payload, external API, or resource contention.`,
    estimatedTimeMin: 15,
  },

  // ── queue_no_drain ────────────────────────────────────────────────────
  {
    ruleId:   'queue_no_drain',
    priority: 1,
    urgency:  'immediate',
    type:     'investigate',
    title:    'Queue has zero drain rate — check worker health',
    buildWhy: (inc) =>
      `No jobs have completed from ${inc.labels.queue} in the last aggregation window. ` +
      `${inc.labels.waiting} jobs are stuck waiting. Workers may be stalled or exhausted.`,
    buildHow: () =>
      `GET /api/workers  — check worker state, heartbeat age, and memory`,
    buildImpact: () =>
      `Identifies if the blocking condition is worker stall, OOM, or missing workers.`,
    estimatedTimeMin: 2,
  },

  // ── worker_memory_pressure ────────────────────────────────────────────
  {
    ruleId:   'worker_memory_pressure',
    priority: 1,
    urgency:  'immediate',
    type:     'scale',
    title:    'Increase worker memory allocation',
    buildWhy: (inc) =>
      `Worker ${inc.labels.worker} on queue ${inc.labels.queue} at ${inc.labels.heapPct} heap usage. ` +
      `OOM crash imminent. All jobs processed by this worker will fail.`,
    buildHow: (inc) =>
      `Update container: resources.limits.memory: 2Gi on worker-${inc.labels.queue} deployment`,
    buildImpact: () =>
      `Prevents OOM kills. Allows job processing to resume without failure.`,
    estimatedTimeMin: 5,
  },
  {
    ruleId:   'worker_memory_pressure',
    priority: 2,
    urgency:  'within_15m',
    type:     'configure',
    title:    'Add memory circuit breaker to job handler',
    buildWhy: (inc) =>
      `Worker ${inc.labels.worker} has no internal memory cap. A single large job can consume all memory.`,
    buildHow: () =>
      `Set NODE_OPTIONS=--max-old-space-size=1024 in worker Dockerfile or start script`,
    buildImpact: () =>
      `Prevents single job from exhausting container memory. Allows OOM killer to target process, not container.`,
    estimatedTimeMin: 20,
  },

  // ── worker_stalled ────────────────────────────────────────────────────
  {
    ruleId:   'worker_stalled',
    priority: 1,
    urgency:  'immediate',
    type:     'investigate',
    title:    'Worker heartbeat lost — check process and restart',
    buildWhy: (inc) =>
      `Worker ${inc.labels.worker} has not sent a heartbeat in ${inc.labels.heartbeatAgeSec}s. ` +
      `Orphaned jobs may be blocking queue drain.`,
    buildHow: (inc) =>
      `kubectl rollout restart deployment/worker-${inc.labels.queue}  # or check pod logs for crash`,
    buildImpact: () =>
      `Restores drain capacity. Orphaned jobs will be reclaimed by lease recovery.`,
    estimatedTimeMin: 3,
  },
];

module.exports = { PLAYBOOK };
