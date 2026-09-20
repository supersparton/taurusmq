'use client';

// Same-origin live updates over the API's WebSocket stream.
// The API pushes {type:'snapshot', metrics, incidents, workers} on connect
// and {type:'event', event} for job completions/failures and heartbeats.
// Progressive enhancement: pages keep their polling loop, so a dead socket
// can never blank the dashboard — it only makes updates instant while open.

import { useEffect, useRef, useState } from 'react';

export interface LiveSnapshot {
  metrics: any[];
  incidents: { firing: any[]; history: any[] };
  workers: any[];
}

export function useLiveUpdates(
  onSnapshot: (snap: LiveSnapshot) => void,
  onEvent?: (event: any) => void,
): boolean {
  const [live, setLive] = useState(false);
  const snapRef = useRef(onSnapshot);
  snapRef.current = onSnapshot;
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      // Same-origin: Next rewrites /ws → observability API (see next.config.ts)
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    } catch {
      setLive(false);
      return;
    }
    ws.onopen = () => { if (!closed) setLive(true); };
    ws.onclose = () => { if (!closed) setLive(false); };
    ws.onerror = () => { try { ws?.close(); } catch { /* handled by onclose */ } };
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'snapshot') snapRef.current?.(data);
        else if (data.type === 'event') eventRef.current?.(data.event);
      } catch {
        // Malformed push frame — polling loop remains source of truth
      }
    };
    return () => {
      closed = true;
      try { ws?.close(); } catch { /* noop */ }
    };
  }, []);

  return live;
}
