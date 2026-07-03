'use client';
import { use, useState, useEffect } from 'react';
import Topbar from '@/components/layout/Topbar';
import { fmtMs, fmtFullTimestamp, relativeTime, jobStateBadge, jobStateDotColor } from '@/lib/utils';
import { RefreshCw, ChevronDown, ChevronRight, Copy, AlertTriangle, Clock, User, Zap, FileText, Lock, Play, Edit2, Check, X } from 'lucide-react';
import { isFeatureEnabled } from '@/lib/features';
import { getJob, retryJob, getWorkers, replayJob } from '@/lib/api';

// ─── JSON Viewer — syntax-highlighted payload ────────────────────────────────
function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [collapsed, setCollapsed] = useState(depth > 1);
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === 'boolean') return <span className="json-bool">{String(value)}</span>;
  if (typeof value === 'number') return <span className="json-number">{value}</span>;
  if (typeof value === 'string') return <span className="json-string">"{value}"</span>;
  if (Array.isArray(value)) {
    if (collapsed) return (
      <span onClick={() => setCollapsed(false)} style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
        [{value.length} items]
      </span>
    );
    return (
      <span>
        <span style={{ color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => setCollapsed(true)}>[</span>
        {value.map((v, i) => (
          <div key={i} style={{ paddingLeft: 16 }}>
            <JsonValue value={v} depth={depth + 1} />
            {i < value.length - 1 && <span style={{ color: 'var(--text-dim)' }}>,</span>}
          </div>
        ))}
        <span style={{ color: 'var(--text-muted)' }}>]</span>
      </span>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (collapsed) return (
      <span onClick={() => setCollapsed(false)} style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
        {'{'}…{'}'}
      </span>
    );
    return (
      <span>
        <span style={{ color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => setCollapsed(true)}>{'{'}</span>
        {entries.map(([k, v], i) => (
          <div key={k} style={{ paddingLeft: 16 }}>
            <span className="json-key">"{k}"</span>
            <span style={{ color: 'var(--text-muted)' }}>: </span>
            <JsonValue value={v} depth={depth + 1} />
            {i < entries.length - 1 && <span style={{ color: 'var(--text-dim)' }}>,</span>}
          </div>
        ))}
        <span style={{ color: 'var(--text-muted)' }}>{'}'}</span>
      </span>
    );
  }
  return <span>{String(value)}</span>;
}

// ─── Stack trace — Sentry-inspired ─────────────────────────────────────────
function StackTrace({ frames }: { frames: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? frames : frames.slice(0, 3);
  return (
    <div style={{ background: '#07090d', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <AlertTriangle size={11} color="#ef4444" />
        Stack Trace
      </div>
      {visible.map((frame, i) => {
        const isCulprit = i === 0;
        const match = frame.match(/at (.+?) \((.+?):(\d+)/);
        return (
          <div key={i} className={`stack-frame ${isCulprit ? 'culprit' : ''}`}>
            {match ? (
              <>
                <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>{i === 0 ? '▶' : ' '}</span>
                <span className="stack-frame-fn">{match[1]}</span>
                <span style={{ color: 'var(--text-dim)' }}> — </span>
                <span className="stack-frame-file">{match[2]}</span>
                <span className="stack-frame-line">:{match[3]}</span>
              </>
            ) : (
              <span style={{ color: i === 0 ? '#ef4444' : 'var(--text-muted)' }}>{frame}</span>
            )}
          </div>
        );
      })}
      {frames.length > 3 && (
        <button onClick={() => setExpanded(!expanded)} style={{
          width: '100%', padding: '5px 10px', background: 'transparent',
          border: 'none', borderTop: '1px solid var(--border)',
          color: 'var(--accent-blue)', fontSize: 11, cursor: 'pointer', textAlign: 'left',
        }}>
          {expanded ? '▲ Show less' : `▼ Show ${frames.length - 3} more frames`}
        </button>
      )}
    </div>
  );
}

// ─── Diagnostic Snapshot Panel ──────────────────────────────────────────────
function SnapshotPanel({ snapshot }: { snapshot: any }) {
  if (!snapshot) return <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: 8 }}>No diagnostic snapshot captured.</div>;
  return (
    <div style={{ background: '#0b0f19', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
        Diagnostic Snapshot (Failure context)
      </div>
      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Worker Memory</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600 }}>{snapshot.memory} MB</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Worker CPU Usage</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600 }}>{snapshot.cpu}%</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: 4 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Environment (NODE_ENV)</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600 }}>{snapshot.env?.NODE_ENV}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: 2 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Redis Connection</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: '#10b981' }}>{snapshot.redis?.status}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Execution timeline — Datadog trace waterfall ─────────────────────────
