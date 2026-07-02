'use client';
import { use } from 'react';
import Topbar from '@/components/layout/Topbar';
import { throughputSeries, latencySeries } from '@/lib/mockData';
import { QUEUE_RISKS, CAPACITY_FORECASTS, RECOMMENDED_ACTIONS, QUEUE_DEPS } from '@/lib/intelligence';
import { fmtMs, fmtNum, fmtPercent, relativeTime, jobStateBadge, jobStateDotColor, healthScoreColor } from '@/lib/utils';
import { AreaSeries } from '@/components/charts/ChartPrimitives';
import { Pause, Play, RefreshCw, Trash2, ArrowRight, AlertTriangle, Zap } from 'lucide-react';
import Link from 'next/link';
import type { JobState } from '@/lib/types';
import { useEffect, useState } from 'react';

function Countdown({ ms }: { ms: number }) {
  const [remaining, setRemaining] = useState(ms);
  useEffect(() => { const id = setInterval(() => setRemaining(r => Math.max(0, r - 1000)), 1000); return () => clearInterval(id); }, []);
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  return <span className="countdown countdown-critical">{m}m {String(s).padStart(2,'0')}s</span>;
}

function HealthRing({ score, size = 72 }: { score: number; size?: number }) {
  const r = (size - 8) / 2; const circ = 2 * Math.PI * r; const dash = (score / 100) * circ;
  const color = healthScoreColor(score);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', position: 'absolute' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth={7} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={7} strokeDasharray={`${dash} ${circ-dash}`} strokeLinecap="round" />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 800, color, lineHeight: 1 }}>{score}</div>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>HEALTH</div>
      </div>
    </div>
  );
}

const STATE_TABS: JobState[] = ['active', 'waiting', 'delayed', 'failed', 'completed'];

import { getQueues, getQueueJobs, retryFailedJobs, cleanQueue, pauseRetries, retryJob, getWorkers } from '@/lib/api';
import { isFeatureEnabled } from '@/lib/features';

