// TaurusMQ — Operational Intelligence Mock Data
// Every data point drives a decision, not a chart

import type { Queue, Worker } from './types';

const NOW = Date.now();
const mins = (n: number) => n * 60 * 1000;
const hrs  = (n: number) => n * 60 * 60 * 1000;

// ─── Risk Prediction ─────────────────────────────────────────────────────────
// Answers: "Which queue is about to fail, and when?"
export interface QueueRisk {
  queueName: string;
  riskScore: number;        // 0-100
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  timeToFailureMs?: number; // estimated ms until SLA breach or queue overflow
  failureMode: string;      // human-readable diagnosis
  trend: 'improving' | 'stable' | 'degrading' | 'critical';
  signals: string[];        // what triggered this risk score
}

export const QUEUE_RISKS: QueueRisk[] = [
  {
    queueName: 'image-processing',
    riskScore: 94,
    riskLevel: 'critical',
    timeToFailureMs: mins(8),
    failureMode: 'OOM cascade — workers consuming 93% memory, 3.8k backlog growing at 180/min with 0 drain capacity',
    trend: 'critical',
    signals: [
      'Worker memory >90% on 2/2 workers',
      'Failure rate 41% (threshold: 10%)',
      'Queue depth +3,847 and growing',
      'wkr_img_01 heartbeat lost 3m ago',
      'No completed jobs in last 8 minutes',
    ],
  },
  {
    queueName: 'report-generation',
    riskScore: 61,
    riskLevel: 'high',
    timeToFailureMs: mins(34),
    failureMode: 'Memory leak suspected — P99 latency 31s (SLA: 10s), current job at 8m+ runtime',
    trend: 'degrading',
    signals: [
      'P99 latency 31s vs 10s SLA',
      'Active job exceeded avg duration by 3x',
      'Attempt 2/3 — one retry remaining',
      'Worker CPU 61% and climbing',
    ],
  },
  {
    queueName: 'pdf-export',
    riskScore: 55,
    riskLevel: 'high',
    timeToFailureMs: undefined,
    failureMode: 'Queue paused with 29 failed jobs — stale DLQ accumulation, no active drain strategy',
    trend: 'stable',
    signals: [
      'Queue paused — no workers active',
      '29 failed jobs in DLQ',
      '56 paused jobs unprocessed',
      'Error rate 19% pre-pause',
    ],
  },
  {
    queueName: 'data-sync',
    riskScore: 28,
    riskLevel: 'medium',
    timeToFailureMs: mins(15),
    failureMode: 'Salesforce rate-limited — retry in 15 min, 340 delayed jobs will spike queue on resume',
    trend: 'stable',
    signals: [
      'External API rate limit active',
      '340 delayed jobs scheduled simultaneously',
      'Spike risk on retry window open',
    ],
  },
  {
    queueName: 'email-notifications',
    riskScore: 8,
    riskLevel: 'low',
    timeToFailureMs: undefined,
    failureMode: 'Healthy — all SLAs met',
    trend: 'stable',
    signals: [],
  },
  {
    queueName: 'webhook-dispatch',
    riskScore: 12,
    riskLevel: 'low',
    timeToFailureMs: undefined,
    failureMode: 'Healthy — throughput nominal',
    trend: 'stable',
    signals: [],
  },
];

// ─── Bottleneck Detection ─────────────────────────────────────────────────────
// Answers: "Where is the system constrained right now?"
export interface Bottleneck {
  id: string;
  type: 'worker_memory' | 'worker_cpu' | 'queue_depth' | 'external_api' | 'no_workers' | 'retry_storm';
  severity: 'critical' | 'high' | 'medium';
  location: string;         // queue or worker name
  description: string;
  impact: string;           // what it's blocking
  constraintValue: string;  // current value
  limitValue: string;       // the limit being hit
  actionLabel: string;
  action: string;
}

