'use client';
import Topbar from '@/components/layout/Topbar';
import { FLOW_NODES } from '@/lib/mockData';
import { fmtMs } from '@/lib/utils';
import type { JobState } from '@/lib/types';
import { isFeatureEnabled } from '@/lib/features';
import FeatureLocked from '@/components/layout/FeatureLocked';


const STATE_COLOR: Record<JobState, string> = {
  completed: '#10b981',
  active:    '#3b82f6',
  waiting:   '#64748b',
  delayed:   '#f59e0b',
  failed:    '#ef4444',
  paused:    '#f97316',
};

const STATE_BG: Record<JobState, string> = {
  completed: 'rgba(16,185,129,0.12)',
  active:    'rgba(59,130,246,0.12)',
  waiting:   'rgba(100,116,139,0.1)',
  delayed:   'rgba(245,158,11,0.12)',
  failed:    'rgba(239,68,68,0.12)',
  paused:    'rgba(249,115,22,0.12)',
};

// Positions for a horizontal left-to-right DAG layout
const POSITIONS: Record<string, { x: number; y: number }> = {
  fn_1: { x: 40,  y: 200 },
  fn_2: { x: 220, y: 100 },
  fn_3: { x: 220, y: 300 },
  fn_4: { x: 420, y: 200 },
  fn_5: { x: 600, y: 100 },
  fn_6: { x: 600, y: 300 },
  fn_7: { x: 800, y: 200 },
};

const NODE_W = 150;
const NODE_H = 60;

function Arrow({ from, to, critical }: { from: string; to: string; critical: boolean }) {
  const f = POSITIONS[from];
  const t = POSITIONS[to];
  if (!f || !t) return null;
  const x1 = f.x + NODE_W;
  const y1 = f.y + NODE_H / 2;
  const x2 = t.x;
  const y2 = t.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return (
    <path
      d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
      fill="none"
      stroke={critical ? '#3b82f6' : '#374151'}
      strokeWidth={critical ? 2 : 1.5}
      strokeDasharray={critical ? undefined : '4 3'}
      markerEnd="url(#arrowhead)"
    />
  );
}

