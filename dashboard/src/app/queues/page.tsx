'use client';
import Link from 'next/link';
import Topbar from '@/components/layout/Topbar';
import { fmtMs, fmtNum, fmtPercent, healthBadge, healthColor, healthScoreColor } from '@/lib/utils';
import { Pause, Play, Trash2, RefreshCw, Layers } from 'lucide-react';
import { useState, useEffect } from 'react';
import { getQueues } from '@/lib/api';

function HealthRing({ score, size = 48 }: { score: number; size?: number }) {
  const r = (size - 7) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const color = healthScoreColor(score);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', position: 'absolute' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth={6} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={6}
          strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round" />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700, color }}>
        {score}
      </div>
    </div>
  );
}

function JobStateBar({ counts }: { counts: any }) {
  const total = counts.waiting + counts.active + counts.delayed + counts.failed + counts.completed;
  if (total === 0) return <div style={{ height: 6, background: 'var(--border)', borderRadius: 2 }} />;
  const pct = (n: number) => `${(n / total * 100).toFixed(1)}%`;
  return (
    <div style={{ display: 'flex', height: 6, borderRadius: 2, overflow: 'hidden', gap: 1 }}>
      <div style={{ width: pct(counts.completed), background: '#10b981', minWidth: counts.completed > 0 ? 2 : 0 }} />
      <div style={{ width: pct(counts.active),    background: '#3b82f6', minWidth: counts.active > 0 ? 2 : 0 }} />
      <div style={{ width: pct(counts.waiting),   background: '#64748b', minWidth: counts.waiting > 0 ? 2 : 0 }} />
      <div style={{ width: pct(counts.delayed),   background: '#f59e0b', minWidth: counts.delayed > 0 ? 2 : 0 }} />
      <div style={{ width: pct(counts.failed),    background: '#ef4444', minWidth: counts.failed > 0 ? 2 : 0 }} />
    </div>
  );
}

import { pauseRetries, retryFailedJobs, cleanQueue } from '@/lib/api';

