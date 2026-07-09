// dashboard/src/lib/api.ts
// Typed API client for the TaurusMQ Dashboard API.
//
// Auth: credentials are in an httpOnly cookie — the browser sends it automatically.
// No manual token handling needed in the frontend.
// credentials: 'include' is required to send cookies cross-origin (localhost:3333 → localhost:4000).

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const isMutating = init.method && !['GET', 'OPTIONS', 'HEAD'].includes(init.method.toUpperCase());
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (isMutating) {
    headers['X-TaurusMQ-CSRF'] = '1';
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',           // send httpOnly cookie automatically
    headers: {
      ...headers,
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    // Redirect to login — session expired or never started
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `API error ${res.status}`);
  }

  return res.json();
}

// ── Auth ───────────────────────────────────────────────────────────────────────

export interface AuthStatus {
  authenticated: boolean;
  username?: string;
  project?: string;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return apiFetch<AuthStatus>('/api/auth/me');
}

export async function login(username: string, password: string): Promise<void> {
  await apiFetch<{ ok: boolean }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function logout(): Promise<void> {
  await apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// ── Queue data ─────────────────────────────────────────────────────────────────

export interface QueueMetrics {
  name:           string;
  waiting:        number;
  active:         number;
  delayed:        number;
  failed:         number;
  completed:      number;
  throughput:     number;
  enqueueRate:    number;
  completionRate: number;
  errorRate:      number;
  retryRate:      number;
  avgLatencyMs:   number;
  p50LatencyMs:   number;
  p95LatencyMs:   number;
  p99LatencyMs:   number;
  netGrowthRate:  number;
  healthScore:    number;
  updatedAt:      number;
  isPaused?:      boolean;
  paused?:        number;
  workerCount?:   number;
}

export const getQueues = ()               => apiFetch<QueueMetrics[]>('/api/queues');
export const getQueue  = (name: string)   => apiFetch<QueueMetrics & { forecast: any; history?: any[] }>(`/api/queues/${encodeURIComponent(name)}`);
export const getQueueErrors = (name: string) => apiFetch<{ message: string; count: number }[]>(`/api/queues/${encodeURIComponent(name)}/errors`);
export const getQueueDependencies = () => apiFetch<any[]>('/api/queues/dependencies');

// ── Workers ────────────────────────────────────────────────────────────────────

export const getWorkers = () => apiFetch<any[]>('/api/workers');
export const getWorkerHeatmap = () => apiFetch<any[]>('/api/workers/heatmap');

// ── Incidents + RCA ────────────────────────────────────────────────────────────

export const getIncidents      = ()           => apiFetch<{ firing: any[]; history: any[] }>('/api/incidents');
export const getRCA            = (id: string) => apiFetch<any[]>(`/api/incidents/${id}/rca`);
export const getRecommendations = ()          => apiFetch<any[]>('/api/recommendations');

// ── Forecast + Cost ────────────────────────────────────────────────────────────

export const getForecast = () => apiFetch<any[]>('/api/forecast');
export const getCost     = () => apiFetch<any[]>('/api/cost');

// ── Events ─────────────────────────────────────────────────────────────────────

export const getEvents = (from?: number, to?: number, count = 200) => {
  const params = new URLSearchParams({
    from:  String(from  ?? Date.now() - 3_600_000),
    to:    String(to    ?? Date.now()),
    count: String(count),
  });
  return apiFetch<any[]>(`/api/events?${params}`);
};

// ── Actions ────────────────────────────────────────────────────────────────────

export const pauseRetries = (queueName: string) =>
  apiFetch<{ ok: boolean }>(`/api/queues/${encodeURIComponent(queueName)}/actions/pause-retries`, {
    method: 'POST',
  });

export const getJobs = () =>
  apiFetch<any[]>('/api/jobs');

export const getJob = (jobId: string) =>
  apiFetch<any>(`/api/jobs/${encodeURIComponent(jobId)}`);

export const getQueueJobs = (queueName: string) =>
  apiFetch<any[]>(`/api/queues/${encodeURIComponent(queueName)}/jobs`);

export const retryFailedJobs = (queueName: string) =>
  apiFetch<{ ok: boolean; retriedCount: number }>(`/api/queues/${encodeURIComponent(queueName)}/actions/retry-failed`, {
    method: 'POST',
  });

export const cleanQueue = (queueName: string) =>
  apiFetch<{ ok: boolean }>(`/api/queues/${encodeURIComponent(queueName)}/actions/clean`, {
    method: 'POST',
  });

export const retryJob = (queueName: string, jobId: string) =>
  apiFetch<{ ok: boolean }>(`/api/queues/${encodeURIComponent(queueName)}/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
  });

export const replayJob = (queueName: string, jobId: string, data?: any) =>
  apiFetch<{ ok: boolean; newJobId: string }>(`/api/queues/${encodeURIComponent(queueName)}/jobs/${encodeURIComponent(jobId)}/replay`, {
    method: 'POST',
    body: JSON.stringify({ data }),
  });

export interface AlertRule {
  id: string;
  name: string;
  queue: string;
  metric: string;
  threshold: number;
  windowMs: number;
  webhook: string;
  severity: string;
}

export const getAlertRules = () => apiFetch<AlertRule[]>('/api/alerts/rules');
export const saveAlertRule = (rule: Partial<AlertRule>) => apiFetch<{ ok: boolean; rule: AlertRule }>('/api/alerts/rules', {
  method: 'POST',
  body: JSON.stringify(rule),
});
export const deleteAlertRule = (id: string) => apiFetch<{ ok: boolean }>(`/api/alerts/rules/${encodeURIComponent(id)}`, {
  method: 'DELETE',
});

export interface SystemSettings {
  host: string;
  port: number;
  status: string;
  latency: string;
  secretKey: string;
  retentionDays: string;
  maxMemory: string;
  alertEmail: string;
}

export const getSystemSettings = () =>
  apiFetch<SystemSettings>('/api/settings');

export const saveSystemSettings = (settings: Partial<SystemSettings>) =>
  apiFetch<{ ok: boolean }>('/api/settings', {
    method: 'POST',
    body: JSON.stringify(settings),
  });

export interface QueueAnalyticsPoint {
  timestamp: string;
  processed: number;
  failed: number;
  avgLatencyMs: number;
  avgWaitMs: number;
}

export const getQueueAnalytics = (queueName: string, range: string = '24h') =>
  apiFetch<QueueAnalyticsPoint[]>(`/api/queues/${encodeURIComponent(queueName)}/analytics?range=${encodeURIComponent(range)}`);

export interface FlowJobSummary {
  id: string;
  name: string;
  queueName: string;
  state: string;
  timestamp: number;
  childrenCount: number;
}

export interface FlowNodeDetail {
  node: {
    id: string;
    name: string;
    queueName: string;
    state: string;
    attempts: number;
    maxAttempts: number;
    timestamp: number;
    data: any;
  };
  parents: Array<{ id: string; name: string; queueName: string; state: string }>;
  children: Array<{ id: string; name: string; queueName: string; state: string }>;
}

export const getFlowJobs = () => apiFetch<FlowJobSummary[]>('/api/flows');
export const getJobFlow = (jobId: string) => apiFetch<FlowNodeDetail>(`/api/flows/${encodeURIComponent(jobId)}`);

export interface GlobalAnalyticsPoint {
  t: number;
  throughput: number;
  waiting: number;
  avgLatency: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  retryRate: number;
  successRate: number;
}

export const getGlobalAnalytics = (range: string = '1h') => apiFetch<GlobalAnalyticsPoint[]>(`/api/analytics?range=${encodeURIComponent(range)}`);