function ExecutionTimeline({ job }: { job: any }) {
  let events: Array<{ label: string; ts: number; color: string; desc?: string }> = [];

  if (job.timeline && job.timeline.length > 0) {
    events = job.timeline.map((evt: any) => {
      let label = evt.event.toUpperCase();
      let color = '#64748b';
      let desc = '';
      if (evt.event === 'queued') {
        label = 'Enqueued';
        color = '#64748b';
      } else if (evt.event === 'picked') {
        label = 'Picked';
        color = '#a855f7';
        desc = evt.worker ? `by worker` : '';
      } else if (evt.event === 'started') {
        label = 'Started';
        color = '#3b82f6';
      } else if (evt.event === 'completed') {
        label = 'Completed';
        color = '#10b981';
        desc = evt.durationMs ? `took ${fmtMs(evt.durationMs)}` : '';
      } else if (evt.event === 'failed') {
        label = 'Failed';
        color = '#ef4444';
        desc = evt.durationMs ? `took ${fmtMs(evt.durationMs)}` : '';
      }
      return { label, ts: evt.ts, color, desc };
    });
  } else {
    events = [
      { label: 'Enqueued',    ts: job.timestamp,    color: '#64748b' },
      job.processedOn ? { label: 'Started',   ts: job.processedOn, color: '#3b82f6' } : null,
      job.finishedOn  ? { label: job.state === 'failed' ? 'Failed' : 'Completed', ts: job.finishedOn, color: job.state === 'failed' ? '#ef4444' : '#10b981' } : null,
    ].filter(Boolean) as Array<{ label: string; ts: number; color: string; desc?: string }>;
  }

  if (events.length === 0) return <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No timeline data</div>;

  const start = events[0].ts;
  const end   = events[events.length - 1].ts;
  const total = end - start || 1;

  return (
    <div style={{ padding: '0 2px' }}>
      {/* Waterfall bar */}
      <div style={{ position: 'relative', height: 6, background: 'var(--border)', borderRadius: 3, marginBottom: 16 }}>
        {events.length > 1 && (
          <div style={{
            position: 'absolute',
            left: '0%',
            width: '100%',
            height: '100%',
            background: job.state === 'failed' ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)',
            borderRadius: 3,
          }} />
        )}
      </div>
      {/* Events */}
      {events.map((e, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: e.color, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              {e.label} {e.desc && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 4 }}>({e.desc})</span>}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {fmtFullTimestamp(e.ts)}
            </div>
          </div>
          {i > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              +{fmtMs(e.ts - events[i-1].ts)}
            </div>
          )}
        </div>
      ))}
      {/* Duration summary */}
      {job.duration && (
        <div style={{ padding: '8px 10px', background: 'var(--bg-base)', borderRadius: 3, marginTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>TOTAL DURATION</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: job.state === 'failed' ? '#ef4444' : '#10b981' }}>
            {fmtMs(job.duration)}
          </div>
        </div>
      )}
    </div>
  );
}