export default function FlowPage() {
  const enabled = isFeatureEnabled('PHASE_5_FLOW_VISUALIZATION');

  const selectedNode = FLOW_NODES.find(n => n.state === 'active') ?? FLOW_NODES[0];
  const totalDuration = FLOW_NODES
    .filter(n => n.duration)
    .reduce((a, n) => a + (n.duration ?? 0), 0);

  // Build edges
  const edges: Array<{ from: string; to: string; critical: boolean }> = [];
  FLOW_NODES.forEach(node => {
    node.childIds.forEach(childId => {
      const child = FLOW_NODES.find(n => n.id === childId);
      edges.push({ from: node.id, to: childId, critical: node.isCriticalPath && (child?.isCriticalPath ?? false) });
    });
  });

  const svgW = 1000;
  const svgH = 440;

  if (!enabled) {
    return (
      <>
        <Topbar title="Flow Visualization" subtitle="DAG dependency graph" />
        <FeatureLocked featureName="Flow Visualizer" phase="Phase 5" />
      </>
    );
  }

  return (
    <>
      <Topbar title="Flow Visualization" subtitle="DAG dependency graph · report-generation-flow-001" />
      <div className="page-content" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>

        {/* DAG canvas */}
        <div className="panel" style={{ flex: 1, overflow: 'hidden' }}>
          <div className="panel-header">
            <span className="panel-title">Dependency Graph — Airflow DAG View</span>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {Object.entries(STATE_COLOR).map(([state, color]) => (
                <div key={state} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 1, background: color }} />
                  <span style={{ color: 'var(--text-muted)', textTransform: 'capitalize' }}>{state}</span>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#3b82f6" strokeWidth="2" /></svg>
                <span style={{ color: 'var(--text-muted)' }}>Critical Path</span>
              </div>
            </div>
          </div>
          <div style={{ overflowX: 'auto', overflowY: 'auto', height: 'calc(100% - 36px)' }}>
            <svg width={svgW} height={svgH} style={{ minWidth: svgW }}>
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="#374151" />
                </marker>
              </defs>

              {/* Edges */}
              {edges.map((e, i) => <Arrow key={i} {...e} />)}

              {/* Nodes */}
              {FLOW_NODES.map(node => {
                const pos = POSITIONS[node.id];
                if (!pos) return null;
                const color = STATE_COLOR[node.state];
                const bg    = STATE_BG[node.state];
                return (
                  <g key={node.id} transform={`translate(${pos.x},${pos.y})`} style={{ cursor: 'pointer' }}>
                    {/* Critical path highlight */}
                    {node.isCriticalPath && (
                      <rect x={-2} y={-2} width={NODE_W + 4} height={NODE_H + 4}
                        rx={5} fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeOpacity={0.4} strokeDasharray="4 3" />
                    )}
                    <rect x={0} y={0} width={NODE_W} height={NODE_H} rx={4}
                      fill={bg} stroke={color} strokeWidth={1.5} />
                    {/* Animated border for active */}
                    {node.state === 'active' && (
                      <rect x={0} y={0} width={NODE_W} height={NODE_H} rx={4}
                        fill="none" stroke={color} strokeWidth={2} opacity={0.5}>
                        <animate attributeName="opacity" values="0.5;1;0.5" dur="1.5s" repeatCount="indefinite" />
                      </rect>
                    )}
                    <text x={NODE_W / 2} y={22} textAnchor="middle" fill="var(--text-primary)" fontSize={11.5} fontWeight={600} fontFamily="var(--font-mono)">
                      {node.name.length > 18 ? node.name.slice(0, 16) + '…' : node.name}
                    </text>
                    <text x={NODE_W / 2} y={38} textAnchor="middle" fill={color} fontSize={10} fontFamily="sans-serif" fontWeight={600}>
                      {node.state.toUpperCase()}
                    </text>
                    {node.duration && (
                      <text x={NODE_W / 2} y={52} textAnchor="middle" fill="var(--text-muted)" fontSize={9.5} fontFamily="monospace">
                        {fmtMs(node.duration)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Gantt chart / execution durations */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Execution Timeline — Critical Path Gantt</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Total: {fmtMs(totalDuration)} · Critical path highlighted</span>
          </div>
          <div style={{ padding: '10px 14px' }}>
            {FLOW_NODES.filter(n => n.startedAt).map(node => {
              const start = FLOW_NODES.filter(n => n.startedAt).reduce((min, n) => Math.min(min, n.startedAt!), Infinity);
              const total = totalDuration;
              const offsetPct = ((node.startedAt! - start) / total) * 100;
              const widthPct  = node.duration ? (node.duration / total) * 100 : 3;
              const color = STATE_COLOR[node.state];
              return (
                <div key={node.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div style={{ width: 140, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', textAlign: 'right', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {node.name}
                  </div>
                  <div style={{ flex: 1, height: 18, background: 'var(--bg-base)', borderRadius: 2, position: 'relative', overflow: 'hidden' }}>
                    <div style={{
                      position: 'absolute', left: `${offsetPct}%`, width: `${Math.max(widthPct, 1.5)}%`,
                      height: '100%', background: color, opacity: 0.8, borderRadius: 2,
                      display: 'flex', alignItems: 'center', paddingLeft: 4,
                    }}>
                      {node.duration && widthPct > 8 && (
                        <span style={{ fontSize: 9.5, color: '#000', fontFamily: 'monospace', fontWeight: 600 }}>
                          {fmtMs(node.duration)}
                        </span>
                      )}
                    </div>
                    {node.isCriticalPath && (
                      <div style={{ position: 'absolute', right: 0, top: 0, height: '100%', width: 2, background: '#3b82f6', opacity: 0.5 }} />
                    )}
                  </div>
                  <div style={{ width: 50, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textAlign: 'right', flexShrink: 0 }}>
                    {node.duration ? fmtMs(node.duration) : '…'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
