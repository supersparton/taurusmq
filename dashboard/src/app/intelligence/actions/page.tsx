'use client';
import Topbar from '@/components/layout/Topbar';
import { RECOMMENDED_ACTIONS } from '@/lib/intelligence';
import { Terminal, Zap, Shield, Settings, Pause } from 'lucide-react';
import { isFeatureEnabled } from '@/lib/features';
import FeatureLocked from '@/components/layout/FeatureLocked';

const TYPE_ICON: Record<string, React.ReactNode> = {
  scale: <Zap size={13} />, fix: <Shield size={13} />, pause: <Pause size={13} />,
  investigate: <Terminal size={13} />, configure: <Settings size={13} />,
};
const TYPE_COLOR: Record<string, string> = {
  scale: '#3b82f6', fix: '#10b981', pause: '#f59e0b', investigate: '#8b5cf6', configure: '#06b6d4',
};
const URGENCY_LABEL: Record<string, string> = {
  immediate: 'DO NOW', within_15m: '< 15 min', within_1h: '< 1 hour', planned: 'Planned',
};
const URGENCY_COLOR: Record<string, string> = {
  immediate: '#ef4444', within_15m: '#f97316', within_1h: '#f59e0b', planned: '#64748b',
};

export default function ActionsPage() {
  const enabled = isFeatureEnabled('PHASE_3_INCIDENT_CENTER');

  const groups = [
    { label: 'Immediate', key: 'immediate',   color: '#ef4444' },
    { label: 'Within 15m', key: 'within_15m', color: '#f97316' },
    { label: 'Within 1h',  key: 'within_1h',  color: '#f59e0b' },
    { label: 'Planned',    key: 'planned',    color: '#64748b' },
  ] as const;

  if (!enabled) {
    return (
      <>
        <Topbar title="Triage Playbook" subtitle="Recommended actions" />
        <FeatureLocked featureName="Triage Playbook" phase="Phase 3" />
      </>
    );
  }

  return (
    <>
      <Topbar title="Triage Playbook" subtitle="Ranked actions to resolve current incident — execute in order" />
      <div className="page-content" style={{ padding: 12 }}>


        {/* Header warning */}
        <div style={{
          padding: '10px 14px', marginBottom: 10,
          background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 4,
          fontSize: 12.5, color: 'var(--text-secondary)',
        }}>
          <span style={{ color: '#ef4444', fontWeight: 700 }}>Active Incident: </span>
          Execute actions in priority order. Do not jump ahead — pausing retries (P1) must precede scaling workers (P2)
          to avoid worsening the retry storm.
        </div>

        {groups.map(g => {
          const acts = RECOMMENDED_ACTIONS.filter(a => a.urgency === g.key);
          if (!acts.length) return null;
          return (
            <div key={g.key} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: g.color }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: g.color, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {g.label}
                </span>
                <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{acts.length} action{acts.length !== 1 ? 's' : ''}</span>
              </div>
              {acts.map(act => {
                const tc = TYPE_COLOR[act.type];
                return (
                  <div key={act.id} className="panel" style={{ marginBottom: 6, borderLeft: `3px solid ${g.color}` }}>
                    <div style={{ padding: '12px 14px' }}>
                      {/* Row 1: priority + title + type + queue */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <div className={`action-priority priority-${act.priority}`}>{act.priority}</div>
                        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
                          {act.title}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
                          color: tc, background: `${tc}18`, padding: '2px 8px', borderRadius: 3, fontWeight: 600 }}>
                          {TYPE_ICON[act.type]} {act.type}
                        </span>
                        {act.queue && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-blue)',
                            background: 'var(--accent-blue-dim)', padding: '2px 7px', borderRadius: 3 }}>
                            {act.queue}
                          </span>
                        )}
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>~{act.estimatedTimeMin}m</span>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                        {/* Why */}
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)', marginBottom: 5 }}>
                            Why
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{act.why}</div>
                        </div>
                        {/* How */}
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)', marginBottom: 5 }}>
                            Command / Steps
                          </div>
                          <div style={{
                            fontFamily: 'var(--font-mono)', fontSize: 11.5,
                            padding: '7px 10px', background: '#07090d',
                            border: '1px solid var(--border)', borderRadius: 3,
                            color: 'var(--accent-cyan)', lineHeight: 1.6,
                          }}>
                            {act.how}
                          </div>
                        </div>
                        {/* Impact */}
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)', marginBottom: 5 }}>
                            Expected Impact
                          </div>
                          <div style={{ fontSize: 12, color: '#10b981', lineHeight: 1.5 }}>↑ {act.estimatedImpact}</div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
                        <button className="btn btn-primary" style={{ fontSize: 11 }}>
                          Mark as Done
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 11 }}>
                          Assign to Me
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 11 }}>
                          Snooze 15m
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}
