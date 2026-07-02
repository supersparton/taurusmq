'use client';
import { useState } from 'react';
import Topbar from '@/components/layout/Topbar';
import { ALERTS } from '@/lib/mockData';
import { relativeTime, alertSeverityColor, alertStateColor } from '@/lib/utils';
import { BellOff, Eye, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import type { AlertSeverity, AlertState } from '@/lib/types';
import { isFeatureEnabled } from '@/lib/features';
import FeatureLocked from '@/components/layout/FeatureLocked';

const SEV_ICON: Record<AlertSeverity, React.ReactNode> = {
  critical: <AlertTriangle size={12} />,
  warning:  <AlertCircle  size={12} />,
  info:     <Info         size={12} />,
};

const STATE_FILTERS: Array<AlertState | 'all'> = ['all', 'firing', 'pending', 'resolved'];

export default function AlertsPage() {
  const enabled = isFeatureEnabled('PHASE_3_INCIDENT_CENTER');

  const [stateFilter, setStateFilter] = useState<AlertState | 'all'>('all');
  const [sevFilter,   setSevFilter]   = useState<AlertSeverity | 'all'>('all');

  const filtered = ALERTS
    .filter(a => stateFilter === 'all' || a.state === stateFilter)
    .filter(a => sevFilter   === 'all' || a.severity === sevFilter);

  const firing   = ALERTS.filter(a => a.state === 'firing').length;
  const pending  = ALERTS.filter(a => a.state === 'pending').length;
  const resolved = ALERTS.filter(a => a.state === 'resolved').length;

  if (!enabled) {
    return (
      <>
        <Topbar title="Alert Management" subtitle="Alerts history" />
        <FeatureLocked featureName="Alert Center" phase="Phase 3" />
      </>
    );
  }

  return (
    <>
      <Topbar title="Alert Management" subtitle={`${firing} firing · ${pending} pending · ${resolved} resolved`} />
      <div className="page-content" style={{ padding: 12 }}>


        {/* Summary */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 }}>
          {[
            { label: 'Firing',   value: firing,          color: '#ef4444', state: 'firing'   as AlertState },
            { label: 'Pending',  value: pending,         color: '#f59e0b', state: 'pending'  as AlertState },
            { label: 'Resolved', value: resolved,        color: '#10b981', state: 'resolved' as AlertState },
            { label: 'Total',    value: ALERTS.length,   color: 'var(--text-secondary)', state: 'all' as const },
          ].map(s => (
            <div key={s.label} className="stat-card" style={{ cursor: 'pointer', borderLeft: stateFilter === s.state ? `2px solid ${s.color}` : '2px solid transparent' }}
              onClick={() => setStateFilter(s.state)}>
              <div className="stat-label">{s.label}</div>
              <div className="stat-value" style={{ fontSize: 26, color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>State:</span>
          {STATE_FILTERS.map(s => (
            <button key={s} className={`filter-chip ${stateFilter === s ? 'active' : ''}`}
              onClick={() => setStateFilter(s)} style={{ textTransform: 'capitalize' }}>
              {s}
            </button>
          ))}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 12 }}>Severity:</span>
          {(['all', 'critical', 'warning', 'info'] as const).map(s => (
            <button key={s} className={`filter-chip ${sevFilter === s ? 'active' : ''}`}
              onClick={() => setSevFilter(s)} style={{ textTransform: 'capitalize' }}>
              {s}
            </button>
          ))}
        </div>

        {/* Alert list — Prometheus Alertmanager pattern */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filtered.map(alert => {
            const sColor = alertSeverityColor(alert.severity);
            const stColor = alertStateColor(alert.state);
            return (
              <div key={alert.id} className="panel" style={{
                borderLeft: `3px solid ${sColor}`,
                opacity: alert.state === 'resolved' ? 0.7 : 1,
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 12, padding: '10px 14px', alignItems: 'start' }}>

                  {/* Severity icon */}
                  <div style={{ color: sColor, paddingTop: 2 }}>{SEV_ICON[alert.severity]}</div>

                  {/* Main content */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, fontFamily: 'var(--font-mono)' }}>{alert.name}</span>
                      <span style={{
                        padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                        background: `${stColor}22`, color: stColor, textTransform: 'uppercase',
                      }}>
                        {alert.state}
                      </span>
                      <span style={{
                        padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                        background: `${sColor}18`, color: sColor, textTransform: 'uppercase',
                      }}>
                        {alert.severity}
                      </span>
                      {alert.queueName && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-blue)', background: 'var(--accent-blue-dim)', padding: '1px 6px', borderRadius: 3 }}>
                          {alert.queueName}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-primary)', marginBottom: 6 }}>
                      {alert.description}
                    </div>
                    {/* Labels — Prometheus label badges */}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {Object.entries(alert.labels).map(([k, v]) => (
                        <span key={k} style={{
                          fontFamily: 'var(--font-mono)', fontSize: 10.5,
                          background: 'var(--bg-base)', border: '1px solid var(--border)',
                          padding: '1px 6px', borderRadius: 2, color: 'var(--text-muted)',
                        }}>
                          <span style={{ color: 'var(--text-dim)' }}>{k}=</span>
                          <span style={{ color: 'var(--text-secondary)' }}>&quot;{v}&quot;</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Timing + actions */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
                    <div style={{ textAlign: 'right' }}>
                      {alert.firedAt && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }} suppressHydrationWarning>
                          Fired {relativeTime(alert.firedAt)}
                        </div>
                      )}
                      {alert.resolvedAt && (
                        <div style={{ fontSize: 11, color: '#10b981' }} suppressHydrationWarning>
                          Resolved {relativeTime(alert.resolvedAt)}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {alert.state === 'firing' && (
                        <button className="btn btn-ghost" style={{ fontSize: 11 }}>
                          <BellOff size={10} /> Silence
                        </button>
                      )}
                      <button className="btn btn-ghost" style={{ fontSize: 11 }}>
                        <Eye size={10} /> View
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
              No alerts match the current filters.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
