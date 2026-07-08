'use client';

import { useState, useEffect, useCallback } from 'react';
import Topbar from '@/components/layout/Topbar';
import { getFlowJobs, getJobFlow, FlowJobSummary, FlowNodeDetail } from '@/lib/api';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { GitFork, Search, RefreshCw, Clock, ArrowRight, Play, AlertCircle } from 'lucide-react';
import { relativeTime } from '@/lib/utils';

// Helper to determine node colors based on job state
const stateColors: Record<string, { background: string; border: string; text: string }> = {
  active: { background: '#2563eb', border: '#3b82f6', text: '#ffffff' },
  waiting: { background: '#4b5563', border: '#6b7280', text: '#ffffff' },
  completed: { background: '#16a34a', border: '#22c55e', text: '#ffffff' },
  failed: { background: '#dc2626', border: '#ef4444', text: '#ffffff' },
  blocked: { background: '#d97706', border: '#f59e0b', text: '#ffffff' },
  unknown: { background: '#374151', border: '#4b5563', text: '#ffffff' },
};

export default function FlowPage() {
  const [recentFlows, setRecentFlows] = useState<FlowJobSummary[]>([]);
  const [searchId, setSearchId] = useState('');
  const [selectedJob, setSelectedJob] = useState<FlowNodeDetail['node'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // React Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Track node levels and positioning to layout nodes vertically
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number; level: number }>>({});

  // Fetch recent flow jobs
  const loadRecentFlows = async () => {
    try {
      const data = await getFlowJobs();
      setRecentFlows(data || []);
    } catch (_) {
      // quiet fallback
    }
  };

  useEffect(() => {
    loadRecentFlows();
  }, []);

  // Compute position for new nodes to layout them nicely in columns
  const computeLayout = (
    newNodes: Array<{ id: string; name: string; state: string; label: string }>,
    currentPositions: Record<string, { x: number; y: number; level: number }>,
    originNodeId: string | null,
    relation: 'parent' | 'child' | 'root'
  ) => {
    const nextPositions = { ...currentPositions };

    if (relation === 'root' || !originNodeId || !nextPositions[originNodeId]) {
      // Start root node at level 0, center vertical
      const rootId = newNodes[0].id;
      nextPositions[rootId] = { x: 250, y: 150, level: 0 };
      return nextPositions;
    }

    const origin = nextPositions[originNodeId];
    const level = relation === 'parent' ? origin.level + 1 : origin.level - 1; // parents to the right, children to the left
    const x = 250 + level * 280;

    // Count how many nodes are already at this level to space them vertically
    const levelNodes = Object.values(nextPositions).filter((p) => p.level === level);
    let startY = 50;
    if (levelNodes.length > 0) {
      // Find max y at this level and append below it
      const maxY = Math.max(...levelNodes.map((p) => p.y));
      startY = maxY + 100;
    }

    newNodes.forEach((node, idx) => {
      if (!nextPositions[node.id]) {
        nextPositions[node.id] = {
          x,
          y: startY + idx * 100,
          level,
        };
      }
    });

    return nextPositions;
  };

  // Main loader for a job node flow
  const handleLoadFlow = async (jobId: string) => {
    if (!jobId.trim()) return;
    setLoading(true);
    setError(null);
    setSelectedJob(null);

    try {
      const detail = await getJobFlow(jobId);
      if (!detail || !detail.node) {
        setError('Flow job not found or does not have DAG details.');
        setLoading(false);
        return;
      }

      setSelectedJob(detail.node);

      // Create root node
      const rootId = detail.node.id;
      const rootColors = stateColors[detail.node.state] || stateColors.unknown;
      const rootNode: Node = {
        id: rootId,
        type: 'default',
        data: {
          label: (
            <div style={{ padding: '4px 6px' }}>
              <div style={{ fontWeight: 800, fontSize: 11 }}>{detail.node.name}</div>
              <div style={{ fontSize: 9, opacity: 0.85, fontFamily: 'monospace' }}>{detail.node.id.slice(0, 8)}...</div>
              <span className={`badge badge-${detail.node.state}`} style={{ fontSize: 8, padding: '1px 4px', marginTop: 4, display: 'inline-block' }}>
                {detail.node.state}
              </span>
            </div>
          ),
        },
        position: { x: 250, y: 150 },
        style: {
          background: rootColors.background,
          color: rootColors.text,
          border: `2px solid ${rootColors.border}`,
          borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          minWidth: 150,
        },
      };

      const initialPositions = { [rootId]: { x: 250, y: 150, level: 0 } };
      const nextNodes = [rootNode];
      const nextEdges: Edge[] = [];

      // Add direct parents
      if (detail.parents && detail.parents.length > 0) {
        const parentItems = detail.parents.map((p) => ({
          id: p.id,
          name: p.name,
          state: p.state,
          label: p.name,
        }));
        const updatedPos = computeLayout(parentItems, initialPositions, rootId, 'parent');
        Object.assign(initialPositions, updatedPos);

        detail.parents.forEach((parent) => {
          const colors = stateColors[parent.state] || stateColors.unknown;
          const pos = initialPositions[parent.state] || initialPositions[parent.id] || { x: 530, y: 100 };
          nextNodes.push({
            id: parent.id,
            type: 'default',
            data: {
              label: (
                <div style={{ padding: '4px 6px' }}>
                  <div style={{ fontWeight: 800, fontSize: 11 }}>{parent.name}</div>
                  <span className={`badge badge-${parent.state}`} style={{ fontSize: 8, padding: '1px 4px', marginTop: 4, display: 'inline-block' }}>
                    {parent.state}
                  </span>
                </div>
              ),
            },
            position: pos,
            style: {
              background: colors.background,
              color: colors.text,
              border: `1.5px solid ${colors.border}`,
              borderRadius: 8,
              minWidth: 140,
            },
          });

          // Edge from root (child) to parent
          nextEdges.push({
            id: `edge-${rootId}-${parent.id}`,
            source: rootId,
            target: parent.id,
            animated: parent.state === 'active',
            style: { stroke: 'var(--border)', strokeWidth: 1.5 },
          });
        });
      }

      // Add direct children
      if (detail.children && detail.children.length > 0) {
        const childItems = detail.children.map((c) => ({
          id: c.id,
          name: c.name,
          state: c.state,
          label: c.name,
        }));
        const updatedPos = computeLayout(childItems, initialPositions, rootId, 'child');
        Object.assign(initialPositions, updatedPos);

        detail.children.forEach((child) => {
          const colors = stateColors[child.state] || stateColors.unknown;
          const pos = initialPositions[child.id] || { x: -30, y: 100 };
          nextNodes.push({
            id: child.id,
            type: 'default',
            data: {
              label: (
                <div style={{ padding: '4px 6px' }}>
                  <div style={{ fontWeight: 800, fontSize: 11 }}>{child.name}</div>
                  <span className={`badge badge-${child.state}`} style={{ fontSize: 8, padding: '1px 4px', marginTop: 4, display: 'inline-block' }}>
                    {child.state}
                  </span>
                </div>
              ),
            },
            position: pos,
            style: {
              background: colors.background,
              color: colors.text,
              border: `1.5px solid ${colors.border}`,
              borderRadius: 8,
              minWidth: 140,
            },
          });

          // Edge from child to root (parent)
          nextEdges.push({
            id: `edge-${child.id}-${rootId}`,
            source: child.id,
            target: rootId,
            animated: child.state === 'active',
            style: { stroke: 'var(--border)', strokeWidth: 1.5 },
          });
        });
      }

      setNodePositions(initialPositions);
      setNodes(nextNodes);
      setEdges(nextEdges);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch flow graph');
    } finally {
      setLoading(false);
    }
  };

  // Expand node dynamically on click (lazy load parents/children of the clicked node)
  const handleNodeClick = async (_: any, node: Node) => {
    try {
      const detail = await getJobFlow(node.id);
      if (!detail || !detail.node) return;

      setSelectedJob(detail.node);

      // Lazy expand logic: add missing parent/child nodes
      let positions = { ...nodePositions };
      const currentNodes = [...nodes];
      const currentEdges = [...edges];

      // Parents
      if (detail.parents && detail.parents.length > 0) {
        const parentItems = detail.parents
          .filter((p) => !currentNodes.some((n) => n.id === p.id))
          .map((p) => ({ id: p.id, name: p.name, state: p.state, label: p.name }));

        if (parentItems.length > 0) {
          positions = computeLayout(parentItems, positions, node.id, 'parent');
          detail.parents.forEach((parent) => {
            if (!currentNodes.some((n) => n.id === parent.id)) {
              const colors = stateColors[parent.state] || stateColors.unknown;
              currentNodes.push({
                id: parent.id,
                type: 'default',
                data: {
                  label: (
                    <div style={{ padding: '4px 6px' }}>
                      <div style={{ fontWeight: 800, fontSize: 11 }}>{parent.name}</div>
                      <span className={`badge badge-${parent.state}`} style={{ fontSize: 8, padding: '1px 4px', marginTop: 4, display: 'inline-block' }}>
                        {parent.state}
                      </span>
                    </div>
                  ),
                },
                position: positions[parent.id] || { x: 0, y: 0 },
                style: {
                  background: colors.background,
                  color: colors.text,
                  border: `1.5px solid ${colors.border}`,
                  borderRadius: 8,
                  minWidth: 140,
                },
              });
            }

            const edgeId = `edge-${node.id}-${parent.id}`;
            if (!currentEdges.some((e) => e.id === edgeId)) {
              currentEdges.push({
                id: edgeId,
                source: node.id,
                target: parent.id,
                animated: parent.state === 'active',
                style: { stroke: 'var(--border)', strokeWidth: 1.5 },
              });
            }
          });
        }
      }

      // Children
      if (detail.children && detail.children.length > 0) {
        const childItems = detail.children
          .filter((c) => !currentNodes.some((n) => n.id === c.id))
          .map((c) => ({ id: c.id, name: c.name, state: c.state, label: c.name }));

        if (childItems.length > 0) {
          positions = computeLayout(childItems, positions, node.id, 'child');
          detail.children.forEach((child) => {
            if (!currentNodes.some((n) => n.id === child.id)) {
              const colors = stateColors[child.state] || stateColors.unknown;
              currentNodes.push({
                id: child.id,
                type: 'default',
                data: {
                  label: (
                    <div style={{ padding: '4px 6px' }}>
                      <div style={{ fontWeight: 800, fontSize: 11 }}>{child.name}</div>
                      <span className={`badge badge-${child.state}`} style={{ fontSize: 8, padding: '1px 4px', marginTop: 4, display: 'inline-block' }}>
                        {child.state}
                      </span>
                    </div>
                  ),
                },
                position: positions[child.id] || { x: 0, y: 0 },
                style: {
                  background: colors.background,
                  color: colors.text,
                  border: `1.5px solid ${colors.border}`,
                  borderRadius: 8,
                  minWidth: 140,
                },
              });
            }

            const edgeId = `edge-${child.id}-${node.id}`;
            if (!currentEdges.some((e) => e.id === edgeId)) {
              currentEdges.push({
                id: edgeId,
                source: child.id,
                target: node.id,
                animated: child.state === 'active',
                style: { stroke: 'var(--border)', strokeWidth: 1.5 },
              });
            }
          });
        }
      }

      setNodePositions(positions);
      setNodes(currentNodes);
      setEdges(currentEdges);
    } catch (_) {
      // quiet fallback
    }
  };

  return (
    <>
      <Topbar title="Flow Visualization" subtitle="Inspect parent-child DAG relations, expand nodes, and trace blockages" />
      <div className="page-content" style={{ display: 'grid', gridTemplateColumns: '320px 1fr', height: 'calc(100vh - 56px)' }}>
        
        {/* Left Control Panel */}
        <div style={{ borderRight: '1px solid var(--border)', background: 'var(--bg-panel)', padding: 16, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
          
          {/* Search Box */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>
              Query Job ID
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Search size={14} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  placeholder="Paste Job UUID..."
                  value={searchId}
                  onChange={(e) => setSearchId(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 8px 6px 28px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-primary)',
                    fontSize: 12.5,
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleLoadFlow(searchId)}
                />
              </div>
              <button
                onClick={() => handleLoadFlow(searchId)}
                style={{
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  padding: '0 10px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                Go
              </button>
            </div>
          </div>

          {/* Active Flow Selector */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 180 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                Recent Active Flows
              </span>
              <button
                onClick={loadRecentFlows}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}
              >
                <RefreshCw size={11} /> Refresh
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1 }}>
              {recentFlows.length === 0 ? (
                <div style={{ padding: '24px 0', textTransform: 'uppercase', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, border: '1px dashed var(--border)', borderRadius: 8 }}>
                  No Flow Jobs Found
                </div>
              ) : (
                recentFlows.map((flow) => (
                  <button
                    key={flow.id}
                    onClick={() => {
                      setSearchId(flow.id);
                      handleLoadFlow(flow.id);
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: 6,
                      border: searchId === flow.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                      background: searchId === flow.id ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg-card)',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                      <span style={{ fontWeight: 800, fontSize: 12, color: 'var(--text-primary)' }}>{flow.name}</span>
                      <span className={`badge badge-${flow.state}`} style={{ fontSize: 8 }}>{flow.state}</span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                      ID: {flow.id.slice(0, 8)}...
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Clock size={10} /> {relativeTime(flow.timestamp)}
                      </span>
                      <span>{flow.childrenCount} children</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right Canvas / Workspace */}
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
          
          {loading && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <RefreshCw size={20} className="animate-spin" style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 14, color: '#fff', fontWeight: 600 }}>Loading flow map...</span>
            </div>
          )}

          {error && (
            <div style={{ margin: 16, padding: '10px 14px', borderRadius: 6, background: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', color: '#ef4444', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          )}

          {nodes.length === 0 ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--text-muted)' }}>
              <GitFork size={48} style={{ opacity: 0.3 }} />
              <div style={{ textAlign: 'center' }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Visual Flow Explorer</h3>
                <p style={{ fontSize: 12, maxWidth: 300 }}>Search a Job ID or select a recent flow to display parent-child tree relationships.</p>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, position: 'relative' }}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={handleNodeClick}
                fitView
              >
                <Background color="var(--border)" gap={16} size={1} />
                <Controls style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 6 }} />
                <MiniMap style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)' }} nodeStrokeColor="var(--border)" nodeColor={() => 'var(--bg-card)'} />
              </ReactFlow>
              
              <div style={{ position: 'absolute', bottom: 12, left: 12, background: 'var(--bg-panel)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 6, fontSize: 10, color: 'var(--text-muted)', display: 'flex', gap: 12 }}>
                <span>💡 Click node to lazy expand relations</span>
                <span>◀ Children (Dependencies)</span>
                <span>▶ Parents (Unblocked next)</span>
              </div>
            </div>
          )}

          {/* Job Details Drawer */}
          {selectedJob && (
            <div style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 320,
              height: '100%',
              background: 'var(--bg-panel)',
              borderLeft: '1px solid var(--border)',
              boxShadow: '-4px 0 20px rgba(0,0,0,0.15)',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 5,
            }}>
              <div style={{ padding: 12, borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' }}>Job Metadata</span>
                <button
                  onClick={() => setSelectedJob(null)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14 }}
                >
                  ✕
                </button>
              </div>
              <div style={{ padding: 12, flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Job Name</label>
                  <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>{selectedJob.name}</div>
                </div>
                <div>
                  <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Job ID</label>
                  <div style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all', color: 'var(--text-muted)' }}>{selectedJob.id}</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Queue</label>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{selectedJob.queueName}</div>
                  </div>
                  <div>
                    <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>State</label>
                    <div>
                      <span className={`badge badge-${selectedJob.state}`}>{selectedJob.state}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Attempts</label>
                    <div style={{ fontSize: 12 }}>{selectedJob.attempts} / {selectedJob.maxAttempts}</div>
                  </div>
                  <div>
                    <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Created</label>
                    <div style={{ fontSize: 11 }}>{new Date(selectedJob.timestamp).toLocaleString()}</div>
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Input Data</label>
                  <pre style={{
                    margin: 0,
                    padding: 8,
                    borderRadius: 6,
                    background: 'var(--bg-card)',
                    color: '#a9b1d6',
                    fontFamily: 'monospace',
                    fontSize: 10.5,
                    overflowX: 'auto',
                    maxHeight: 180,
                    border: '1px solid var(--border)',
                  }}>
                    {JSON.stringify(selectedJob.data, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