export default function JobInspectorPage({ params }: { params: any }) {
  const resolvedParams = (params && typeof params.then === 'function') ? use(params) : params;
  const id = resolvedParams?.id || '';
  const [job, setJob] = useState<any>(null);
  const [workers, setWorkers] = useState<any[]>([]);
  const [actionMessage, setActionMessage] = useState('');
  
  const [isEditing, setIsEditing] = useState(false);
  const [payloadText, setPayloadText] = useState('');

  const loadData = async () => {
    try {
      const res = await getJob(id);
      if (res) {
        setJob(res);
      }
      const rawWorkers = await getWorkers();
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
  }, [id]);

  useEffect(() => {
    if (job && !isEditing) {
      setPayloadText(JSON.stringify(job.data, null, 2));
    }
  }, [job, isEditing]);

  const handleRetry = async () => {
    try {
      setActionMessage('Retrying job...');
      await retryJob(job.queueName, job.id);
      setActionMessage('Job successfully queued for retry');
      setTimeout(() => setActionMessage(''), 2000);
      loadData();
    } catch (err: any) {
      setActionMessage(`Error retrying job: ${err.message}`);
    }
  };

  const handleReplay = async () => {
    try {
      let parsed = null;
      try {
        parsed = JSON.parse(payloadText);
      } catch (e: any) {
        setActionMessage(`Invalid JSON payload: ${e.message}`);
        return;
      }
      setActionMessage('Replaying job with modified payload...');
      const res = await replayJob(job.queueName, job.id, parsed);
      setActionMessage(`Replayed successfully! New Job ID: ${res.newJobId}`);
      setIsEditing(false);
      setTimeout(() => setActionMessage(''), 4000);
      loadData();
    } catch (err: any) {
      setActionMessage(`Error replaying job: ${err.message}`);
    }
  };

  if (!job) {
    return (
      <>
        <Topbar title="Job Inspector" subtitle={id} />
        <div className="page-content" style={{ padding: 48, textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, fontFamily: 'var(--font-mono)' }}>
            Retrieving job detail specs from Redis...
          </div>
        </div>
      </>
    );
  }

  const worker = workers.find((w: any) => w.activeJobId === job.id);
  const isDebuggerEnabled = isFeatureEnabled('PHASE_2_DEBUGGER');

  return (
    <>
      <Topbar title="Job Inspector" subtitle={job.id} />
      <div className="page-content" style={{ padding: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>

        {/* Action feedback banner */}
        {actionMessage && (
          <div style={{
            padding: '8px 16px', background: 'var(--bg-accent)',
            borderBottom: '1px solid var(--accent-cyan)',
            fontSize: 12, fontFamily: 'var(--font-mono)'
          }}>
            System: {actionMessage}
          </div>
        )}

        {/* Top: failed reason banner */}
        {job.failedReason && (
          <div style={{
            padding: '8px 16px', background: 'rgba(239,68,68,0.08)',
            borderBottom: '1px solid rgba(239,68,68,0.3)',
            display: 'flex', alignItems: 'flex-start', gap: 8,
          }}>
            <AlertTriangle size={13} color="#ef4444" style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#ef4444' }}>Failure: </span>
              <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: '#fca5a5' }}>{job.failedReason}</span>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={handleRetry}><RefreshCw size={11} /> Retry Job</button>
            </div>
          </div>
        )}

        {/* Three-column main area */}
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '240px 1fr 280px', overflow: 'hidden' }}>

          {/* LEFT — Metadata */}
          <div style={{ borderRight: '1px solid var(--border)', overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="panel">
              <div className="panel-header"><span className="panel-title">Identity</span></div>
              <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { label: 'Job ID', value: job.id },
                  { label: 'Name', value: job.name },
                  { label: 'Queue', value: job.queueName },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                    <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', marginTop: 2, wordBreak: 'break-all' }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel">
              <div className="panel-header"><span className="panel-title">Status</span></div>
              <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>
                  <span className={`badge ${jobStateBadge(job.state)}`} style={{ fontSize: 12 }}>
                    <span className="badge-dot" style={{ background: jobStateDotColor(job.state) }} />
                    {job.state}
                  </span>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Attempts</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', marginTop: 2,
                    color: job.attempts >= job.maxAttempts ? '#ef4444' : 'var(--text-primary)' }}>
                    {job.attempts} <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>/ {job.maxAttempts}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header"><span className="panel-title">Timestamps</span></div>
              <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { label: 'Created', ts: job.timestamp },
                  job.processedOn ? { label: 'Started', ts: job.processedOn } : null,
                  job.finishedOn  ? { label: 'Finished', ts: job.finishedOn } : null,
                ].filter(Boolean).map(({ label, ts }: any) => (
                  <div key={label}>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                    <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', marginTop: 1 }}>
                      {fmtFullTimestamp(ts)}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }} suppressHydrationWarning>{relativeTime(ts)}</div>
                  </div>
                ))}
                {job.duration && (
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Duration</div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)', marginTop: 2, color: job.duration > 30000 ? '#ef4444' : 'var(--text-primary)' }}>
                      {fmtMs(job.duration)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* CENTER — Payload + bottom logs */}
          <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
              <div className="panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div className="panel-header" style={{ flexShrink: 0 }}>
                  <span className="panel-title"><FileText size={11} style={{ display: 'inline', marginRight: 4 }} />Job Payload</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {isDebuggerEnabled && (
                      isEditing ? (
                        <>
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: '#10b981' }} onClick={handleReplay}>
                            <Play size={10} /> Submit Replay
                          </button>
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: '#ef4444' }} onClick={() => setIsEditing(false)}>
                            <X size={10} /> Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setIsEditing(true)}>
                          <Edit2 size={10} /> Modify & Replay
                        </button>
                      )
                    )}
                  </div>
                </div>
                <div className="panel-body" style={{ flex: 1, overflowY: 'auto' }}>
                  {isEditing ? (
                    <textarea
                      value={payloadText}
                      onChange={(e) => setPayloadText(e.target.value)}
                      style={{
                        width: '100%',
                        height: '100%',
                        minHeight: 250,
                        outline: 'none',
                        resize: 'none',
                        background: '#07090d',
                        border: '1px solid var(--border)',
                        borderRadius: 3,
                        padding: 8,
                        color: '#10b981',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        lineHeight: 1.5,
                      }}
                    />
                  ) : (
                    <div className="json-viewer">
                      <JsonValue value={job.data} depth={0} />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom: Stack trace / logs */}
            <div style={{ height: 260, borderTop: '1px solid var(--border)', padding: 12, overflow: 'hidden', flexShrink: 0, display: 'grid', gridTemplateColumns: job.state === 'failed' ? '1fr 1fr' : '1fr', gap: 12 }}>
              {isDebuggerEnabled ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingBottom: 6, fontWeight: 600 }}>Console Output Logs</div>
                    <div className="terminal" style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
                      {job.logs && job.logs.length > 0 ? (
                        job.logs.map((log: any, idx: number) => (
                          <div key={idx} className="log-line">
                            <span className="log-time" style={{ color: 'var(--text-muted)', marginRight: 6 }}>{new Date(log.ts).toLocaleTimeString()}</span>
                            <span className={`log-info log-${log.level}`} style={{ marginRight: 6, color: log.level === 'error' ? '#ef4444' : log.level === 'warn' ? '#f59e0b' : '#3b82f6' }}>
                              [{log.level.toUpperCase()}]
                            </span>
                            <span>{log.message}</span>
                          </div>
                        ))
                      ) : (
                        <div style={{ color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic', padding: 8 }}>
                          No console log outputs recorded for this job.
                        </div>
                      )}
                    </div>
                  </div>

                  {job.state === 'failed' && (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', gap: 12 }}>
                      {job.stacktrace && job.stacktrace.length > 0 && (
                        <StackTrace frames={job.stacktrace} />
                      )}
                      <SnapshotPanel snapshot={job.snapshot} />
                    </div>
                  )}
                </>
              ) : (
                <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, color: 'var(--text-dim)' }}>
                  <Lock size={16} />
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Logs & Stack Trace is a Phase 2 (Debugger) Feature</span>
                  <span style={{ fontSize: 11, opacity: 0.8 }}>Enable PHASE_2_DEBUGGER in features.ts to unlock</span>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT — Execution timeline + worker */}
          <div style={{ borderLeft: '1px solid var(--border)', overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="panel">
              <div className="panel-header"><span className="panel-title">Execution Timeline</span></div>
              <div className="panel-body">
                {isDebuggerEnabled ? (
                  <ExecutionTimeline job={job} />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '24px 0', color: 'var(--text-dim)', textAlign: 'center' }}>
                    <Lock size={16} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>Waterfall Timeline is a Phase 2 Feature</span>
                  </div>
                )}
              </div>
            </div>

            {worker && (
              <div className="panel">
                <div className="panel-header"><span className="panel-title">Worker</span></div>
                <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: worker.state === 'online' ? '#10b981' : '#ef4444', flexShrink: 0 }} />
                    <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{worker.id}</span>
                  </div>
                  {[
                    { label: 'Hostname', value: worker.hostname },
                    { label: 'PID', value: String(worker.pid) },
                    { label: 'Concurrency', value: String(worker.concurrency) },
                    { label: 'CPU', value: `${worker.cpu}%` },
                    { label: 'Memory', value: `${worker.memory}MB / ${worker.memoryMax}MB` },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{label}</span>
                      <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="panel">
              <div className="panel-header"><span className="panel-title">Job Options</span></div>
              <div className="panel-body">
                <div className="json-viewer" style={{ fontSize: 11 }}>
                  <JsonValue value={job.opts} depth={0} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
