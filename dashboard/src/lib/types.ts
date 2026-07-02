// TaurusMQ — Shared types aligned with actual Redis data structures

export type JobState = 'waiting' | 'active' | 'delayed' | 'failed' | 'completed' | 'paused';
export type WorkerState = 'online' | 'idle' | 'stalled' | 'offline';
export type QueueHealth = 'healthy' | 'degraded' | 'critical';
export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertState = 'firing' | 'pending' | 'resolved';

export interface Job {
  id: string;
  name: string;
  queueName: string;
  state: JobState;
  priority: number;
  attempts: number;
  maxAttempts: number;
  progress: number;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  returnvalue: unknown;
  failedReason?: string;
  stacktrace?: string[];
  processedOn?: number;
  finishedOn?: number;
  timestamp: number; // created at
  delay?: number;
  parentId?: string;
  workerId?: string;
  duration?: number; // ms
}

export interface Queue {
  name: string;
  health: QueueHealth;
  healthScore: number; // 0-100
  isPaused: boolean;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
    paused: number;
  };
  throughput: number;    // jobs/min current
  avgLatency: number;    // ms
  p99Latency: number;    // ms
  errorRate: number;     // 0-1
  workerCount: number;
  retryRate: number;     // 0-1
}

export interface Worker {
  id: string;
  hostname: string;
  pid: number;
  queueName: string;
  state: WorkerState;
  activeJobId?: string;
  concurrency: number;
  processedJobs: number;
  failedJobs: number;
  lastHeartbeat: number;
  startedAt: number;
  cpu: number;       // 0-100
  memory: number;    // MB
  memoryMax: number; // MB
  heartbeatHistory: number[]; // last 30 ticks, 0=miss 1=ok
}

export interface FlowNode {
  id: string;
  jobId: string;
  name: string;
  state: JobState;
  duration?: number;
  startedAt?: number;
  finishedAt?: number;
  parentIds: string[];
  childIds: string[];
  isCriticalPath: boolean;
}

export interface Alert {
  id: string;
  name: string;
  severity: AlertSeverity;
  state: AlertState;
  queueName?: string;
  description: string;
  firedAt?: number;
  resolvedAt?: number;
  labels: Record<string, string>;
  silencedUntil?: number;
}

export interface MetricPoint {
  t: number;   // unix ms timestamp
  v: number;   // value
}

export interface EventStreamItem {
  id: string;
  ts: number;
  type: 'job_added' | 'job_started' | 'job_completed' | 'job_failed' | 'job_retried'
      | 'worker_connected' | 'worker_disconnected' | 'queue_paused' | 'queue_resumed' | 'alert_fired';
  queueName: string;
  jobId?: string;
  workerId?: string;
  message: string;
}