export default function QueueDetailPage({ params }: { params: any }) {
  const resolvedParams = (params && typeof params.then === 'function') ? use(params) : params;
  const name = resolvedParams?.name || '';
  const [q, setQ] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [workers, setWorkers] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<JobState>('active');
  const [actionMessage, setActionMessage] = useState('');

  const loadData = async () => {
    try {
      const [allQueues, rawJobs, rawWorkers] = await Promise.all([
        getQueues(),
        getQueueJobs(name),
        getWorkers()
      ]);
      
      if (allQueues) {
        const found = allQueues.find(queue => queue.name === name);
        if (found) {
          setQ({
            name: found.name,
            health: found.healthScore >= 80 ? 'healthy' : found.healthScore >= 50 ? 'degraded' : 'critical',
            healthScore: found.healthScore ?? 100,
            isPaused: found.isPaused ?? false,
            counts: {
              waiting: found.waiting ?? 0,
              active: found.active ?? 0,
              delayed: found.delayed ?? 0,
              failed: found.failed ?? 0,
              completed: found.completed ?? 0,
            },
            throughput: found.throughput ?? 0,
            avgLatency: found.avgLatencyMs ?? 0,
            p99Latency: found.p99LatencyMs ?? 0,
            errorRate: found.errorRate ?? 0,
            retryRate: found.retryRate ?? 0,
            workerCount: found.workerCount ?? 0,
          });
        }
      }
      if (rawJobs) {
        setJobs(rawJobs);
      }
      if (rawWorkers) {
        setWorkers(rawWorkers.map((w: any) => ({
          id: w.id,
          hostname: w.host,
          pid: w.pid,
          queueName: w.queue,
          state: w.state === 'working' ? 'online' : w.state,
          activeJobId: w.activeJobs?.[0]?.id,
          concurrency: w.concurrency,
          cpu: Math.round(w.cpuPercent),
          memory: Math.round((w.memoryBytes ?? 0) / 1024 / 1024),
          memoryMax: 512,
        })));
      }
    } catch (err) {
      // quiet fallback
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 4000);
    return () => clearInterval(interval);
  }, [name]);

  if (!q) {
    return (
      <>
        <Topbar title={name} subtitle="Loading..." />
        <div className="page-content" style={{ padding: 48, textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, fontFamily: 'var(--font-mono)' }}>
            Fetching queue configuration and telemetry from Redis...
          </div>
        </div>
      </>
    );
  }

  const handlePauseToggle = async () => {
    try {
      setActionMessage(q.isPaused ? 'Resuming retries...' : 'Pausing retries...');
      await pauseRetries(name);
      setActionMessage(q.isPaused ? 'Retries resumed' : 'Retries paused');
      setTimeout(() => setActionMessage(''), 2000);
      loadData();
    } catch (err: any) {
      setActionMessage(`Error: ${err.message}`);
    }
  };

  const handleRetryAll = async () => {
    try {
      setActionMessage('Retrying all failed...');
      const res = await retryFailedJobs(name);
      setActionMessage(`Retried ${res.retriedCount} jobs`);
      setTimeout(() => setActionMessage(''), 2000);
      loadData();
    } catch (err: any) {
      setActionMessage(`Error: ${err.message}`);
    }
  };

  const handleClean = async () => {
    if (!confirm('Are you sure you want to clean this queue? All jobs will be purged.')) return;
    try {
      setActionMessage('Cleaning queue...');
      await cleanQueue(name);
      setActionMessage('Queue cleaned');
      setTimeout(() => setActionMessage(''), 2000);
      loadData();
    } catch (err: any) {
      setActionMessage(`Error: ${err.message}`);
    }
  };

  const handleRetrySingle = async (jobId: string) => {
    try {
      setActionMessage(`Retrying job ${jobId}...`);
      await retryJob(name, jobId);
      setActionMessage(`Job ${jobId} sent for retry`);
      setTimeout(() => setActionMessage(''), 2000);
      loadData();
    } catch (err: any) {
      setActionMessage(`Error: ${err.message}`);
    }
  };

  const queueJobs = jobs.filter(j => j.state === activeTab);
  const isIncidentsEnabled = isFeatureEnabled('PHASE_3_INCIDENT_CENTER');
  const isAnalyticsEnabled = isFeatureEnabled('PHASE_4_ANALYTICS');
  const isFlowEnabled = isFeatureEnabled('PHASE_5_FLOW_VISUALIZATION');

  const risk = isIncidentsEnabled ? QUEUE_RISKS.find(r => r.queueName === q.name) : null;
  const forecast = isAnalyticsEnabled ? CAPACITY_FORECASTS.find(f => f.queueName === q.name) : null;
  const actions = isIncidentsEnabled ? RECOMMENDED_ACTIONS.filter(a => a.queue === q.name).slice(0, 3) : [];
  const upstreamDeps = isFlowEnabled ? QUEUE_DEPS.filter(d => d.to === q.name) : [];
  const downstreamDeps = isFlowEnabled ? QUEUE_DEPS.filter(d => d.from === q.name) : [];

  return (
    <>
      <Topbar title={q.name} subtitle={risk ? `queue · risk ${risk.riskScore}/100 · health ${q.healthScore}/100` : `queue · health ${q.healthScore}/100`} />
      <div className="page-content" style={{ padding: 12 }}>

        {/* Action feedback banner */}
        {actionMessage && (
          <div style={{
            background: 'var(--bg-accent)', border: '1px solid var(--accent-cyan)',
            padding: '8px 12px', borderRadius: 4, marginBottom: 8, fontSize: 12,
            fontFamily: 'var(--font-mono)', display: 'flex', justifyContent: 'space-between'
          }}>
            <span>System: {actionMessage}</span>
          </div>
        )}

        {/* ── HEADER: Health + Stats + Actions ── */}
        <div className="panel" style={{
          marginBottom: 8, padding: 14,
          display: 'flex', alignItems: 'center', gap: 20,
          borderColor: q.health === 'critical' ? 'rgba(239,68,68,0.4)' : 'var(--border)',
        }}>
          <HealthRing score={q.healthScore} size={72} />
          <div className="divider" style={{ width: 1, height: 60, background: 'var(--border)' }} />
          {[
            { label: 'Throughput',   value: `${q.throughput}/min`,      color: 'var(--accent-cyan)' },
            { label: 'Avg Latency',  value: fmtMs(q.avgLatency),        color: q.avgLatency > 5000 ? '#ef4444' : 'var(--text-primary)' },
            { label: 'P99 Latency',  value: fmtMs(q.p99Latency),        color: q.p99Latency > 10000 ? '#ef4444' : 'var(--text-primary)' },
            { label: 'Error Rate',   value: fmtPercent(q.errorRate),    color: q.errorRate > 0.1 ? '#ef4444' : '#10b981' },
            { label: 'Retry Rate',   value: fmtPercent(q.retryRate),    color: q.retryRate > 0.15 ? '#f59e0b' : 'var(--text-primary)' },
            { label: 'Workers',      value: String(q.workerCount),      color: 'var(--accent-blue)' },
          ].map(s => (
            <div key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>{s.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: s.color, fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
            </div>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost" onClick={handlePauseToggle}>{q.isPaused ? <><Play size={12}/>Resume</> : <><Pause size={12}/>Pause</>}</button>
            <button className="btn btn-ghost" onClick={handleRetryAll}><RefreshCw size={12}/> Retry All Failed</button>
            <button className="btn btn-danger" onClick={handleClean}><Trash2 size={12}/> Clean</button>
          </div>
        </div>

        {/* ── INTELLIGENCE ROW ── */}
        {(isIncidentsEnabled || isAnalyticsEnabled) && (
          <div className="grid-12" style={{ marginBottom: 8 }}>

            {/* Risk Assessment */}
            {risk && (
              <div className={`panel col-4 risk-card risk-${risk.riskLevel}`} style={{ padding: 0 }}>
                <div className="panel-header">
                  <span className="panel-title">Risk Assessment</span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: risk.riskLevel === 'critical' ? '#ef4444' : risk.riskLevel === 'high' ? '#f97316' : '#f59e0b' }}>
                    {risk.riskScore}/100
                  </span>
                </div>
                <div className="panel-body">
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
                    {risk.failureMode}
                  </div>
                  {risk.timeToFailureMs && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 3 }}>Estimated time to SLA breach</div>
                      <Countdown ms={risk.timeToFailureMs} />
                    </div>
                  )}
                  {risk.signals.map((s, i) => (
                    <div key={i} className="evidence-item">
                      <span className="evidence-dot" style={{ background: risk.riskLevel === 'critical' ? '#ef4444' : '#f59e0b' }} />
                      <span>{s}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Capacity Forecast */}
            {forecast && (
              <div className="panel col-4">
                <div className="panel-header">
                  <span className="panel-title">Capacity Forecast</span>
                  {forecast.timeToOverflowMs && <span style={{ fontSize: 10, color: '#ef4444' }}>Overflow imminent</span>}
                </div>
                <div className="panel-body">
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Current depth</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{forecast.currentDepth.toLocaleString()}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Net growth rate</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: forecast.netGrowthRate > 0 ? '#ef4444' : '#10b981', fontWeight: 700 }}>
                        {forecast.netGrowthRate > 0 ? '+' : ''}{forecast.netGrowthRate.toFixed(0)}/min
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Projected in 1h</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: forecast.projectedDepth1h > forecast.overflowWarningAt ? '#ef4444' : 'var(--text-primary)', fontWeight: 700 }}>
                        {forecast.projectedDepth1h.toLocaleString()}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 8 }}>
                      <span style={{ color: 'var(--text-muted)' }}>SLA limit</span>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{forecast.overflowWarningAt.toLocaleString()}</span>
                    </div>
                    {/* Capacity bar */}
                    <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden', position: 'relative', marginBottom: 6 }}>
                      <div style={{ height: '100%', width: `${Math.min(100, forecast.currentDepth / forecast.overflowWarningAt * 100)}%`,
                        background: forecast.currentDepth > forecast.overflowWarningAt * 0.8 ? '#ef4444' : '#f59e0b', borderRadius: 3 }} />
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: forecast.workersSuggestedToAdd > 0 ? '#f59e0b' : '#10b981', lineHeight: 1.5 }}>
                    {forecast.recommendation}
                  </div>
                </div>
              </div>
            )}

            {/* Recommended Actions */}
            {isIncidentsEnabled && (
              <div className="panel col-4">
                <div className="panel-header">
                  <span className="panel-title">Recommended Actions</span>
                  <Link href="/intelligence/actions" style={{ fontSize: 10, color: 'var(--accent-blue)' }}>All →</Link>
                </div>
                {actions.length === 0 ? (
                  <div className="panel-body" style={{ fontSize: 11.5, color: '#10b981' }}>✓ No immediate actions required</div>
                ) : actions.map(act => (
                  <div key={act.id} className="action-item">
                    <div className={`action-priority priority-${act.priority}`}>{act.priority}</div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>{act.title}</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--accent-cyan)', background: 'var(--bg-base)', padding: '3px 7px', borderRadius: 2, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{act.how}</div>
                      <div style={{ fontSize: 10.5, color: '#10b981' }}>↑ {act.estimatedImpact}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Charts + Workers List ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 340px', gap: 10, marginBottom: 8 }}>
          {/* Throughput Trend */}
          <div className="panel">
            <div className="panel-header"><span className="panel-title">Throughput Trend</span></div>
            <div style={{ padding: '6px 10px 4px' }}>
              <AreaSeries data={throughputSeries.slice(-30)} color="#06b6d4" name="jobs/min" height={110} formatter={v => `${v.toFixed(0)}/min`} />
            </div>
          </div>
          
          {/* Latency & Failure Trend */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">Latency & Failure Trend</span>
              {q.p99Latency > 10000 && <span style={{ fontSize: 10, color: '#ef4444' }}>⚠ SLA breach</span>}
            </div>
            <div style={{ padding: '6px 10px 4px' }}>
              <AreaSeries data={latencySeries.slice(-30)} color="#ef4444" name="ms" height={110} formatter={fmtMs} threshold={2000} thresholdLabel="SLA 2s" />
            </div>
          </div>

          {/* Active Workers listening to this queue */}
          <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="panel-header">
              <span className="panel-title">Workers ({workers.filter((w: any) => w.queueName === q.name).length})</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', maxHeight: 130 }}>
              <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(() => {
                  const filtered = workers.filter((w: any) => w.queueName === q.name);
                  if (filtered.length === 0) {
                    return (
                      <div style={{ padding: '12px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11.5 }}>
                        No active workers on this queue
                      </div>
                    );
                  }
                  return filtered.map((w: any) => (
                    <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 3, padding: '4px 8px' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: w.state === 'online' ? '#10b981' : w.state === 'idle' ? '#64748b' : '#ef4444' }} />
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600 }}>{w.id}</span>
                        </div>
                        <div style={{ fontSize: 9.5, color: 'var(--text-muted)', paddingLeft: 10 }}>pid {w.pid}</div>
                      </div>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>cpu {w.cpu}%</span>
                    </div>
                  ));
                })()}
              </div>
            </div>
          </div>
        </div>

        {/* Queue Dependency Map (Phase 5 Feature-locked) */}
        {isFlowEnabled && (
          <div className="panel" style={{ marginBottom: 8 }}>
            <div className="panel-header"><span className="panel-title">Queue Dependencies</span></div>
            <div className="panel-body">
              {upstreamDeps.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-dim)', letterSpacing: '0.06em', marginBottom: 6 }}>Upstream (triggers this queue)</div>
                  {upstreamDeps.map((d, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                      <Link href={`/queues/${d.from}`} style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--accent-blue)' }}>{d.from}</Link>
                      <ArrowRight size={11} color="var(--text-dim)" />
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.label}</span>
                      {d.isCritical && <span style={{ fontSize: 9, background: 'rgba(239,68,68,0.15)', color: '#ef4444', padding: '1px 5px', borderRadius: 2, fontWeight: 700 }}>CRITICAL</span>}
                    </div>
                  ))}
                </div>
              )}
              {downstreamDeps.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-dim)', letterSpacing: '0.06em', marginBottom: 6 }}>Downstream (this queue triggers)</div>
                  {downstreamDeps.map((d, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{q.name}</span>
                      <ArrowRight size={11} color="var(--text-dim)" />
                      <Link href={`/queues/${d.to}`} style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--accent-blue)' }}>{d.to}</Link>
                      {d.isCritical && <span style={{ fontSize: 9, background: 'rgba(239,68,68,0.15)', color: '#ef4444', padding: '1px 5px', borderRadius: 2, fontWeight: 700 }}>CRITICAL</span>}
                    </div>
                  ))}
                </div>
              )}
              {upstreamDeps.length === 0 && downstreamDeps.length === 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>No queue dependencies configured</div>
              )}
            </div>
          </div>
        )}

        {/* Jobs table */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Jobs</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {STATE_TABS.map(s => (
                <button
                  key={s}
                  className={`filter-chip ${s === activeTab ? 'active' : ''}`}
                  onClick={() => setActiveTab(s)}
                  style={{ fontSize: 11 }}
                >
                  {s} <span style={{ fontVariantNumeric: 'tabular-nums' }}>{q.counts[s as keyof typeof q.counts] ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
          <div style={{ overflowX: 'auto', maxHeight: 300, overflowY: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Job ID</th><th>Name</th><th>State</th><th>Attempts</th><th>Age</th><th>Failure Reason</th><th>Actions</th></tr></thead>
              <tbody>
                {queueJobs.length === 0
                  ? <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No jobs</td></tr>
                  : queueJobs.map(job => (
                    <tr key={job.id}>
                      <td><Link href={`/jobs/${job.id}`} style={{ color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{job.id}</Link></td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{job.name}</td>
                      <td><span className={`badge ${jobStateBadge(job.state)}`}><span className="badge-dot" style={{ background: jobStateDotColor(job.state) }} />{job.state}</span></td>
                      <td style={{ fontVariantNumeric: 'tabular-nums', color: job.attempts >= job.maxAttempts ? '#ef4444' : 'inherit' }}>{job.attempts}/{job.maxAttempts}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 11 }} suppressHydrationWarning>{relativeTime(job.timestamp)}</td>
                      <td style={{ maxWidth: 220 }}>{job.failedReason && <span style={{ fontSize: 11, color: '#ef4444', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', maxWidth: 220 }}>{job.failedReason}</span>}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {job.state === 'failed' && (
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '2px 7px', fontSize: 10.5 }}
                              onClick={() => handleRetrySingle(job.id)}
                            >
                              <RefreshCw size={10}/> Retry
                            </button>
                          )}
                          <Link href={`/jobs/${job.id}`}><button className="btn btn-ghost" style={{ padding: '2px 7px', fontSize: 10.5 }}>Inspect <ArrowRight size={10}/></button></Link>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
