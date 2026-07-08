'use client';
import Topbar from '@/components/layout/Topbar';
import { relativeTime, healthColor } from '@/lib/utils';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getQueues, getWorkers, getJobs, getIncidents } from '@/lib/api';

export default function IntelligencePage() {
  const [queuesData, setQueuesData] = useState<any[]>([]);
  const [workersData, setWorkersData] = useState<any[]>([]);
  const [incidents, setIncidents] = useState<{ firing: any[]; history: any[] }>({ firing: [], history: [] });

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [rawQueues, rawWorkers, _, rawIncidents] = await Promise.all([
          getQueues(),
          getWorkers(),
          getJobs(),
          getIncidents().catch(() => ({ firing: [], history: [] }))
        ]);
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
          if (rawIncidents) {
            setIncidents(rawIncidents);
          }
        }
      } catch (err) {
        if (active) {
          setQueuesData([]);
          setWorkersData([]);
          setIncidents({ firing: [], history: [] });
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

  // Compute counts from live data
  const totalWaiting = queuesData.reduce((acc, q) => acc + q.counts.waiting, 0);
  const totalActive = queuesData.reduce((acc, q) => acc + q.counts.active, 0);
  const totalFailed = queuesData.reduce((acc, q) => acc + q.counts.failed, 0);
  const totalDelayed = queuesData.reduce((acc, q) => acc + q.counts.delayed, 0);
  const activeWorkersCount = workersData.filter(w => w.status === 'working' || w.status === 'idle').length;

  // Calculate overall health score (average of queue healths)
  const averageHealth = queuesData.length > 0 ? Math.round(queuesData.reduce((acc, q) => acc + q.healthScore, 0) / queuesData.length) : 100;
  const overallStatus = queuesData.length > 0 ? (averageHealth >= 80 ? 'Healthy' : averageHealth >= 50 ? 'Warning' : 'Critical') : 'Idle';
  const statusColor = overallStatus === 'Healthy' ? '#10b981' : overallStatus === 'Warning' ? '#f59e0b' : overallStatus === 'Critical' ? '#ef4444' : 'var(--text-muted)';

  return (
    <>
      <Topbar title="Overview" subtitle="TaurusMQ Core Observability Dashboard" />
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

        {/* Active Alerts Banner */}
        {incidents.firing.length > 0 ? (
          <div style={{
            padding: '12px 16px',
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={15} color="#ef4444" />
              <span style={{ fontSize: 13, fontWeight: 700, color: '#ef4444' }}>
                {incidents.firing.length} ACTIVE INCIDENT{incidents.firing.length > 1 ? 'S' : ''} DETECTED
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {incidents.firing.map((incident: any) => (
                <div key={incident.id} style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="badge badge-danger" style={{ fontSize: 9, padding: '1px 5px', textTransform: 'uppercase', background: '#ef4444', color: '#fff', borderRadius: 2 }}>
                    {incident.severity}
                  </span>
                  <strong style={{ fontFamily: 'var(--font-mono)' }}>{incident.ruleName}</strong>
                  <span style={{ color: 'var(--text-muted)' }}>—</span>
                  <span>{incident.evidence ? incident.evidence[0] : ''}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{
            padding: '12px 16px',
            background: 'rgba(16, 185, 129, 0.08)',
            border: '1px solid rgba(16, 185, 129, 0.25)',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12.5,
            color: '#10b981',
            fontWeight: 600
          }}>
            <CheckCircle2 size={15} color="#10b981" />
            All systems operational - 0 active incidents firing
          </div>
        )}

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
                      </div>
                    </div>
                  </Link>
                ))}
                {queuesData.length === 0 && (
                  <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    No queues configured.
                  </div>
                )}
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