export const BOTTLENECKS: Bottleneck[] = [
  {
    id: 'bn_001',
    type: 'worker_memory',
    severity: 'critical',
    location: 'image-processing',
    description: 'Worker container memory at 93% limit',
    impact: 'OOM kills causing job failures, 3.8k job backlog with no drain capacity',
    constraintValue: '477MB / 512MB',
    limitValue: '512MB container limit',
    actionLabel: 'Scale up worker memory to 2GB',
    action: 'scale_worker_memory',
  },
  {
    id: 'bn_002',
    type: 'retry_storm',
    severity: 'critical',
    location: 'image-processing',
    description: 'Retry storm — 891 failed jobs attempting re-execution against memory-constrained workers',
    impact: 'Each retry OOM-kills immediately, consuming worker slots and worsening backlog',
    constraintValue: '891 failed jobs',
    limitValue: '3 attempts max',
    actionLabel: 'Pause retries — fix workers first',
    action: 'pause_retries',
  },
  {
    id: 'bn_003',
    type: 'external_api',
    severity: 'medium',
    location: 'data-sync',
    description: 'Salesforce API rate limit — 150/150 calls consumed',
    impact: '340 delayed jobs queued, spike risk in 15 min',
    constraintValue: '150 calls used',
    limitValue: '150 calls/hour Salesforce limit',
    actionLabel: 'Implement exponential backoff + jitter',
    action: 'add_jitter',
  },
];

// ─── Root Cause Analysis ─────────────────────────────────────────────────────
// Answers: "Why did this happen? What should I do first?"
export interface RCAItem {
  id: string;
  hypothesis: string;       // "The most likely cause is..."
  confidence: number;       // 0-100
  evidence: string[];
  immediateAction: string;
  immediateActionDetail: string;
  preventionAction: string;
  estimatedResolutionMins: number;
  affectedJobs: number;
}

export const RCA_ITEMS: RCAItem[] = [
  {
    id: 'rca_001',
    hypothesis: 'Large TIFF file (48MB) exceeded Sharp worker memory budget at resize step',
    confidence: 92,
    evidence: [
      'All 891 failures share error: ENOMEM at SharpProcessor.resize()',
      'Failed files average 42MB vs 8MB for successful jobs',
      'OOM pattern started exactly when 4K TIFF batch was enqueued (47m ago)',
      'Worker memory climbed from 180MB → 477MB over 40 minutes',
      'No failures on jobs with sizeBytes < 10MB in same window',
    ],
    immediateAction: 'Add file size gate before image queue admission',
    immediateActionDetail: 'Reject files > 20MB at upload time, route to high-memory worker pool. ETA: 10 min to implement.',
    preventionAction: 'Implement per-job memory limits with pre-flight size check',
    estimatedResolutionMins: 15,
    affectedJobs: 891,
  },
  {
    id: 'rca_002',
    hypothesis: 'No memory limits on Sharp subprocess — single large job consumes entire container',
    confidence: 78,
    evidence: [
      'Container memory limit: 512MB, Sharp has no internal memory cap',
      'Node child_process.spawn() inherits parent memory space',
      'wkr_img_01 allocated full 489MB before stalling',
      'Kubernetes OOM killer never triggered — process crashed first',
    ],
    immediateAction: 'Set --max-old-space-size=256 on Sharp subprocess',
    immediateActionDetail: 'Fork Sharp into isolated child process with NODE_OPTIONS=--max-old-space-size=256',
    preventionAction: 'Add ulimit to Docker entrypoint, add memory circuit breaker',
    estimatedResolutionMins: 30,
    affectedJobs: 891,
  },
];

// ─── Incident Timeline ────────────────────────────────────────────────────────
export interface IncidentEvent {
  ts: number;
  type: 'trigger' | 'escalation' | 'detection' | 'impact' | 'alert';
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
}

export const INCIDENT_TIMELINE: IncidentEvent[] = [
  { ts: NOW - mins(47), type: 'trigger',     severity: 'warning',  title: '4K TIFF batch enqueued',        detail: '23 files averaging 42MB each pushed to image-processing queue' },
  { ts: NOW - mins(44), type: 'impact',      severity: 'warning',  title: 'Worker memory climb begins',    detail: 'wkr_img_01 memory: 180MB → 290MB. First OOM error logged.' },
  { ts: NOW - mins(38), type: 'escalation',  severity: 'critical', title: 'Queue depth spike',             detail: 'Waiting jobs: 120 → 1,400. Workers failing faster than draining.' },
  { ts: NOW - mins(35), type: 'alert',       severity: 'critical', title: 'QueueDepthCritical fires',      detail: 'Alert: waiting jobs exceeded 3000 threshold.' },
  { ts: NOW - mins(31), type: 'impact',      severity: 'critical', title: 'First total job failure',       detail: 'job_7d4e2a1b9c80 (resize-thumbnail) exhausted all 3 retry attempts.' },
  { ts: NOW - mins(22), type: 'escalation',  severity: 'critical', title: 'Retry storm begins',            detail: '891 jobs cycling through retries against OOM-constrained workers.' },
  { ts: NOW - mins(15), type: 'alert',       severity: 'critical', title: 'WorkerMemoryPressure fires',    detail: 'wkr_img_02 at 93% (477MB/512MB).' },
  { ts: NOW - mins(3),  type: 'detection',   severity: 'critical', title: 'wkr_img_01 heartbeat lost',     detail: 'Worker presumed dead. Jobs orphaned. Lease recovery triggered.' },
  { ts: NOW - mins(2),  type: 'alert',       severity: 'critical', title: 'WorkerStalledHeartbeat fires',  detail: 'Last heartbeat 3m ago. 0 of 2 workers healthy.' },
];

