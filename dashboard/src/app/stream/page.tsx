'use client';
import { useEffect, useRef, useState } from 'react';
import Topbar from '@/components/layout/Topbar';
import { getEvents } from '@/lib/api';
import { fmtTimestamp, eventTypeColor } from '@/lib/utils';
import { Pause, Play, Download, Filter } from 'lucide-react';
import type { EventStreamItem } from '@/lib/types';
import { isFeatureEnabled } from '@/lib/features';
import FeatureLocked from '@/components/layout/FeatureLocked';

function useEventStream(paused: boolean) {
  const [events, setEvents] = useState<EventStreamItem[]>([]);

  useEffect(() => {
    let active = true;
    
    const fetchEvents = async () => {
      if (paused) return;
      try {
        const list = await getEvents(Date.now() - 3600000, Date.now(), 200);
        if (active && list) {
          const sorted = [...list].sort((a, b) => b.ts - a.ts);
          setEvents(sorted);
        }
      } catch (err) {
        // quiet fallback
      }
    };

    fetchEvents();
    const id = setInterval(fetchEvents, 2500);

    return () => {
      active = false;
      clearInterval(id);
    };
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

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const filtered = filter
    ? events.filter(e => {
        const msg = (e.message || '').toLowerCase();
        const qName = (e.queueName || '').toLowerCase();
        const jId = (e.jobId || '').toLowerCase();
        const term = filter.toLowerCase();
        return msg.includes(term) || qName.includes(term) || jId.includes(term);
      })
    : events;

  // Reset page when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filter]);

  // Compute pagination parameters
  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginatedEvents = filtered.slice(startIndex, endIndex);

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

          {/* Pagination Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button
              disabled={currentPage === 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              className="btn btn-ghost"
              style={{
                padding: '3px 8px',
                fontSize: 10.5,
                opacity: currentPage === 1 ? 0.4 : 1,
                cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
              }}
            >
              Prev
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {currentPage}/{totalPages} ({totalItems} total)
            </span>
            <button
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              className="btn btn-ghost"
              style={{
                padding: '3px 8px',
                fontSize: 10.5,
                opacity: currentPage === totalPages ? 0.4 : 1,
                cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
              }}
            >
              Next
            </button>
            <select
              value={pageSize}
              onChange={e => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                color: 'var(--text-primary)',
                padding: '2px 4px',
                fontSize: 10.5,
                outline: 'none',
              }}
            >
              {[25, 50, 100, 200].map(sz => (
                <option key={sz} value={sz}>{sz}/p</option>
              ))}
            </select>
          </div>

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
          {paginatedEvents.map((ev, i) => {
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
