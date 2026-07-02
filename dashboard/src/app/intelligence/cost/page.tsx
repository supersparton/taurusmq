'use client';
import Topbar from '@/components/layout/Topbar';
import { QUEUE_COSTS } from '@/lib/intelligence';
import { isFeatureEnabled } from '@/lib/features';
import FeatureLocked from '@/components/layout/FeatureLocked';

export default function CostAnalyticsPage() {
  const enabled = isFeatureEnabled('PHASE_4_ANALYTICS');

  const totalCost  = QUEUE_COSTS.reduce((a, q) => a + q.estimatedCostUSD, 0);
  const totalWaste = QUEUE_COSTS.reduce((a, q) => a + q.wastedCostUSD, 0);
  const totalJobs  = QUEUE_COSTS.reduce((a, q) => a + q.jobsToday, 0);
  const overallWastePct = totalWaste / (totalCost + totalWaste) * 100;

  const sorted = [...QUEUE_COSTS].sort((a, b) => (b.estimatedCostUSD + b.wastedCostUSD) - (a.estimatedCostUSD + a.wastedCostUSD));

  if (!enabled) {
    return (
      <>
        <Topbar title="Queue Cost Analytics" subtitle="Compute cost per queue" />
        <FeatureLocked featureName="Cost Analytics" phase="Phase 4" />
      </>
    );
  }

  return (
    <>
      <Topbar title="Queue Cost Analytics" subtitle="Compute cost per queue · Today" />
      <div className="page-content" style={{ padding: 12 }}>


        {/* Summary row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 }}>
          {[
            { label: 'Total Compute Cost', value: `$${(totalCost + totalWaste).toFixed(2)}`, color: 'var(--text-primary)' },
            { label: 'Wasted Cost',        value: `$${totalWaste.toFixed(2)}`,               color: '#ef4444' },
            { label: 'Waste %',            value: `${overallWastePct.toFixed(1)}%`,          color: overallWastePct > 30 ? '#ef4444' : '#f59e0b' },
            { label: 'Total Jobs Today',   value: totalJobs.toLocaleString(),                color: 'var(--text-primary)' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div className="stat-label">{s.label}</div>
              <div className="stat-value" style={{ fontSize: 24, color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Alert: wasted cost callout */}
        {totalWaste > 1 && (
          <div style={{
            marginBottom: 10, padding: '9px 14px',
            background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 4,
          }}>
            <span style={{ fontSize: 12.5, color: '#ef4444', fontWeight: 700 }}>Cost Alert: </span>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              ${totalWaste.toFixed(2)} ({overallWastePct.toFixed(1)}%) of today&apos;s compute spend produced no value.
              The image-processing OOM cascade accounts for ${QUEUE_COSTS.find(q=>q.queueName==='image-processing')?.wastedCostUSD.toFixed(2)} of that waste.
              Fixing worker memory would recover ~68% of wasted spend.
            </span>
          </div>
        )}

        {/* Queue cost table */}
        <div className="panel" style={{ marginBottom: 10 }}>
          <div className="panel-header">
            <span className="panel-title">Cost Breakdown by Queue</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>EC2 compute estimate · today</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Queue</th>
                  <th>Jobs Today</th>
                  <th>Failed</th>
                  <th>Compute Cost</th>
                  <th>Wasted Cost</th>
                  <th>Waste %</th>
                  <th>Cost / Successful Job</th>
                  <th>Waste Breakdown</th>
                  <th>Top Cost Driver</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(q => {
                  const totalQ = q.estimatedCostUSD + q.wastedCostUSD;
                  const wastePct = q.wastePercent;
                  const usedPct  = 100 - wastePct;
                  return (
                    <tr key={q.queueName}>
                      <td>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>{q.queueName}</span>
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{q.jobsToday.toLocaleString()}</td>
                      <td style={{ color: q.failedJobs > 100 ? '#ef4444' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                        {q.failedJobs.toLocaleString()}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
                        ${totalQ.toFixed(2)}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', color: q.wastedCostUSD > 1 ? '#ef4444' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                        ${q.wastedCostUSD.toFixed(2)}
                      </td>
                      <td>
                        <span style={{ color: wastePct > 50 ? '#ef4444' : wastePct > 15 ? '#f59e0b' : '#10b981', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                          {wastePct.toFixed(1)}%
                        </span>
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>
                        {q.costPerSuccessfulJob > 0 ? `$${q.costPerSuccessfulJob.toFixed(6)}` : '—'}
                      </td>
                      <td style={{ minWidth: 120 }}>
                        <div className="waste-bar" style={{ marginBottom: 2 }}>
                          <div className="waste-used"   style={{ width: `${usedPct}%` }} />
                          <div className="waste-wasted" style={{ width: `${wastePct}%` }} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--text-dim)' }}>
                          <span style={{ color: '#10b981' }}>{usedPct.toFixed(0)}% used</span>
                          <span style={{ color: '#ef4444' }}>{wastePct.toFixed(0)}% waste</span>
                        </div>
                      </td>
                      <td style={{ maxWidth: 200, fontSize: 11, color: 'var(--text-muted)' }}>
                        {q.topCostDriver}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Per-queue cost narrative */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {sorted.filter(q => q.wastePercent > 10).map(q => (
            <div key={q.queueName} className="panel" style={{ borderLeft: `3px solid ${q.wastePercent > 50 ? '#ef4444' : '#f59e0b'}` }}>
              <div className="panel-header">
                <span className="panel-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{q.queueName}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: q.wastePercent > 50 ? '#ef4444' : '#f59e0b', fontFamily: 'var(--font-mono)' }}>
                  {q.wastePercent.toFixed(0)}% waste
                </span>
              </div>
              <div className="panel-body" style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <div style={{ marginBottom: 6, color: 'var(--text-primary)' }}>
                  ${q.wastedCostUSD.toFixed(2)} wasted out of ${(q.estimatedCostUSD + q.wastedCostUSD).toFixed(2)} total today
                </div>
                {q.topCostDriver}
                {q.wastedCostUSD > 0.1 && (
                  <div style={{ marginTop: 8, padding: '6px 9px', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 3, fontSize: 11, color: '#10b981' }}>
                    ↑ Fix root cause to recover ${q.wastedCostUSD.toFixed(2)}/day in wasted spend
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