// ─── Capacity Forecasting ─────────────────────────────────────────────────────
export interface CapacityForecast {
  queueName: string;
  currentDepth: number;
  drainRate: number;       // jobs/min being completed
  ingestRate: number;      // jobs/min being added
  netGrowthRate: number;   // positive = growing
  projectedDepth1h: number;
  overflowWarningAt: number; // depth at which SLA breaks
  timeToOverflowMs?: number;
  recommendation: string;
  workersSuggestedToAdd: number;
}

export const CAPACITY_FORECASTS: CapacityForecast[] = [
  {
    queueName: 'image-processing',
    currentDepth: 3847,
    drainRate: 18,
    ingestRate: 198,
    netGrowthRate: 180,
    projectedDepth1h: 14647,
    overflowWarningAt: 5000,
    timeToOverflowMs: mins(6.4),
    recommendation: 'Queue will overflow SLA threshold in ~6 minutes. Stop ingest OR add 12 healthy workers immediately.',
    workersSuggestedToAdd: 12,
  },
  {
    queueName: 'data-sync',
    currentDepth: 340,
    drainRate: 0,
    ingestRate: 0,
    netGrowthRate: 0,
    projectedDepth1h: 340,
    overflowWarningAt: 2000,
    timeToOverflowMs: undefined,
    recommendation: 'Rate limit window clears in 15 min. 340 jobs will attempt simultaneously — add 3 workers before window opens.',
    workersSuggestedToAdd: 3,
  },
  {
    queueName: 'report-generation',
    currentDepth: 124,
    drainRate: 24,
    ingestRate: 18,
    netGrowthRate: -6,
    projectedDepth1h: 88,
    overflowWarningAt: 500,
    timeToOverflowMs: undefined,
    recommendation: 'Draining slowly. Monitor P99 latency — current job may timeout.',
    workersSuggestedToAdd: 0,
  },
  {
    queueName: 'email-notifications',
    currentDepth: 47,
    drainRate: 342,
    ingestRate: 310,
    netGrowthRate: -32,
    projectedDepth1h: 0,
    overflowWarningAt: 2000,
    timeToOverflowMs: undefined,
    recommendation: 'Healthy. No action needed.',
    workersSuggestedToAdd: 0,
  },
  {
    queueName: 'webhook-dispatch',
    currentDepth: 12,
    drainRate: 580,
    ingestRate: 540,
    netGrowthRate: -40,
    projectedDepth1h: 0,
    overflowWarningAt: 5000,
    timeToOverflowMs: undefined,
    recommendation: 'Healthy. No action needed.',
    workersSuggestedToAdd: 0,
  },
];

// ─── Worker Utilization Heatmap ───────────────────────────────────────────────
// 24 hours × workers — what was each worker doing each hour?
export interface HeatmapCell {
  hour: number;    // 0-23
  workerId: string;
  utilization: number; // 0-100
  jobsProcessed: number;
  failures: number;
}

export const HEATMAP_DATA: HeatmapCell[] = (() => {
  const workers = ['wkr_email_01','wkr_email_02','wkr_img_01','wkr_img_02','wkr_report_01','wkr_webhook_01'];
  const cells: HeatmapCell[] = [];
  workers.forEach(wid => {
    for (let h = 0; h < 24; h++) {
      const isImgWorker = wid.includes('img');
      const isIncidentHour = h >= 21; // 3 AM incident
      let util = Math.random() * 40 + 20;
      let failures = 0;
      if (isImgWorker && isIncidentHour) { util = 88 + Math.random() * 12; failures = Math.floor(Math.random() * 80 + 40); }
      else if (isImgWorker) { util = 50 + Math.random() * 30; failures = Math.floor(Math.random() * 10); }
      else { util = 10 + Math.random() * 35; failures = Math.floor(Math.random() * 3); }
      cells.push({ hour: h, workerId: wid, utilization: Math.min(100, util), jobsProcessed: Math.floor(util * 8), failures });
    }
  });
  return cells;
})();



