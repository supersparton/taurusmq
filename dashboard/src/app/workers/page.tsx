'use client';
import Topbar from '@/components/layout/Topbar';
import { HEATMAP_DATA } from '@/lib/intelligence';
import { fmtMs, relativeTime, workerStateBadge, cpuColor, memColor } from '@/lib/utils';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { getWorkers } from '@/lib/api';
import { isFeatureEnabled } from '@/lib/features';

// Heatmap color: green → yellow → red by utilization
function utilizationColor(util: number, failures: number): string {
  if (failures > 30) return '#ef4444';
  if (util >= 90) return '#ef4444';
  if (util >= 70) return '#f97316';
  if (util >= 50) return '#f59e0b';
  if (util >= 25) return '#10b981';
  return '#1e3a2e';
}

function ResourceBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${(value/max)*100}%`, background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color, width: 32, textAlign: 'right' }}>
        {((value/max)*100).toFixed(0)}%
      </span>
    </div>
  );
}

function HeartbeatBar({ history }: { history: number[] }) {
  return (
    <div className="heartbeat-bar">
      {history.map((tick, i) => (
        <div key={i} className="heartbeat-tick" style={{
          height: 12, background: tick === 1 ? '#10b981' : '#ef4444',
          opacity: tick === 1 ? 0.5 + (i / history.length) * 0.5 : 0.9,
        }} />
      ))}
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const WORKER_IDS = ['wkr_email_01','wkr_email_02','wkr_img_01','wkr_img_02','wkr_report_01','wkr_webhook_01'];
const WORKER_LABELS: Record<string, string> = {
  'wkr_email_01': 'email-01', 'wkr_email_02': 'email-02',
  'wkr_img_01': 'img-01 ⚠', 'wkr_img_02': 'img-02',
  'wkr_report_01': 'report-01', 'wkr_webhook_01': 'webhook-01',
};

export default function WorkersPage() {
  const [workersData, setWorkersData] = useState<any[]>([]);
  const isAnalyticsEnabled = isFeatureEnabled('PHASE_4_ANALYTICS');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const raw = await getWorkers();
        if (active && raw) {
          setWorkersData(raw.map(w => ({
            id: w.id,
            hostname: w.host,
            pid: w.pid,
            queueName: w.queue,
            state: w.state === 'working' ? 'online' : w.state, // Map backend 'working' to frontend 'online' for registry
            activeJobId: w.activeJobs?.[0]?.id,
            concurrency: w.concurrency,
            processedJobs: w.processedJobs ?? 0,
            failedJobs: w.failedJobs ?? 0,
            lastHeartbeat: w.lastHeartbeat,
            startedAt: w.startedAt,
            cpu: Math.round(w.cpuPercent),
            memory: Math.round((w.memoryBytes ?? 0) / 1024 / 1024),
            memoryMax: 512,
            heartbeatHistory: w.heartbeatHistory ?? Array(30).fill(1),
          })));
        }
      } catch (err) {
        if (active) {
          setWorkersData([]);
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

  const online  = workersData.filter(w => w.state === 'online' || w.state === 'active').length;
  const stalled = workersData.filter(w => w.state === 'stalled').length;
  const idle    = workersData.filter(w => w.state === 'idle').length;

  const heatmapLookup = new Map<string, typeof HEATMAP_DATA[0]>();
  HEATMAP_DATA.forEach(c => heatmapLookup.set(`${c.workerId}_${c.hour}`, c));

  return (
    <>
      <Topbar title="Worker Monitoring" subtitle={`${online} online · ${stalled} stalled · ${idle} idle`} />
      <div className="page-content" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>

        {/* Summary stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {[
            { label: 'Online',   value: online,         color: '#10b981' },
            { label: 'Idle',     value: idle,           color: '#64748b' },
            { label: 'Stalled',  value: stalled,        color: '#ef4444' },
            { label: 'Total',    value: workersData.length, color: 'var(--text-secondary)' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div className="stat-label">{s.label}</div>
              <div className="stat-value" style={{ fontSize: 26, color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* ── Worker Utilization Heatmap ──────────────────────────────────────── */}
        {isAnalyticsEnabled && (
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">Worker Utilization Heatmap — 24h</span>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 10 }}>
                {[['#1e3a2e','Idle'],['#10b981','Low'],['#f59e0b','Med'],['#f97316','High'],['#ef4444','Critical / Failures']].map(([c,l]) => (
                  <div key={l} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <div style={{ width: 10, height: 10, background: c, borderRadius: 1 }} />
                    <span style={{ color: 'var(--text-muted)' }}>{l}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: '10px 14px', overflowX: 'auto' }}>
              {/* Hour axis */}
              <div style={{ display: 'flex', marginLeft: 80, marginBottom: 4 }}>
                {HOURS.map(h => (
                  <div key={h} style={{
                    width: 28, textAlign: 'center', fontSize: 9.5,
                    color: h >= 21 ? '#ef4444' : 'var(--text-dim)',
                    fontFamily: 'var(--font-mono)', fontWeight: h >= 21 ? 700 : 400,
                  }}>
                    {String(h).padStart(2, '0')}
                  </div>
                ))}
                <div style={{ fontSize: 9, color: '#ef4444', marginLeft: 4, alignSelf: 'center' }}>← incident</div>
              </div>

              {/* Rows per worker */}
              {WORKER_IDS.map(wid => (
                <div key={wid} style={{ display: 'flex', alignItems: 'center', marginBottom: 4, gap: 0 }}>
                  <div style={{
                    width: 80, fontSize: 11, fontFamily: 'var(--font-mono)',
                    color: wid === 'wkr_img_01' ? '#ef4444' : 'var(--text-secondary)',
                    textAlign: 'right', paddingRight: 8, flexShrink: 0, fontWeight: wid.includes('img') ? 700 : 400,
                  }}>
                    {WORKER_LABELS[wid]}
                  </div>
                  {HOURS.map(h => {
                    const cell = heatmapLookup.get(`${wid}_${h}`);
                    const util = cell?.utilization ?? 0;
                    const fail = cell?.failures ?? 0;
                    const color = utilizationColor(util, fail);
                    return (
                      <div
                        key={h}
                        className="heatmap-cell"
                        title={`${wid} ${String(h).padStart(2,'0')}:00 — ${util.toFixed(0)}% util · ${fail} failures`}
                        style={{
                          width: 28, height: 20, background: color, margin: '0 1px',
                          border: h >= 21 ? '1px solid rgba(239,68,68,0.3)' : 'none',
                        }}
                      />
                    );
                  })}
                </div>
              ))}

              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Red cells at hours 21-23 indicate the active incident window. wkr_img_01 and wkr_img_02 at near-100% with high failure counts.
              </div>
            </div>
          </div>
        )}

        {/* ── Worker Registry ─────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {workersData.length === 0 ? (
            <div className="panel" style={{ padding: '48px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, fontFamily: 'var(--font-mono)' }}>
                No active workers registered
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', maxWidth: 450, margin: '0 auto', lineHeight: 1.5 }}>
                Start a TaurusMQ worker process using your consumer script (e.g. by instantiating a Worker and connecting it to Redis) to see its live performance metrics and diagnostics here.
              </div>
            </div>
          ) : (
            workersData.map(w => {
              const cColor = cpuColor(w.cpu);
              const mColor = memColor(w.memory, w.memoryMax);
              const isProblematic = w.state === 'stalled' || w.cpu > 85 || w.memory / w.memoryMax > 0.85;
              return (
                <div key={w.id} className="panel" style={{
                  borderColor: isProblematic ? (w.state === 'stalled' ? 'rgba(239,68,68,0.4)' : 'rgba(245,158,11,0.3)') : 'var(--border)',
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '200px 140px 1fr 1fr 110px 110px 170px', alignItems: 'center', gap: 14, padding: '10px 14px' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                          background: w.state === 'online' ? '#10b981' : w.state === 'idle' ? '#64748b' : '#ef4444',
                          boxShadow: w.state === 'online' ? '0 0 5px #10b981' : 'none',
                        }} />
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>{w.id}</span>
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', paddingLeft: 13 }}>
                        pid {w.pid}
                      </div>
                    </div>
                    <div>
                      <span className={`badge ${workerStateBadge(w.state)}`}>{w.state}</span>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                        {w.queueName}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>CPU</div>
                      <ResourceBar value={w.cpu} max={100} color={cColor} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Memory {w.memory}MB / {w.memoryMax}MB
                      </div>
                      <ResourceBar value={w.memory} max={w.memoryMax} color={mColor} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Jobs</div>
                      <div style={{ fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
                        <span style={{ color: '#10b981' }}>✓{w.processedJobs.toLocaleString()}</span>
                        {' '}
                        <span style={{ color: '#ef4444' }}>✗{w.failedJobs}</span>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Heartbeat {w.state === 'stalled' ? <span style={{ color: '#ef4444' }}>LOST</span> : ''}
                      </div>
                      <HeartbeatBar history={w.heartbeatHistory.slice(-16)} />
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }} suppressHydrationWarning>
                        {relativeTime(w.lastHeartbeat)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Active Job</div>
                      {w.activeJobId ? (
                        <Link href={`/jobs/${w.activeJobId}`} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent-blue)' }}>
                          {w.activeJobId}
                        </Link>
                      ) : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>}
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }} suppressHydrationWarning>up {relativeTime(w.startedAt)}</div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
