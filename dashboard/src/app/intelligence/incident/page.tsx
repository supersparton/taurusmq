'use client';
import Topbar from '@/components/layout/Topbar';
import { RCA_ITEMS, INCIDENT_TIMELINE, BOTTLENECKS, RECOMMENDED_ACTIONS } from '@/lib/intelligence';
import { relativeTime } from '@/lib/utils';
import { AlertTriangle, Clock, ChevronRight } from 'lucide-react';
import { isFeatureEnabled } from '@/lib/features';
import FeatureLocked from '@/components/layout/FeatureLocked';

function ConfidenceBar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div className="confidence-bar" style={{ flex: 1 }}>
        <div className="confidence-fill" style={{ width: `${value}%`, background: color }} />
      </div>
      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color, width: 36, textAlign: 'right' }}>
        {value}%
      </span>
    </div>
  );
}

const EV_COLOR: Record<string, string> = {
  trigger: '#64748b', detection: '#3b82f6', escalation: '#ef4444', impact: '#f97316', alert: '#f59e0b',
};

export default function IncidentAnalysisPage() {
  const enabled = isFeatureEnabled('PHASE_3_INCIDENT_CENTER');

  if (!enabled) {
    return (
      <>
        <Topbar title="Incident Analysis" subtitle="Root cause & RCA timeline" />
        <FeatureLocked featureName="Incident Analysis" phase="Phase 3" />
      </>
    );
  }

  return (
    <>
      <Topbar title="Incident Analysis" subtitle="image-processing · OOM Cascade · Started 47m ago" />
      <div className="page-content" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>


        {/* Incident summary header */}
        <div className="panel" style={{ borderLeft: '3px solid #ef4444', padding: '14px 16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'start' }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#ef4444', marginBottom: 6 }}>
                OOM Cascade — image-processing queue
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: 700 }}>
                A batch of 23 large TIFF files (avg 42MB) was enqueued 47 minutes ago. Workers running Sharp image
                processing consumed all available container memory (512MB), causing ENOMEM crashes on every retry.
                With both workers degraded and 891 failed jobs recycling through retries, the queue is growing
                at 180 jobs/min with 0 drain capacity.
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, flexShrink: 0 }}>
              {[
                { label: 'Jobs Affected', value: '3,847', color: '#ef4444' },
                { label: 'Failed Jobs',   value: '891',   color: '#ef4444' },
                { label: 'Workers Down',  value: '2/2',   color: '#f97316' },
                { label: 'Active Alerts', value: '3',     color: '#f59e0b' },
              ].map(s => (
                <div key={s.label} style={{ background: 'var(--bg-base)', borderRadius: 3, padding: '8px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-mono)', color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>

          {/* Root Cause Analysis */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">Root Cause Analysis</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Ranked by confidence</span>
              </div>
              {RCA_ITEMS.map((rca, idx) => (
                <div key={rca.id} style={{ padding: '14px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{
                        width: 20, height: 20, borderRadius: '50%',
                        background: idx === 0 ? '#ef4444' : '#374151',
                        color: '#fff', fontSize: 10, fontWeight: 800,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}>{idx + 1}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                        {idx === 0 ? 'Most Likely Root Cause' : 'Contributing Factor'}
                      </span>
                    </div>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{rca.affectedJobs.toLocaleString()} jobs</span>
                  </div>

                  {/* Hypothesis */}
                  <div style={{
                    fontSize: 12.5, color: 'var(--text-primary)', fontStyle: 'italic',
                    marginBottom: 8, padding: '6px 10px',
                    background: 'var(--bg-base)', borderRadius: 3,
                    borderLeft: '2px solid var(--accent-red)', lineHeight: 1.5,
                  }}>
                    &ldquo;{rca.hypothesis}&rdquo;
                  </div>

                  {/* Confidence */}
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Confidence</div>
                    <ConfidenceBar value={rca.confidence} color={rca.confidence >= 85 ? '#ef4444' : '#f59e0b'} />
                  </div>

                  {/* Evidence chain */}
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Evidence</div>
                    {rca.evidence.map((ev, i) => (
                      <div key={i} className="evidence-item">
                        <span className="evidence-dot" />
                        <span>{ev}</span>
                      </div>
                    ))}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div style={{ padding: '8px 10px', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 3 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                        Immediate Fix — {rca.estimatedResolutionMins}m
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 3 }}>
                        {rca.immediateAction}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                        {rca.immediateActionDetail}
                      </div>
                    </div>
                    <div style={{ padding: '8px 10px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 3 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                        Prevention
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                        {rca.preventionAction}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* RIGHT: Timeline + Recommended Actions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

            {/* Incident Timeline — vertical */}
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">Incident Timeline — Reconstructed</span>
              </div>
              <div style={{ padding: '10px 14px', position: 'relative' }}>
                {/* Vertical line */}
                <div style={{ position: 'absolute', left: 82, top: 14, bottom: 14, width: 1, background: 'var(--border)' }} />
                {INCIDENT_TIMELINE.map((ev, i) => {
                  const color = EV_COLOR[ev.type] ?? '#64748b';
                  return (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '68px 24px 1fr', gap: '0 10px', marginBottom: 14, alignItems: 'flex-start' }}>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', lineHeight: 1.3 }} suppressHydrationWarning>
                          {relativeTime(ev.ts)}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 2, zIndex: 1 }}>
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0, border: '2px solid var(--bg-surface)' }} />
                      </div>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: ev.severity === 'critical' ? '#ef4444' : 'var(--text-primary)', marginBottom: 2 }}>
                          {ev.title}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>{ev.detail}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Action Playbook summary */}
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">Recommended Actions</span>
                <span style={{ fontSize: 10, color: '#ef4444' }}>Execute in order</span>
              </div>
              {RECOMMENDED_ACTIONS.filter(a => a.urgency === 'immediate' || a.urgency === 'within_15m').map(act => (
                <div key={act.id} className="action-item">
                  <div className={`action-priority priority-${act.priority}`}>{act.priority}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{act.title}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--accent-cyan)',
                      background: 'var(--bg-base)', padding: '3px 7px', borderRadius: 2, marginBottom: 4,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {act.how}
                    </div>
                    <div style={{ fontSize: 11, color: '#10b981' }}>↑ {act.estimatedImpact}</div>
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>{act.estimatedTimeMin}m</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