// ─── Queue Dependency Map ─────────────────────────────────────────────────────
export interface QueueDep {
  from: string;  // upstream queue (must complete first)
  to: string;    // downstream queue (triggered by)
  label: string;
  isCritical: boolean;
}

export const QUEUE_DEPS: QueueDep[] = [
  { from: 'data-sync',         to: 'report-generation', label: 'triggers report on sync',   isCritical: true  },
  { from: 'image-processing',  to: 'email-notifications', label: 'sends completion email',  isCritical: false },
  { from: 'report-generation', to: 'pdf-export',          label: 'exports report as PDF',   isCritical: true  },
  { from: 'pdf-export',        to: 'email-notifications', label: 'sends PDF to user',       isCritical: true  },
  { from: 'webhook-dispatch',  to: 'data-sync',           label: 'webhook triggers sync',   isCritical: false },
];

// ─── Recommended Actions (Triage Playbook) ────────────────────────────────────
export interface RecommendedAction {
  id: string;
  priority: number; // 1 = do this NOW
  urgency: 'immediate' | 'within_15m' | 'within_1h' | 'planned';
  title: string;
  why: string;
  how: string;
  estimatedImpact: string;
  estimatedTimeMin: number;
  queue?: string;
  worker?: string;
  type: 'scale' | 'fix' | 'pause' | 'investigate' | 'configure';
}

export const RECOMMENDED_ACTIONS: RecommendedAction[] = [
  {
    id: 'act_001',
    priority: 1,
    urgency: 'immediate',
    title: 'Pause image-processing retries',
    why: 'Retry storm consuming all worker capacity. Each retry OOM-kills immediately, blocking queue drain.',
    how: 'Run: taurusmq queue pause-retries image-processing --state failed',
    estimatedImpact: 'Stops failure amplification. Prevents further DLQ growth.',
    estimatedTimeMin: 1,
    queue: 'image-processing',
    type: 'pause',
  },
  {
    id: 'act_002',
    priority: 2,
    urgency: 'immediate',
    title: 'Scale image-processing worker memory to 2GB',
    why: 'Workers at 93% memory limit (477MB/512MB). Root cause of all 891 failures.',
    how: 'Update deployment: resources.limits.memory: 2Gi on worker-image pods. Rolling restart.',
    estimatedImpact: 'Stops OOM failures. Enables drain of 3.8k waiting jobs.',
    estimatedTimeMin: 5,
    queue: 'image-processing',
    type: 'scale',
  },
  {
    id: 'act_003',
    priority: 3,
    urgency: 'immediate',
    title: 'Add file-size gate: reject files > 20MB at upload',
    why: '100% of failures are files > 20MB. Current workers cannot process 4K TIFF files.',
    how: 'Add Zod validation in Queue.add(): if data.sizeBytes > 20_000_000 throw QueueAdmissionError',
    estimatedImpact: 'Prevents recurrence. Reduces failure rate to near 0.',
    estimatedTimeMin: 10,
    type: 'configure',
  },
  {
    id: 'act_004',
    priority: 4,
    urgency: 'within_15m',
    title: 'Pre-provision data-sync workers before rate limit expires',
    why: '340 delayed data-sync jobs will simultaneously resume in ~15 minutes, causing a spike.',
    how: 'kubectl scale deployment worker-data-sync --replicas=5 before 22:56 UTC',
    estimatedImpact: 'Prevents data-sync queue spike from becoming the next incident.',
    estimatedTimeMin: 3,
    queue: 'data-sync',
    type: 'scale',
  },
  {
    id: 'act_005',
    priority: 5,
    urgency: 'within_1h',
    title: 'Drain or discard pdf-export DLQ (29 failed jobs)',
    why: 'Queue paused with 29 unresolved failures. Upstream report-generation depends on pdf-export.',
    how: 'taurusmq queue clean pdf-export --state failed OR retry after queue resume',
    estimatedImpact: 'Unblocks downstream stakeholder notifications.',
    estimatedTimeMin: 5,
    queue: 'pdf-export',
    type: 'fix',
  },
];
