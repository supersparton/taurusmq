'use client';
import { useEffect, useRef, useState } from 'react';
import Topbar from '@/components/layout/Topbar';
import { EVENTS } from '@/lib/mockData';
import { fmtTimestamp, eventTypeColor } from '@/lib/utils';
import { Pause, Play, Download, Filter } from 'lucide-react';
import type { EventStreamItem } from '@/lib/types';
import { isFeatureEnabled } from '@/lib/features';
import FeatureLocked from '@/components/layout/FeatureLocked';

// Simulate incoming events by cycling through mock data
function useEventStream(paused: boolean) {
  const [events, setEvents] = useState<EventStreamItem[]>([...EVENTS]);
  const idx = useRef(0);

  useEffect(() => {
    if (paused) return;
    const templates = EVENTS;
    const id = setInterval(() => {
      const base = templates[idx.current % templates.length];
      const newEvent: EventStreamItem = {
        ...base,
        id: `ev_live_${Date.now()}`,
        ts: Date.now(),
      };
      idx.current++;
      setEvents(prev => [newEvent, ...prev].slice(0, 200));
    }, 2000 + Math.random() * 3000);
    return () => clearInterval(id);
  }, [paused]);

  return events;
}

const TYPE_LABEL: Record<string, string> = {
  job_added:          'JOB_ADDED',
  job_started:        'JOB_STARTED',
  job_completed:      'JOB_COMPLETED',
  job_failed:         'JOB_FAILED',
  job_retried:        'JOB_RETRIED',
  worker_connected:   'WORKER_CONNECTED',
  worker_disconnected:'WORKER_DISCONNECTED',
  queue_paused:       'QUEUE_PAUSED',
  queue_resumed:      'QUEUE_RESUMED',
  alert_fired:        'ALERT_FIRED',
};

export default function StreamPage() {
  const enabled = isFeatureEnabled('PHASE_2_DEBUGGER');

  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const events = useEventStream(paused);

  const filtered = filter
    ? events.filter(e => e.message.toLowerCase().includes(filter.toLowerCase()) || e.queueName.includes(filter))
    : events;

  if (!enabled) {
    return (
      <>
        <Topbar title="Real-Time Event Stream" subtitle="Live lifecycle event logs" />
        <FeatureLocked featureName="Real-Time Event Stream" phase="Phase 2" />
      </>
    );
  }

  return (
    <>
      <Topbar title="Real-Time Event Stream" subtitle="Live job lifecycle events" />
      <div className="page-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>


        {/* Controls bar */}
        <div style={{
          padding: '8px 14px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'var(--bg-surface)', flexShrink: 0,
        }}>
          <button onClick={() => setPaused(p => !p)} className={`btn ${paused ? 'btn-primary' : 'btn-ghost'}`}>
            {paused ? <><Play size={11} /> Resume</> : <><Pause size={11} /> Pause</>}
          </button>

          {!paused && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="live-dot" />
              <span style={{ fontSize: 11, color: 'var(--accent-green)', fontWeight: 600 }}>STREAMING</span>
            </div>
          )}

          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 3, padding: '3px 8px' }}>
            <Filter size={11} color="var(--text-muted)" />
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter by queue, message, job ID…"
              style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 12, flex: 1, fontFamily: 'var(--font-mono)' }}
            />
          </div>

          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {filtered.length} events
          </span>

          <button className="btn btn-ghost" style={{ fontSize: 11 }}>
            <Download size={11} /> Export
          </button>
        </div>

        {/* Event stream — Better Stack log tailing pattern */}
        <div className="terminal" style={{
          flex: 1, borderRadius: 0, border: 'none',
          borderTop: '1px solid var(--border)',
          overflowY: 'auto', padding: '8px 0',
        }}>
          {filtered.map((ev, i) => {
            const color = eventTypeColor(ev.type);
            const isAlert = ev.type === 'alert_fired';
            return (
              <div key={ev.id} className="log-line" style={{
                padding: '3px 14px',
                background: isAlert ? 'rgba(239,68,68,0.04)' : i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                borderLeft: isAlert ? '2px solid rgba(239,68,68,0.5)' : '2px solid transparent',
                alignItems: 'center',
              }}>
                <span className="log-time" style={{ width: 80, flexShrink: 0 }}>
                  {fmtTimestamp(ev.ts)}
                </span>
                <span style={{
                  width: 170, flexShrink: 0,
                  fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em',
                  color, background: `${color}18`, borderRadius: 2,
                  padding: '1px 5px', textAlign: 'center',
                }}>
                  {TYPE_LABEL[ev.type] ?? ev.type.toUpperCase()}
                </span>
                <span style={{
                  width: 140, flexShrink: 0, fontSize: 10.5,
                  color: 'var(--accent-blue)', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {ev.queueName}
                </span>
                <span style={{ flex: 1, fontSize: 12, color: isAlert ? '#fca5a5' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ev.message}
                </span>
                {ev.jobId && (
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0, marginLeft: 8 }}>
                    {ev.jobId}
                  </span>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>
    </>
  );
}
