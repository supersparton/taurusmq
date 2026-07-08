'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Layers, Search, Cpu, GitFork,
  BarChart3, Bell, Activity, AlertTriangle, ChevronDown,
  Brain, DollarSign, FileWarning, ListChecks, Lock, Settings,
} from 'lucide-react';
import { healthColor } from '@/lib/utils';
import { isFeatureEnabled } from '@/lib/features';
import { getQueues, getIncidents } from '@/lib/api';
import { useState, useEffect } from 'react';

interface NavItem {
  href: string;
  icon: any;
  label: string;
  feature: string;
  badge?: string | number;
}

const NAV: NavItem[] = [
  { href: '/',          icon: LayoutDashboard, label: 'Overview',           feature: 'PHASE_1_MVP' },
  { href: '/queues',    icon: Layers,          label: 'Queues',             feature: 'PHASE_1_MVP' },
  { href: '/jobs',      icon: Search,          label: 'Job Inspector',      feature: 'PHASE_1_MVP' },
  { href: '/workers',   icon: Cpu,             label: 'Workers',            feature: 'PHASE_1_MVP' },
  { href: '/settings',  icon: Settings,        label: 'Settings',           feature: 'PHASE_1_MVP' },
  { href: '/flow',      icon: GitFork,         label: 'Flow',               feature: 'PHASE_5_FLOW_VISUALIZATION' },
  { href: '/analytics', icon: BarChart3,       label: 'Analytics',          feature: 'PHASE_4_ANALYTICS' },
  { href: '/alerts',    icon: Bell,            label: 'Alerts',             feature: 'PHASE_3_INCIDENT_CENTER' },
  { href: '/stream',    icon: Activity,        label: 'Event Stream',       feature: 'PHASE_2_DEBUGGER' },
];

export default function Sidebar() {
  const path = usePathname();
  const isIncidentsEnabled = isFeatureEnabled('PHASE_3_INCIDENT_CENTER');
  const [firingCount, setFiringCount] = useState(0);
  const [queues, setQueues] = useState<any[]>([]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [raw, incidentsRaw] = await Promise.all([
          getQueues(),
          isIncidentsEnabled ? getIncidents().catch(() => ({ firing: [] })) : Promise.resolve({ firing: [] })
        ]);
        if (active && raw) {
          setQueues(raw.map((q: any) => ({
            name: q.name,
            health: q.healthScore >= 80 ? 'healthy' : q.healthScore >= 50 ? 'degraded' : 'critical',
            counts: {
              waiting: q.waiting || 0,
              active: q.active || 0,
            }
          })));
        } else if (active) {
          setQueues([]);
        }
        if (active && incidentsRaw) {
          setFiringCount(incidentsRaw.firing.length);
        }
      } catch (err) {
        if (active) {
          setQueues([]);
          setFiringCount(0);
        }
      }
    }
    load();
    const interval = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isIncidentsEnabled]);

  return (
    <aside style={{
      width: 220,
      flexShrink: 0,
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      overflow: 'hidden',
    }}>
      {/* Logo */}
      <div style={{
        height: 48,
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        borderBottom: '1px solid var(--border)',
        gap: 8,
        flexShrink: 0,
      }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>
          TaurusMQ
        </span>
        <span style={{
          marginLeft: 'auto',
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--accent-blue)',
          background: 'var(--accent-blue-dim)',
          padding: '1px 5px',
          borderRadius: 2,
          letterSpacing: '0.05em',
        }}>v1</span>
      </div>

      {/* Incident banner */}
      {firingCount > 0 && (
        <div style={{
          margin: '8px 8px 0',
          padding: '7px 10px',
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: 3,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <AlertTriangle size={12} color="#ef4444" />
          <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>
            {firingCount} Active Alerts
          </span>
        </div>
      )}

      {/* Nav */}
      <nav style={{ padding: '8px 6px', flex: 1, overflowY: 'auto' }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-dim)', padding: '4px 6px 6px', textTransform: 'uppercase' }}>
          Navigation
        </div>
        {NAV.map(({ href, icon: Icon, label, badge, feature }) => {
          const enabled = isFeatureEnabled(feature as any);
          if (!enabled) {
            return (
              <div key={label} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--text-dim)',
                opacity: 0.45,
                cursor: 'not-allowed',
                userSelect: 'none',
                marginBottom: 1,
              }}>
                <Icon size={14} />
                <span style={{ flex: 1 }}>{label}</span>
                <Lock size={10} style={{ color: 'var(--text-dim)' }} />
              </div>
            );
          }

          const finalBadge = label === 'Alerts' ? (firingCount > 0 ? firingCount : undefined) : badge;

          return (
            <Link key={href} href={href} className={`nav-item ${path === href ? 'active' : ''}`}
               style={{ marginBottom: 1 }}>
              <Icon size={14} />
              <span style={{ flex: 1 }}>{label}</span>
              {finalBadge && (
                <span style={{
                  background: '#ef4444',
                  color: '#fff',
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '1px 5px',
                  borderRadius: 10,
                  minWidth: 18,
                  textAlign: 'center',
                }}>{finalBadge}</span>
              )}
            </Link>
          );
        })}



        {/* Queue list */}
        <div style={{ marginTop: 16, marginBottom: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-dim)', padding: '4px 6px 6px', textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            Queues
            <ChevronDown size={11} />
          </div>
          {queues.map(q => (
            <Link key={q.name} href={`/queues/${q.name}`}
              className={`nav-item ${path === `/queues/${q.name}` ? 'active' : ''}`}
              style={{ marginBottom: 1, paddingLeft: 10 }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: healthColor(q.health),
              }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                {q.name}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                {(q.counts.waiting + q.counts.active).toLocaleString()}
              </span>
            </Link>
          ))}
        </div>
      </nav>

      {/* Bottom system info */}
      <div style={{
        padding: '10px 12px',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="live-dot" />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Redis connected</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
          127.0.0.1:6379 · v7.2.4
        </div>
      </div>
    </aside>
  );
}
