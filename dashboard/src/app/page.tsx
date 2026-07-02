'use client';
import Topbar from '@/components/layout/Topbar';
import {
  QUEUE_RISKS, BOTTLENECKS, RECOMMENDED_ACTIONS, CAPACITY_FORECASTS,
  INCIDENT_TIMELINE
} from '@/lib/intelligence';
import { fmtMs, relativeTime, healthColor, jobStateBadge, jobStateDotColor } from '@/lib/utils';
import { AlertTriangle, Clock, Zap, TrendingUp, CheckCircle2, ChevronRight, Cpu, Activity, Play } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { isFeatureEnabled } from '@/lib/features';
import { getQueues, getWorkers, getJobs } from '@/lib/api';

// ─── Countdown to failure ────────────────────────────────────────────────────
function Countdown({ ms }: { ms: number }) {
  const [remaining, setRemaining] = useState(ms);
  useEffect(() => {
    const id = setInterval(() => setRemaining(r => Math.max(0, r - 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const totalS = Math.floor(remaining / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  const isCritical = remaining < 5 * 60 * 1000;
  return (
    <span className={`countdown ${isCritical ? 'countdown-critical' : 'countdown-warning'}`}>
      {m}m {String(s).padStart(2, '0')}s
    </span>
  );
}

// ─── Urgency pill ─────────────────────────────────────────────────────────────
function UrgencyPill({ u }: { u: string }) {
  const labels: Record<string, string> = {
    immediate: '🔴 DO NOW', within_15m: '🟠 < 15 min', within_1h: '🟡 < 1 hour', planned: '⚪ Planned',
  };
  return (
    <span className={`badge urgency-${u}`} style={{ fontSize: 10.5, fontWeight: 700 }}>
      {labels[u] ?? u}
    </span>
  );
}

// ─── Risk score ring ──────────────────────────────────────────────────────────
function RiskRing({ score, size = 36 }: { score: number; size?: number }) {
  const r = (size - 5) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const color = score >= 80 ? '#ef4444' : score >= 50 ? '#f97316' : score >= 25 ? '#f59e0b' : '#10b981';
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', position: 'absolute' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth={4} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={4}
          strokeDasharray={`${dash} ${circ-dash}`} strokeLinecap="round" />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 800, color }}>
        {score}
      </div>
    </div>
  );
}

export default function IntelligencePage() {
  const isIncidentsEnabled = isFeatureEnabled('PHASE_3_INCIDENT_CENTER');
  const isAnalyticsEnabled = isFeatureEnabled('PHASE_4_ANALYTICS');

  const [queuesData, setQueuesData] = useState<any[]>([]);
  const [workersData, setWorkersData] = useState<any[]>([]);
  const [jobsData, setJobsData] = useState<any[]>([]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const rawQueues = await getQueues();
        const rawWorkers = await getWorkers();
        const rawJobs = await getJobs();
        if (active) {
          if (rawQueues) {
            setQueuesData(rawQueues.map(q => ({
              name: q.name,
              health: q.healthScore >= 80 ? 'healthy' : q.healthScore >= 50 ? 'degraded' : 'critical',
              healthScore: q.healthScore ?? 100,
              isPaused: q.isPaused ?? false,
              counts: {
                waiting: q.waiting ?? 0,
                active: q.active ?? 0,
                delayed: q.delayed ?? 0,
                failed: q.failed ?? 0,
                completed: q.completed ?? 0,
                paused: q.paused ?? 0,
              },
              throughput: q.throughput ?? 0,
              avgLatency: q.avgLatencyMs ?? 0,
              p99Latency: q.p99LatencyMs ?? 0,
              errorRate: q.errorRate ?? 0,
              workerCount: q.workerCount ?? 0,
              retryRate: q.retryRate ?? 0,
            })));
          } else {
            setQueuesData([]);
          }
          if (rawWorkers) {
            setWorkersData(rawWorkers.map(w => ({
              name: w.id,
              queue: w.queue,
              cpu: `${Math.round(w.cpuPercent)}%`,
              mem: `${Math.round((w.memoryBytes ?? 0) / 1024 / 1024)}MB`,
              status: w.state === 'online' ? 'working' : w.state === 'idle' ? 'idle' : 'stalled',
            })));
          }
          if (rawJobs) {
            setJobsData(rawJobs);
          }
        }
      } catch (err) {
        if (active) {
          setQueuesData([]);
          setWorkersData([]);
          setJobsData([]);
        }
      }
    }
    load();
    const interval = setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  // Compute counts from live/mock data
  const totalWaiting = queuesData.reduce((acc, q) => acc + q.counts.waiting, 0);
  const totalActive = queuesData.reduce((acc, q) => acc + q.counts.active, 0);
  const totalFailed = queuesData.reduce((acc, q) => acc + q.counts.failed, 0);
  const totalDelayed = queuesData.reduce((acc, q) => acc + q.counts.delayed, 0);
  const activeWorkersCount = workersData.filter(w => w.status === 'working' || w.status === 'idle').length;

  // Calculate overall health score (average of queue healths)
  const averageHealth = queuesData.length > 0 ? Math.round(queuesData.reduce((acc, q) => acc + q.healthScore, 0) / queuesData.length) : 100;
  const overallStatus = queuesData.length > 0 ? (averageHealth >= 80 ? 'Healthy' : averageHealth >= 50 ? 'Warning' : 'Critical') : 'Idle';
  const statusColor = overallStatus === 'Healthy' ? '#10b981' : overallStatus === 'Warning' ? '#f59e0b' : overallStatus === 'Critical' ? '#ef4444' : 'var(--text-muted)';

  // Filters for post-MVP dashboard
  const criticalRisks  = QUEUE_RISKS.filter(r => r.riskLevel === 'critical');
  const highRisks      = QUEUE_RISKS.filter(r => r.riskLevel === 'high');
  const immediateActs  = RECOMMENDED_ACTIONS.filter(a => a.urgency === 'immediate');
  const worstForecast  = CAPACITY_FORECASTS.find(f => f.timeToOverflowMs);

  // Phase 1 MVP Clean Dashboard View
  if (!isIncidentsEnabled && !isAnalyticsEnabled) {
    return (
      <>
        <Topbar title="Overview" subtitle="TaurusMQ Core Observability (Phase 1 MVP)" />
        <div className="page-content" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          
          {/* Status and Health Header */}
          <div className="panel" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                Production Status
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor }} />
                <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {overallStatus}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                  Health Score
                </div>
                <div style={{ fontSize: 24, fontWeight: 800, color: statusColor }}>
                  {averageHealth}%
                </div>
              </div>
            </div>
          </div>

          {/* Job Counters Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
            <div className="panel" style={{ padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Running Jobs</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, fontFamily: 'var(--font-mono)' }}>{totalActive}</div>
            </div>
            <div className="panel" style={{ padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Waiting Jobs</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, fontFamily: 'var(--font-mono)' }}>{totalWaiting}</div>
            </div>
            <div className="panel" style={{ padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Failed Jobs</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: totalFailed > 0 ? '#ef4444' : 'inherit', fontFamily: 'var(--font-mono)' }}>{totalFailed}</div>
            </div>
            <div className="panel" style={{ padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Delayed Jobs</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, fontFamily: 'var(--font-mono)' }}>{totalDelayed}</div>
            </div>
            <div className="panel" style={{ padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Active Workers</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, fontFamily: 'var(--font-mono)' }}>{activeWorkersCount}</div>
            </div>
          </div>

          {/* Main Content Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 10 }}>
            
            {/* Left Column: Queues and Recent Failures */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              
              {/* Top Failing/Degraded Queues */}
              <div className="panel">
                <div className="panel-header">
                  <span className="panel-title">Queues Status</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{queuesData.length} configured</span>
                </div>
                <div>
                  {queuesData.map(q => (
                    <Link href={`/queues/${q.name}`} key={q.name} style={{ display: 'block', textDecoration: 'none' }}>
                      <div style={{
                        padding: '10px 14px',
                        borderBottom: '1px solid var(--border-subtle)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: healthColor(q.health) }} />
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                            {q.name}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                          <div>
                            <span style={{ color: 'var(--text-muted)' }}>active: </span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{q.counts.active}</span>
                          </div>
                          <div>
                            <span style={{ color: 'var(--text-muted)' }}>failed: </span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: q.counts.failed > 0 ? '#ef4444' : 'inherit' }}>{q.counts.failed}</span>
                          </div>
                          <div>
                            <span style={{ color: 'var(--text-muted)' }}>healthScore: </span>
                            <span style={{ fontWeight: 600, color: healthColor(q.health) }}>{q.healthScore}%</span>
                          </div>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>

              {/* Recent Failure Events */}
              <div className="panel">
                <div className="panel-header">
                  <span className="panel-title">Recent Failures</span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Job ID</th>
                        <th>Queue</th>
                        <th>Error</th>
                        <th>Failed At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const failedLive = jobsData.filter(j => j.state === 'failed');
                        if (failedLive.length === 0) {
                          return (
                            <tr>
                              <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0', fontSize: 12.5 }}>
                                ✓ No failed jobs in database
                              </td>
                            </tr>
                          );
                        }
                        return failedLive.slice(0, 5).map(job => (
                          <tr key={job.id}>
                            <td>
                              <Link href={`/jobs/${job.id}`} style={{ color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                                {job.id}
                              </Link>
                            </td>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{job.queueName}</td>
                            <td style={{ color: '#ef4444', fontSize: 11, fontFamily: 'var(--font-mono)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {job.failedReason}
                            </td>
                            <td style={{ fontSize: 11, color: 'var(--text-muted)' }} suppressHydrationWarning>{relativeTime(job.timestamp)}</td>
                          </tr>
                        ));
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>

            {/* Right Column: Worker Health Status */}
            <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="panel-header">
                <span className="panel-title">Worker Node Overview</span>
                <span style={{ fontSize: 10, color: '#10b981' }}>{activeWorkersCount} Online</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {workersData.length === 0 ? (
                    <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                      No active workers registered
                    </div>
                  ) : (
                    workersData.map(w => (
                      <div key={w.name} style={{
                        padding: 8,
                        background: 'var(--bg-base)',
                        border: '1px solid var(--border)',
                        borderRadius: 3,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700 }}>{w.name}</span>
                          <span className={`badge ${w.status === 'working' ? 'badge-active' : 'badge-completed'}`} style={{ fontSize: 9 }}>
                            {w.status}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                          Queue: <span style={{ fontFamily: 'var(--font-mono)' }}>{w.queue}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 12, fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>
                          <div><span style={{ color: 'var(--text-dim)' }}>CPU: </span>{w.cpu}</div>
                          <div><span style={{ color: 'var(--text-dim)' }}>RAM: </span>{w.mem}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

          </div>

        </div>
      </>
    );
  }

  // Full Post-MVP Dashboard View
  return (
    <>
      <Topbar title="Operations Intelligence" subtitle="Decision-support center · Active Incident" />
      <div className="page-content" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>

        {/* ── INCIDENT COMMAND BAR ──────────────────────────────────── */}
        <div style={{
          padding: '12px 16px',
          background: 'rgba(239,68,68,0.07)',
          border: '1px solid rgba(239,68,68,0.35)',
          borderRadius: 4,
          display: 'grid',
          gridTemplateColumns: '1fr auto auto auto',
          gap: 24,
          alignItems: 'center',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <AlertTriangle size={14} color="#ef4444" />
              <span style={{ fontSize: 13, fontWeight: 700, color: '#ef4444' }}>ACTIVE INCIDENT — image-processing OOM Cascade</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }} suppressHydrationWarning>Started {relativeTime(Date.now() - 47*60*1000)}</span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              3,847 jobs stuck · 891 failed · 2 workers degraded · Queue overflows in:
            </div>
          </div>
          {worstForecast?.timeToOverflowMs && <Countdown ms={worstForecast.timeToOverflowMs} />}
          <div style={{ display: 'flex', gap: 6 }}>
            <Link href="/intelligence/incident">
              <button className="btn btn-danger" style={{ fontSize: 12 }}>Incident Analysis →</button>
            </Link>
            <Link href="/intelligence/actions">
              <button className="btn btn-primary" style={{ fontSize: 12 }}>View Playbook →</button>
            </Link>
          </div>
        </div>

        {/* ── MAIN GRID ─────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 300px', gap: 8, flex: 1 }}>

          {/* LEFT: Queue Risk Scorecard */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="panel" style={{ flex: 1 }}>
              <div className="panel-header">
                <span className="panel-title">Queue Risk Scorecard</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {criticalRisks.length} critical · {highRisks.length} high
                </span>
              </div>
              <div style={{ overflowY: 'auto' }}>
                {QUEUE_RISKS.sort((a, b) => b.riskScore - a.riskScore).map(risk => (
                  <Link key={risk.queueName} href={`/queues/${risk.queueName}`} style={{ textDecoration: 'none' }}>
                    <div style={{
                      padding: '10px 12px',
                      borderBottom: '1px solid var(--border-subtle)',
                      display: 'grid',
                      gridTemplateColumns: '36px 1fr auto',
                      gap: 10,
                      alignItems: 'start',
                    }}>
                      <RiskRing score={risk.riskScore} size={36} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600 }}>{risk.queueName}</span>
                          <span className={`badge risk-${risk.riskLevel}`} style={{ fontSize: 10, padding: '1px 5px' }}>
                            {risk.riskLevel}
                          </span>
                          {risk.trend === 'degrading' && <span style={{ fontSize: 10, color: '#f97316' }}>↓ degrading</span>}
                          {risk.trend === 'critical'  && <span style={{ fontSize: 10, color: '#ef4444' }}>⚡ critical</span>}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                          {risk.failureMode}
                        </div>
                        {risk.signals.length > 0 && (
                          <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 1 }}>
                            {risk.signals.slice(0, 2).map((s, i) => (
                              <div key={i} style={{ fontSize: 10.5, color: 'var(--text-muted)', display: 'flex', gap: 5, alignItems: 'center' }}>
                                <span style={{ color: '#ef4444', fontSize: 9 }}>▸</span>{s}
                              </div>
                            ))}
                            {risk.signals.length > 2 && (
                              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>+{risk.signals.length - 2} more signals</div>
                            )}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        {risk.timeToFailureMs ? (
                          <div>
                            <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 1 }}>Fails in</div>
                            <Countdown ms={risk.timeToFailureMs} />
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: '#10b981' }}>Stable</div>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {/* CENTER: Bottleneck + Capacity Forecast */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

            {/* Bottleneck Detection */}
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title">Bottleneck Detection</span>
                <span style={{ fontSize: 10, color: '#ef4444' }}>{BOTTLENECKS.filter(b=>b.severity==='critical').length} critical constraints</span>
              </div>
              <div>
                {BOTTLENECKS.map(bn => (
                  <div key={bn.id} style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--border-subtle)',
                    borderLeft: `3px solid ${bn.severity === 'critical' ? '#ef4444' : bn.severity === 'high' ? '#f97316' : '#f59e0b'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                      <div>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                          {bn.location}
                        </span>
                        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', marginLeft: 8 }}>
                          {bn.constraintValue} / {bn.limitValue}
                        </span>
                      </div>
                      <span style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 2, fontWeight: 700,
                        background: bn.severity === 'critical' ? 'rgba(239,68,68,0.15)' : 'rgba(249,115,22,0.12)',
                        color: bn.severity === 'critical' ? '#ef4444' : '#f97316',
                        textTransform: 'uppercase',
                      }}>{bn.severity}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{bn.description}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                      <span style={{ color: '#f59e0b' }}>Impact: </span>{bn.impact}
                    </div>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }}>
                      <Zap size={10} /> {bn.actionLabel}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Capacity Forecast */}
            <div className="panel" style={{ flex: 1 }}>
              <div className="panel-header">
                <span className="panel-title">Capacity Forecasting — 1h Projection</span>
              </div>
              <div style={{ overflowY: 'auto' }}>
                {CAPACITY_FORECASTS.map(f => {
                  const isGrowing = f.netGrowthRate > 0;
                  const overflowPct = Math.min(100, (f.currentDepth / f.overflowWarningAt) * 100);
                  return (
                    <div key={f.queueName} style={{ padding: '9px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>{f.queueName}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                          <span style={{ color: isGrowing ? '#ef4444' : '#10b981', fontFamily: 'var(--font-mono)' }}>
                            {isGrowing ? '↑' : '↓'} {Math.abs(f.netGrowthRate).toFixed(0)}/min
                          </span>
                          {f.timeToOverflowMs && <Countdown ms={f.timeToOverflowMs} />}
                        </div>
                      </div>

                      {/* Capacity bar */}
                      <div style={{ position: 'relative', height: 6, background: 'var(--border)', borderRadius: 3, marginBottom: 4, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', width: `${overflowPct}%`,
                          background: overflowPct > 80 ? '#ef4444' : overflowPct > 50 ? '#f59e0b' : '#10b981',
                          borderRadius: 3, transition: 'width 0.3s',
                        }} />
                        {/* SLA threshold marker */}
                        <div style={{ position: 'absolute', left: '80%', top: 0, bottom: 0, width: 1, background: 'rgba(239,68,68,0.8)' }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 4 }}>
                        <span>{f.currentDepth.toLocaleString()} now → {f.projectedDepth1h.toLocaleString()} in 1h</span>
                        <span>SLA limit: {f.overflowWarningAt.toLocaleString()}</span>
                      </div>
                      {f.workersSuggestedToAdd > 0 && (
                        <div style={{ fontSize: 11, color: '#f59e0b' }}>
                          ⚠ Add {f.workersSuggestedToAdd} workers to prevent overflow
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* RIGHT: Triage Playbook — What to do next */}
          <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="panel-header">
              <span className="panel-title">Triage Playbook</span>
              <span style={{ fontSize: 10, color: '#ef4444' }}>{immediateActs.length} immediate</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {RECOMMENDED_ACTIONS.map(act => (
                <div key={act.id} className="action-item">
                  <div className={`action-priority priority-${act.priority}`}>{act.priority}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ marginBottom: 4 }}>
                      <UrgencyPill u={act.urgency} />
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, lineHeight: 1.4 }}>
                      {act.title}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5, lineHeight: 1.5 }}>
                      {act.why}
                    </div>
                    <div style={{
                      fontFamily: 'var(--font-mono)', fontSize: 10.5, padding: '4px 7px',
                      background: 'var(--bg-base)', borderRadius: 3, color: 'var(--accent-cyan)',
                      marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {act.how}
                    </div>
                    <div style={{ fontSize: 11, color: '#10b981' }}>
                      ↑ {act.estimatedImpact}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
                      Est. {act.estimatedTimeMin} min to implement
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)' }}>
              <Link href="/intelligence/actions">
                <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center', fontSize: 11 }}>
                  Full Playbook <ChevronRight size={11} />
                </button>
              </Link>
            </div>
          </div>
        </div>

        {/* ── INCIDENT TIMELINE strip ───────────────────────────────── */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Incident Timeline — Last 47 minutes</span>
            <Link href="/intelligence/incident" style={{ fontSize: 10, color: 'var(--accent-blue)' }}>Full Analysis →</Link>
          </div>
          <div style={{ padding: '10px 14px', display: 'flex', gap: 0, overflowX: 'auto' }}>
            {INCIDENT_TIMELINE.map((ev, i) => {
              const color = ev.severity === 'critical' ? '#ef4444' : ev.severity === 'warning' ? '#f59e0b' : '#64748b';
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 0, flexShrink: 0 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 160 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                      <span style={{ fontSize: 9.5, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }} suppressHydrationWarning>
                        {relativeTime(ev.ts)}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color, textAlign: 'center', lineHeight: 1.3, paddingBottom: 4 }}>
                      {ev.title}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.4, padding: '0 4px' }}>
                      {ev.detail}
                    </div>
                  </div>
                  {i < INCIDENT_TIMELINE.length - 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', marginTop: 3, flexShrink: 0 }}>
                      <div style={{ height: 1, width: 20, background: 'var(--border)' }} />
                      <ChevronRight size={10} color="var(--border)" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
