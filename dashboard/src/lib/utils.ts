import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { JobState, WorkerState, QueueHealth, AlertSeverity, AlertState } from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

export function fmtPercent(v: number, decimals = 1): string {
  return `${(v * 100).toFixed(decimals)}%`;
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function fmtTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function fmtFullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

// State → CSS class mapping
export function jobStateBadge(state: JobState): string {
  const map: Record<JobState, string> = {
    waiting:   'badge-waiting',
    active:    'badge-active',
    delayed:   'badge-delayed',
    failed:    'badge-failed',
    completed: 'badge-completed',
    paused:    'badge-paused',
  };
  return map[state] ?? 'badge-waiting';
}

export function jobStateDotColor(state: JobState): string {
  const map: Record<JobState, string> = {
    waiting:   '#64748b',
    active:    '#3b82f6',
    delayed:   '#f59e0b',
    failed:    '#ef4444',
    completed: '#10b981',
    paused:    '#f97316',
  };
  return map[state] ?? '#64748b';
}

export function workerStateBadge(state: WorkerState): string {
  const map: Record<WorkerState, string> = {
    online:  'badge-active',
    idle:    'badge-waiting',
    stalled: 'badge-failed',
    offline: 'badge-failed',
  };
  return map[state];
}

export function healthBadge(health: QueueHealth): string {
  const map: Record<QueueHealth, string> = {
    healthy:  'badge-healthy',
    degraded: 'badge-degraded',
    critical: 'badge-critical',
  };
  return map[health];
}

export function healthColor(health: QueueHealth): string {
  return health === 'healthy' ? '#10b981' : health === 'degraded' ? '#f59e0b' : '#ef4444';
}

export function healthScoreColor(score: number): string {
  if (score >= 80) return '#10b981';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

export function alertSeverityColor(s: AlertSeverity): string {
  return s === 'critical' ? '#ef4444' : s === 'warning' ? '#f59e0b' : '#3b82f6';
}

export function alertStateColor(s: AlertState): string {
  return s === 'firing' ? '#ef4444' : s === 'pending' ? '#f59e0b' : '#10b981';
}

export function eventTypeColor(type: string): string {
  if (type.includes('failed') || type.includes('disconnected')) return '#ef4444';
  if (type.includes('alert')) return '#f59e0b';
  if (type.includes('completed')) return '#10b981';
  if (type.includes('started') || type.includes('connected')) return '#3b82f6';
  if (type.includes('retried') || type.includes('delayed')) return '#f97316';
  return '#64748b';
}

export function cpuColor(cpu: number): string {
  if (cpu >= 90) return '#ef4444';
  if (cpu >= 70) return '#f59e0b';
  return '#10b981';
}

export function memColor(used: number, max: number): string {
  const pct = used / max;
  if (pct >= 0.90) return '#ef4444';
  if (pct >= 0.75) return '#f59e0b';
  return '#3b82f6';
}
