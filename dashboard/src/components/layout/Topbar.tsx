'use client';
import { RefreshCw, Clock, Settings, ChevronDown } from 'lucide-react';

const TIME_RANGES = ['Last 15m', 'Last 1h', 'Last 6h', 'Last 24h', 'Last 7d'];

export default function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
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

      {/* Time range selector — Grafana pattern */}
      <button style={{
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 3, padding: '4px 10px', color: 'var(--text-secondary)',
        fontSize: 12, cursor: 'pointer',
      }}>
        <Clock size={12} />
        Last 1h
        <ChevronDown size={11} />
      </button>

      {/* Auto-refresh indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button style={{
          display: 'flex', alignItems: 'center', gap: 5,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 3, padding: '4px 10px', color: 'var(--text-secondary)',
          fontSize: 12, cursor: 'pointer',
        }}>
          <RefreshCw size={11} />
          5s
        </button>
      </div>

      {/* Live badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5,
        background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)',
        borderRadius: 3, padding: '3px 8px',
      }}>
        <span className="live-dot" style={{ width: 6, height: 6 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-green)' }}>LIVE</span>
      </div>

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