export default function QueuesPage() {
  const [queuesData, setQueuesData] = useState<any[]>([]);
  const [actionMessage, setActionMessage] = useState('');

  const loadData = async () => {
    try {
      const raw = await getQueues();
      if (raw) {
        setQueuesData(raw.map(q => ({
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
    } catch (err) {
      setQueuesData([]);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 4000);
    return () => clearInterval(interval);
  }, []);

  const handlePauseToggle = async (e: React.MouseEvent, queueName: string) => {
    e.preventDefault();
    try {
      setActionMessage(`Pausing retries for ${queueName}...`);
      await pauseRetries(queueName);
      setActionMessage(`Retries paused for ${queueName}`);
      setTimeout(() => setActionMessage(''), 2000);
      loadData();
    } catch (err: any) {
      setActionMessage(`Error: ${err.message}`);
    }
  };

  const handleRetryAll = async (e: React.MouseEvent, queueName: string) => {
    e.preventDefault();
    try {
      setActionMessage(`Retrying failed jobs for ${queueName}...`);
      const res = await retryFailedJobs(queueName);
      setActionMessage(`Retried ${res.retriedCount} jobs for ${queueName}`);
      setTimeout(() => setActionMessage(''), 2000);
      loadData();
    } catch (err: any) {
      setActionMessage(`Error: ${err.message}`);
    }
  };

  const handleClean = async (e: React.MouseEvent, queueName: string) => {
    e.preventDefault();
    if (!confirm(`Are you sure you want to clean queue "${queueName}"? All jobs will be purged.`)) return;
    try {
      setActionMessage(`Cleaning queue ${queueName}...`);
      await cleanQueue(queueName);
      setActionMessage(`Queue ${queueName} cleaned`);
      setTimeout(() => setActionMessage(''), 2000);
      loadData();
    } catch (err: any) {
      setActionMessage(`Error: ${err.message}`);
    }
  };

  return (
    <>
      <Topbar title="Queues" subtitle={`${queuesData.length} queues registered`} />
      <div className="page-content" style={{ padding: 12 }}>
        {actionMessage && (
          <div style={{
            background: 'var(--bg-accent)', border: '1px solid var(--accent-cyan)',
            padding: '8px 12px', borderRadius: 4, marginBottom: 8, fontSize: 12,
            fontFamily: 'var(--font-mono)'
          }}>
            System: {actionMessage}
          </div>
        )}
        {queuesData.length === 0 ? (
          <div className="panel" style={{ padding: 48, textAlign: 'center' }}>
            <Layers size={36} color="var(--text-dim)" style={{ marginBottom: 12, margin: '0 auto' }} />
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>No Active Queues Detected</div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 400, margin: '0 auto', lineHeight: 1.5 }}>
              We couldn't find any queues in the Redis database. Once your workers connect or you enqueue jobs, they will automatically appear here.
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 8 }}>
            {queuesData.map(q => (
              <Link key={q.name} href={`/queues/${q.name}`} style={{ textDecoration: 'none' }}>
                <div className="panel" style={{
                  cursor: 'pointer',
                  borderColor: q.health === 'critical' ? 'rgba(239,68,68,0.4)' : q.health === 'degraded' ? 'rgba(245,158,11,0.3)' : 'var(--border)',
                  transition: 'border-color 150ms',
                }}>
                  <div className="panel-header" style={{ gap: 10 }}>
                    <HealthRing score={q.healthScore} size={44} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {q.name}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                        <span className={`badge ${healthBadge(q.health)}`}>
                          <span className="badge-dot" style={{ background: healthColor(q.health) }} />
                          {q.health}
                        </span>
                        {q.isPaused && <span className="badge badge-paused">paused</span>}
                        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{q.workerCount} workers</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent-cyan)', fontVariantNumeric: 'tabular-nums' }}>
                        {q.throughput}<span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>/min</span>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>throughput</div>
                    </div>
                  </div>

                  <div className="panel-body">
                    {/* Job state distribution bar */}
                    <div style={{ marginBottom: 10 }}>
                      <JobStateBar counts={q.counts} />
                      <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11, flexWrap: 'wrap' }}>
                        <span style={{ color: '#10b981' }}>✓ {fmtNum(q.counts.completed)}</span>
                        <span style={{ color: '#3b82f6' }}>▶ {q.counts.active}</span>
                        <span style={{ color: '#64748b' }}>⏸ {q.counts.waiting}</span>
                        <span style={{ color: '#f59e0b' }}>⏱ {q.counts.delayed}</span>
                        <span style={{ color: q.counts.failed > 50 ? '#ef4444' : '#ef444480', fontWeight: q.counts.failed > 50 ? 700 : 400 }}>
                          ✗ {q.counts.failed}
                        </span>
                      </div>
                    </div>

                    {/* Metrics grid */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
                      {[
                        { label: 'Avg Latency', value: fmtMs(q.avgLatency), color: q.avgLatency > 5000 ? '#ef4444' : 'var(--text-primary)' },
                        { label: 'P99 Latency', value: fmtMs(q.p99Latency), color: q.p99Latency > 10000 ? '#ef4444' : 'var(--text-primary)' },
                        { label: 'Error Rate',  value: fmtPercent(q.errorRate), color: q.errorRate > 0.1 ? '#ef4444' : q.errorRate > 0.02 ? '#f59e0b' : 'var(--accent-green)' },
                      ].map(m => (
                        <div key={m.label} style={{ background: 'var(--bg-base)', borderRadius: 3, padding: '6px 8px' }}>
                          <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{m.label}</div>
                          <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', color: m.color, marginTop: 2 }}>{m.value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={e => handlePauseToggle(e, q.name)}>
                        {q.isPaused ? <><Play size={11} /> Resume</> : <><Pause size={11} /> Pause</>}
                      </button>
                      <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={e => handleRetryAll(e, q.name)}>
                        <RefreshCw size={11} /> Retry Failed
                      </button>
                      <button className="btn btn-danger" style={{ fontSize: 11, marginLeft: 'auto' }} onClick={e => handleClean(e, q.name)}>
                        <Trash2 size={11} /> Clean
                      </button>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
