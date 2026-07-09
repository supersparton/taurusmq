'use client';
import { RefreshCw, Clock, Settings, ChevronDown } from 'lucide-react';

export default function Topbar({
  title,
  subtitle,
  timeRange = 'Last 1h',
  onTimeRangeChange,
  refreshInterval = '5s',
  onRefreshIntervalChange,
}: {
  title: string;
  subtitle?: string;
  timeRange?: string;
  onTimeRangeChange?: (range: string) => void;
  refreshInterval?: string;
  onRefreshIntervalChange?: (interval: string) => void;
}) {
  return (
    <header style={{
      height: 48,
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      gap: 12,
      background: 'var(--bg-surface)',
      flexShrink: 0,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h1 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1 }}>
            {title}
          </h1>
          {subtitle && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{subtitle}</span>
          )}
        </div>
      </div>

      {/* Time range selector — Grafana style native select */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <Clock size={12} style={{ position: 'absolute', left: 10, pointerEvents: 'none', color: 'var(--text-secondary)' }} />
        <select
          value={timeRange}
          onChange={(e) => onTimeRangeChange?.(e.target.value)}
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            padding: '4px 24px 4px 28px',
            color: 'var(--text-secondary)',
            fontSize: 12,
            cursor: 'pointer',
            appearance: 'none',
            outline: 'none',
          }}
        >
          <option value="Last 1h">Last 1h</option>
          <option value="Last 24h">Last 24h</option>
          <option value="Last 7d">Last 7d</option>
        </select>
        <ChevronDown size={11} style={{ position: 'absolute', right: 8, pointerEvents: 'none', color: 'var(--text-secondary)' }} />
      </div>

      {/* Auto-refresh selector — Native select */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <RefreshCw size={11} style={{ position: 'absolute', left: 10, pointerEvents: 'none', color: 'var(--text-secondary)' }} />
        <select
          value={refreshInterval}
          onChange={(e) => onRefreshIntervalChange?.(e.target.value)}
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            padding: '4px 22px 4px 24px',
            color: 'var(--text-secondary)',
            fontSize: 12,
            cursor: 'pointer',
            appearance: 'none',
            outline: 'none',
          }}
        >
          <option value="5s">5s</option>
          <option value="15s">15s</option>
          <option value="30s">30s</option>
          <option value="Off">Off</option>
        </select>
        <ChevronDown size={11} style={{ position: 'absolute', right: 6, pointerEvents: 'none', color: 'var(--text-secondary)' }} />
      </div>

      {/* Live badge */}
      {refreshInterval !== 'Off' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)',
          borderRadius: 3, padding: '3px 8px',
        }}>
          <span className="live-dot" style={{ width: 6, height: 6 }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-green)' }}>LIVE</span>
        </div>
      )}

      <button style={{
        background: 'transparent', border: 'none',
        color: 'var(--text-muted)', cursor: 'pointer',
        display: 'flex', alignItems: 'center',
      }}>
        <Settings size={14} />
      </button>
    </header>
  );
}
