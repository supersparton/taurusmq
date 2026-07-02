// packages/incident-engine/rules.js
// All incident detection rules. Each rule is a pure predicate on live metrics.
// The IncidentEngine evaluates this list every 15 seconds.
//
// Rule interface:
// {
//   id:          string,                 // unique, stable across restarts
//   name:        string,                 // human label
//   severity:    'critical'|'high'|'medium'|'low',
//   scope:       'queue'|'worker'|'global',
//   evaluate:    async (context) => { triggered: boolean, evidence: string[], labels: Record<string,string> }
// }
//
// context for scope='queue':
//   { queueName, metrics }   — metrics = hgetall of tmq:obs:materialized:{queue}
//
// context for scope='worker':
//   { workerId, workerState, workerRes }

'use strict';

const RULES = [

  // ── Queue rules ──────────────────────────────────────────────────────

  {
    id:       'high_failure_rate',
    name:     'HighFailureRate',
    severity: 'critical',
    scope:    'queue',
    async evaluate({ queueName, metrics: m }) {
      const errorRate = parseFloat(m.errorRate ?? '0');
      const failed    = parseInt(m.failed    ?? '0', 10);
      if (errorRate < 0.10 || failed < 5) return { triggered: false };

      return {
        triggered: true,
        labels:    { queue: queueName, threshold: '10%', actual: `${(errorRate*100).toFixed(1)}%` },
        evidence:  [
          `Error rate ${(errorRate*100).toFixed(1)}% exceeds 10% threshold`,
          `${failed} failed jobs total`,
          `${parseInt(m.retries ?? '0', 10)} retries recorded`,
        ],
      };
    },
  },

  {
    id:       'queue_backlog',
    name:     'QueueBacklog',
    severity: 'high',
    scope:    'queue',
    async evaluate({ queueName, metrics: m }) {
      const waiting       = parseInt(m.waiting      ?? '0', 10);
      const netGrowthRate = parseFloat(m.netGrowthRate ?? '0');
      if (waiting < 500 || netGrowthRate <= 0) return { triggered: false };

      return {
        triggered: true,
        labels:    { queue: queueName, depth: String(waiting), growthRate: `${netGrowthRate.toFixed(1)}/min` },
        evidence:  [
          `Queue depth ${waiting} and growing at ${netGrowthRate.toFixed(1)} jobs/min`,
          `Completion rate ${parseFloat(m.completionRate ?? '0').toFixed(1)}/min < enqueue rate ${parseFloat(m.enqueueRate ?? '0').toFixed(1)}/min`,
        ],
      };
    },
  },

  {
    id:       'high_p99_latency',
    name:     'HighP99Latency',
    severity: 'high',
    scope:    'queue',
    async evaluate({ queueName, metrics: m }) {
      const p99  = parseInt(m.p99LatencyMs ?? '0', 10);
      const SLA  = 10_000; // 10 seconds default SLA
      if (p99 < SLA) return { triggered: false };

      return {
        triggered: true,
        labels:    { queue: queueName, p99Ms: String(p99), slMs: String(SLA) },
        evidence:  [
          `P99 latency ${(p99/1000).toFixed(1)}s exceeds SLA of ${SLA/1000}s`,
          `P95 latency ${(parseInt(m.p95LatencyMs ?? '0', 10)/1000).toFixed(1)}s`,
          `Average latency ${(parseInt(m.avgLatencyMs ?? '0', 10)/1000).toFixed(1)}s`,
        ],
      };
    },
  },

  {
    id:       'queue_no_drain',
    name:     'QueueNoDrain',
    severity: 'critical',
    scope:    'queue',
    async evaluate({ queueName, metrics: m }) {
      const completionRate = parseFloat(m.completionRate ?? '0');
      const waiting        = parseInt(m.waiting          ?? '0', 10);
      // No completions + significant backlog = stuck queue
      if (completionRate > 0 || waiting < 100) return { triggered: false };

      return {
        triggered: true,
        labels:    { queue: queueName, waiting: String(waiting) },
        evidence:  [
          `Zero jobs completed in last aggregation window`,
          `${waiting} jobs stuck in waiting state`,
          `Active count: ${m.active ?? '0'}`,
        ],
      };
    },
  },

  // ── Worker rules ──────────────────────────────────────────────────────

  {
    id:       'worker_memory_pressure',
    name:     'WorkerMemoryPressure',
    severity: 'critical',
    scope:    'worker',
    async evaluate({ workerId, workerState, workerRes }) {
      const heapUsed  = parseInt(workerRes.heapUsed  ?? '0', 10);
      const heapTotal = parseInt(workerRes.heapTotal ?? '1', 10);
      const memBytes  = parseInt(workerRes.memoryBytes ?? '0', 10);
      if (heapTotal === 0) return { triggered: false };

      const heapPct = heapUsed / heapTotal;
      if (heapPct < 0.85) return { triggered: false };

      return {
        triggered: true,
        labels:    { worker: workerId, queue: workerState.queue ?? '', heapPct: `${(heapPct*100).toFixed(0)}%` },
        evidence:  [
          `Heap usage ${(heapPct*100).toFixed(1)}% (${Math.round(heapUsed/1024/1024)}MB / ${Math.round(heapTotal/1024/1024)}MB)`,
          `RSS memory: ${Math.round(memBytes/1024/1024)}MB`,
        ],
      };
    },
  },

  {
    id:       'worker_stalled',
    name:     'WorkerStalled',
    severity: 'critical',
    scope:    'worker',
    async evaluate({ workerId, workerState, lastHbMs }) {
      const STALL_THRESHOLD_MS = 60_000; // 60s without heartbeat = stalled
      const ageMs = Date.now() - (lastHbMs ?? 0);
      if (ageMs < STALL_THRESHOLD_MS) return { triggered: false };

      return {
        triggered: true,
        labels:    { worker: workerId, queue: workerState.queue ?? '', heartbeatAgeSec: String(Math.round(ageMs/1000)) },
        evidence:  [
          `Last heartbeat ${Math.round(ageMs/1000)}s ago (threshold: 60s)`,
          `Worker state: ${workerState.state ?? 'unknown'}`,
          `Active jobs at last heartbeat: ${workerState.activeJobs ?? '[]'}`,
        ],
      };
    },
  },

  {
    id:       'worker_high_cpu',
    name:     'WorkerHighCPU',
    severity: 'medium',
    scope:    'worker',
    async evaluate({ workerId, workerState, workerRes }) {
      const cpuPct = parseFloat(workerRes.cpuPercent ?? '0');
      if (cpuPct < 85) return { triggered: false };

      return {
        triggered: true,
        labels:    { worker: workerId, cpu: `${cpuPct}%` },
        evidence:  [
          `CPU at ${cpuPct}% (threshold: 85%)`,
        ],
      };
    },
  },
];

module.exports = { RULES };
