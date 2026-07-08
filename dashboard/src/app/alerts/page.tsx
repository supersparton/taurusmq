'use client';
import { useState, useEffect } from 'react';
import Topbar from '@/components/layout/Topbar';
import { relativeTime } from '@/lib/utils';
import { BellOff, Trash2, AlertTriangle, AlertCircle, Info, PlusCircle, CheckCircle, RefreshCw } from 'lucide-react';
import { getAlertRules, saveAlertRule, deleteAlertRule, getIncidents, getQueues } from '@/lib/api';

export default function AlertsPage() {
  const [rules, setRules] = useState<any[]>([]);
  const [queues, setQueues] = useState<any[]>([]);
  const [firingAlerts, setFiringAlerts] = useState<any[]>([]);
  const [historyAlerts, setHistoryAlerts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Form State
  const [ruleName, setRuleName] = useState('');
  const [selectedQueue, setSelectedQueue] = useState('');
  const [selectedMetric, setSelectedMetric] = useState('failure_rate');
  const [threshold, setThreshold] = useState('');
  const [severity, setSeverity] = useState('critical');
  const [webhook, setWebhook] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function loadData() {
    try {
      const [rList, qList, incList] = await Promise.all([
        getAlertRules(),
        getQueues(),
        getIncidents().catch(() => ({ firing: [], history: [] }))
      ]);
      if (rList) setRules(rList);
      if (qList) {
        setQueues(qList);
        if (qList.length > 0 && !selectedQueue) {
          setSelectedQueue(qList[0].name);
        }
      }
      if (incList) {
        setFiringAlerts(incList.firing || []);
        setHistoryAlerts(incList.history || []);
      }
    } catch (err) {
      console.error('Failed to load alert settings:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, []);

  async function handleAddRule(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!selectedQueue) {
      setFormError('Please select a queue');
      return;
    }
    if (!threshold) {
      setFormError('Please enter a threshold value');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: ruleName || `${selectedMetric} rule on ${selectedQueue}`,
        queue: selectedQueue,
        metric: selectedMetric,
        threshold: parseFloat(threshold),
        severity,
        webhook,
      };

      const res = await saveAlertRule(payload);
      if (res.ok) {
        setRuleName('');
        setThreshold('');
        setWebhook('');
        loadData();
      } else {
        setFormError('Failed to save rule');
      }
    } catch (err: any) {
      setFormError(err.message || 'An error occurred while saving');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteRule(id: string) {
    if (!confirm('Are you sure you want to delete this alert rule?')) return;
    try {
      await deleteAlertRule(id);
      loadData();
    } catch (err) {
      console.error('Failed to delete rule:', err);
    }
  }

  const getMetricLabel = (m: string) => {
    switch (m) {
      case 'failure_rate':
      case 'error_rate':
        return 'Failure Rate';
      case 'waiting':
        return 'Waiting Jobs';
      case 'active':
        return 'Active Jobs';
      case 'latency':
      case 'avg_latency_ms':
        return 'Avg Latency';
      case 'health':
      case 'health_score':
        return 'Health Score';
      default:
        return m;
    }
  };

  const getSeverityBadgeColor = (sev: string) => {
    switch (sev) {
      case 'critical':
        return { bg: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' };
      case 'warning':
        return { bg: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' };
      default:
        return { bg: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' };
    }
  };

  return (
    <>
      <Topbar title="Alerting & Incidents" subtitle={`${firingAlerts.length} firing · ${rules.length} configured rules`} />
      
      <div className="page-content" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        
        {/* Dynamic Firing Banner */}
        {firingAlerts.length > 0 ? (
          <div style={{
            padding: '12px 16px',
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 12
          }}>
            <AlertTriangle size={18} color="#ef4444" style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#ef4444' }}>
                {firingAlerts.length} Firing Alert{firingAlerts.length > 1 ? 's' : ''} Detected
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                Rule metrics are out of acceptable bounds. Evaluate worker health and process logs.
              </div>
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
            <CheckCircle size={16} color="#10b981" />
            All systems operational. No alert thresholds violated.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          
          {/* LEFT COLUMN: Rule Configuration */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            
            {/* Create Rule Form */}
            <div className="panel" style={{ padding: 16 }}>
              <div className="panel-header" style={{ marginBottom: 12 }}>
                <span className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <PlusCircle size={15} /> Create Alert Rule
                </span>
              </div>
              
              <form onSubmit={handleAddRule} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {formError && (
                  <div style={{ fontSize: 11, color: '#ef4444', padding: '6px 8px', background: 'rgba(239,68,68,0.1)', borderRadius: 3 }}>
                    {formError}
                  </div>
                )}
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 4 }}>Rule Name (Optional)</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="e.g. Failure Spike"
                      value={ruleName}
                      onChange={e => setRuleName(e.target.value)}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 4 }}>Select Queue</label>
                    <select
                      className="form-input"
                      value={selectedQueue}
                      onChange={e => setSelectedQueue(e.target.value)}
                      style={{ width: '100%', background: 'var(--bg-base)' }}
                    >
                      {queues.map(q => (
                        <option key={q.name} value={q.name}>{q.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 4 }}>Metric Trigger</label>
                    <select
                      className="form-input"
                      value={selectedMetric}
                      onChange={e => setSelectedMetric(e.target.value)}
                      style={{ width: '100%', background: 'var(--bg-base)' }}
                    >
                      <option value="failure_rate">Failure Rate (%)</option>
                      <option value="waiting">Waiting Job Count</option>
                      <option value="active">Active Job Count</option>
                      <option value="latency">Average Latency (ms)</option>
                      <option value="health">Health Score (0-100)</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 4 }}>
                      Threshold {selectedMetric === 'health' ? '(Below)' : '(Above)'}
                    </label>
                    <input
                      type="number"
                      className="form-input"
                      placeholder={selectedMetric === 'failure_rate' ? 'e.g. 10 (%)' : 'e.g. 500'}
                      value={threshold}
                      onChange={e => setThreshold(e.target.value)}
                      style={{ width: '100%' }}
                      min="0"
                      step="any"
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 4 }}>Severity</label>
                    <select
                      className="form-input"
                      value={severity}
                      onChange={e => setSeverity(e.target.value)}
                      style={{ width: '100%', background: 'var(--bg-base)' }}
                    >
                      <option value="critical">Critical</option>
                      <option value="warning">Warning</option>
                      <option value="info">Info</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 4 }}>Slack Webhook URL (Optional)</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="https://hooks.slack.com/..."
                      value={webhook}
                      onChange={e => setWebhook(e.target.value)}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ width: '100%', padding: '8px 12px', marginTop: 6, fontSize: 12.5 }}
                  disabled={submitting}
                >
                  {submitting ? 'Saving Rule...' : 'Save Alert Rule'}
                </button>
              </form>
            </div>

            {/* List of Configured Rules */}
            <div className="panel" style={{ flex: 1, padding: 16 }}>
              <div className="panel-header" style={{ marginBottom: 12 }}>
                <span className="panel-title">Active Alert Rules ({rules.length})</span>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rules.length === 0 ? (
                  <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                    No alert rules configured. Use the form above to add one.
                  </div>
                ) : (
                  rules.map(rule => {
                    const sb = getSeverityBadgeColor(rule.severity);
                    return (
                      <div key={rule.id} style={{
                        padding: 10,
                        background: 'var(--bg-base)',
                        border: '1px solid var(--border)',
                        borderRadius: 3,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 700 }}>
                              {rule.name}
                            </span>
                            <span style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 2, background: sb.bg, color: sb.color, fontWeight: 700, textTransform: 'uppercase' }}>
                              {rule.severity}
                            </span>
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                            Queue: <span style={{ fontFamily: 'var(--font-mono)' }}>{rule.queue}</span> · Trigger: {getMetricLabel(rule.metric)} {rule.metric === 'health' ? '<' : '>'} {rule.threshold}
                            {rule.metric.includes('rate') ? '%' : (rule.metric.includes('latency') ? 'ms' : '')}
                          </div>
                          {rule.webhook && (
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                              Webhook: {rule.webhook.substring(0, 45)}...
                            </div>
                          )}
                        </div>
                        <button
                          className="btn btn-ghost"
                          onClick={() => handleDeleteRule(rule.id)}
                          style={{ padding: 4, color: '#ef4444' }}
                          title="Delete Rule"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

          </div>

          {/* RIGHT COLUMN: Firing Alerts & History */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            
            {/* Live Firing Alerts */}
            <div className="panel" style={{ padding: 16 }}>
              <div className="panel-header" style={{ marginBottom: 12 }}>
                <span className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 6, color: firingAlerts.length > 0 ? '#ef4444' : 'inherit' }}>
                  <AlertTriangle size={15} /> Firing Violations ({firingAlerts.length})
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {firingAlerts.length === 0 ? (
                  <div style={{ padding: '36px 0', textAlign: 'center', color: '#10b981', fontSize: 12.5 }}>
                    ✓ All metrics are within rules threshold.
                  </div>
                ) : (
                  firingAlerts.map(alert => {
                    const sb = getSeverityBadgeColor(alert.severity);
                    return (
                      <div key={alert.id} style={{
                        padding: 10,
                        background: 'rgba(239, 68, 68, 0.04)',
                        border: '1px solid rgba(239, 68, 68, 0.2)',
                        borderRadius: 3
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 4 }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700 }}>
                            {alert.ruleName}
                          </span>
                          <span style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 2, background: sb.bg, color: sb.color, fontWeight: 700, textTransform: 'uppercase' }}>
                            {alert.severity}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 6 }}>
                          {alert.evidence ? alert.evidence[0] : ''}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10.5, color: 'var(--text-muted)' }}>
                          <span>Queue: {alert.labels?.queue || 'unknown'}</span>
                          <span suppressHydrationWarning>Fired {relativeTime(alert.firedAt)}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Historical Alerts */}
            <div className="panel" style={{ flex: 1, padding: 16 }}>
              <div className="panel-header" style={{ marginBottom: 12 }}>
                <span className="panel-title">Incident History / Resolved</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 400, overflowY: 'auto' }}>
                {historyAlerts.length === 0 ? (
                  <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                    No historical incident records.
                  </div>
                ) : (
                  historyAlerts.slice(0, 15).map((alert, idx) => {
                    const sb = getSeverityBadgeColor(alert.severity);
                    const isResolved = alert.state === 'resolved';
                    return (
                      <div key={alert.id + '-' + idx} style={{
                        padding: 10,
                        background: 'var(--bg-base)',
                        border: '1px solid var(--border)',
                        borderRadius: 3,
                        opacity: isResolved ? 0.75 : 1
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 4 }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700 }}>
                            {alert.ruleName}
                          </span>
                          <span style={{
                            fontSize: 9.5,
                            padding: '1px 5px',
                            borderRadius: 2,
                            background: isResolved ? 'rgba(16,185,129,0.15)' : sb.bg,
                            color: isResolved ? '#10b981' : sb.color,
                            fontWeight: 700,
                            textTransform: 'uppercase'
                          }}>
                            {isResolved ? 'Resolved' : alert.state}
                          </span>
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 4 }}>
                          {alert.evidence ? alert.evidence[0] : ''}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }} suppressHydrationWarning>
                          <span>Fired: {new Date(alert.firedAt).toLocaleTimeString()}</span>
                          {alert.resolvedAt && (
                            <span style={{ color: '#10b981' }}>Resolved: {new Date(alert.resolvedAt).toLocaleTimeString()}</span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

          </div>

        </div>
      </div>
    </>
  );
}
