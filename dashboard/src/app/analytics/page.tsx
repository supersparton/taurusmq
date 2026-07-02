'use client';
import Topbar from '@/components/layout/Topbar';
import { throughputSeries, latencySeries, errorSeries, p50Series, p95Series, p99Series, successSeries, retrySeries, queueDepthSeries } from '@/lib/mockData';
import { fmtMs, fmtNum, fmtPercent } from '@/lib/utils';
import { AreaSeries, MultiLine } from '@/components/charts/ChartPrimitives';
import { isFeatureEnabled } from '@/lib/features';
import FeatureLocked from '@/components/layout/FeatureLocked';

// Build merged percentile dataset
const pctData = p50Series.map((p, i) => ({
  t: p.t,
  p50: p.v,
  p95: p95Series[i]?.v ?? 0,
  p99: p99Series[i]?.v ?? 0,
}));

const successErrorData = successSeries.map((s, i) => ({
  t: s.t,
  success: s.v,
  retry: retrySeries[i]?.v ?? 0,
}));

function AnalyticsPanel({ title, annotation, children }: { title: string; annotation?: string; children: React.ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        {annotation && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{annotation}</span>}
      </div>
      <div style={{ padding: '6px 10px 8px' }}>{children}</div>
    </div>
  );
}

export default function AnalyticsPage() {
  const enabled = isFeatureEnabled('PHASE_4_ANALYTICS');

  const latestThroughput = throughputSeries[throughputSeries.length - 1]?.v ?? 0;
  const latestLatency    = latencySeries[latencySeries.length - 1]?.v ?? 0;
  const latestError      = errorSeries[errorSeries.length - 1]?.v ?? 0;
  const latestP99        = p99Series[p99Series.length - 1]?.v ?? 0;
  const latestDepth      = queueDepthSeries[queueDepthSeries.length - 1]?.v ?? 0;
  const latestSuccess    = successSeries[successSeries.length - 1]?.v ?? 0;

  if (!enabled) {
    return (
      <>
        <Topbar title="Analytics" subtitle="Aggregated metrics" />
        <FeatureLocked featureName="Analytics Dashboard" phase="Phase 4" />
      </>
    );
  }

  return (
    <>
      <Topbar title="Analytics" subtitle="Aggregated metrics · last 1h" />
      <div className="page-content" style={{ padding: 12 }}>


        {/* Golden Signals strip — New Relic pattern */}
        <div className="grid-12" style={{ marginBottom: 8 }}>
          {[
            { label: 'Throughput',   value: `${latestThroughput.toFixed(0)}/min`, color: '#06b6d4', sub: 'Traffic' },
            { label: 'Avg Latency',  value: fmtMs(latestLatency),                color: latestLatency > 2000 ? '#ef4444' : '#10b981', sub: 'Latency' },
            { label: 'Error Rate',   value: `${latestError.toFixed(1)}%`,          color: latestError > 10 ? '#ef4444' : '#10b981', sub: 'Errors' },
            { label: 'Queue Depth',  value: fmtNum(latestDepth),                  color: '#8b5cf6', sub: 'Saturation' },
            { label: 'P99 Latency',  value: fmtMs(latestP99),                    color: latestP99 > 5000 ? '#ef4444' : '#f59e0b', sub: 'Tail latency' },
            { label: 'Success Rate', value: `${latestSuccess.toFixed(1)}%`,       color: '#10b981', sub: '' },
          ].map(s => (
            <div key={s.label} className="stat-card col-2">
              <div style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#374151' }}>{s.sub}</div>
              <div className="stat-label">{s.label}</div>
              <div className="stat-value" style={{ fontSize: 22, color: s.color }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Charts grid */}
        <div className="grid-12" style={{ marginBottom: 8 }}>
          <div className="col-6">
            <AnalyticsPanel title="Throughput — Jobs/min" annotation="All queues">
              <AreaSeries data={throughputSeries} color="#06b6d4" name="jobs/min" height={140} formatter={v => `${v.toFixed(0)}/min`} />
            </AnalyticsPanel>
          </div>
          <div className="col-6">
            <AnalyticsPanel title="Error Rate %" annotation="SLA: 5%">
              <AreaSeries data={errorSeries} color="#ef4444" name="% errors" height={140} formatter={v => `${v.toFixed(1)}%`} threshold={5} thresholdLabel="SLA 5%" />
            </AnalyticsPanel>
          </div>
        </div>

        <div className="grid-12" style={{ marginBottom: 8 }}>
          <div className="col-8">
            <AnalyticsPanel title="Latency Percentiles — P50 / P95 / P99" annotation="Higher = worse">
              <MultiLine
                data={pctData}
                series={[
                  { key: 'p50', color: '#10b981', name: 'P50' },
                  { key: 'p95', color: '#f59e0b', name: 'P95' },
                  { key: 'p99', color: '#ef4444', name: 'P99' },
                ]}
                height={160}
                formatter={fmtMs}
              />
              <div style={{ display: 'flex', gap: 16, marginTop: 6, paddingLeft: 8 }}>
                {[
                  { label: 'P50', value: fmtMs(p50Series[p50Series.length-1]?.v ?? 0), color: '#10b981' },
                  { label: 'P95', value: fmtMs(p95Series[p95Series.length-1]?.v ?? 0), color: '#f59e0b' },
                  { label: 'P99', value: fmtMs(p99Series[p99Series.length-1]?.v ?? 0), color: '#ef4444' },
                ].map(p => (
                  <div key={p.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color }} />
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: p.color }}>{p.value}</span>
                  </div>
                ))}
              </div>
            </AnalyticsPanel>
          </div>
          <div className="col-4">
            <AnalyticsPanel title="Queue Growth — Waiting">
              <AreaSeries data={queueDepthSeries} color="#8b5cf6" name="waiting" height={160} formatter={fmtNum} />
            </AnalyticsPanel>
          </div>
        </div>

        <div className="grid-12">
          <div className="col-6">
            <AnalyticsPanel title="Success Rate % vs Retry Rate %" annotation="Last 1h">
              <MultiLine
                data={successErrorData}
                series={[
                  { key: 'success', color: '#10b981', name: 'Success %' },
                  { key: 'retry',   color: '#f97316', name: 'Retry %' },
                ]}
                height={130}
                formatter={v => `${v.toFixed(1)}%`}
              />
            </AnalyticsPanel>
          </div>
          <div className="col-6">
            <AnalyticsPanel title="Latency Distribution — Avg" annotation="All queues">
              <AreaSeries data={latencySeries} color="#f59e0b" name="ms" height={130}
                formatter={fmtMs} threshold={2000} thresholdLabel="SLA 2s" />
            </AnalyticsPanel>
          </div>
        </div>
      </div>
    </>
  );
}
