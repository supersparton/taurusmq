'use client';
import Topbar from '@/components/layout/Topbar';
import { fmtMs, fmtNum } from '@/lib/utils';
import { AreaSeries, MultiLine } from '@/components/charts/ChartPrimitives';
import { isFeatureEnabled } from '@/lib/features';
import FeatureLocked from '@/components/layout/FeatureLocked';
import { useState, useEffect } from 'react';
import { getGlobalAnalytics, type GlobalAnalyticsPoint } from '@/lib/api';

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
  const [data, setData] = useState<GlobalAnalyticsPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const [timeRange, setTimeRange] = useState('Last 1h');
  const [refreshInterval, setRefreshInterval] = useState('5s');

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    async function load() {
      try {
        const apiRange = timeRange === 'Last 7d' ? '7d' : timeRange === 'Last 24h' ? '24h' : '1h';
        const res = await getGlobalAnalytics(apiRange);
        if (active && res) {
          setData(res);
        }
      } catch (_) {
        // quiet fallback
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    
    if (refreshInterval === 'Off') return;
    const ms = refreshInterval === '5s' ? 5000 : refreshInterval === '15s' ? 15000 : 30000;
    const interval = setInterval(load, ms);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [enabled, timeRange, refreshInterval]);

  if (!enabled) {
    return (
      <>
        <Topbar
          title="Analytics"
          subtitle="Aggregated metrics"
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          refreshInterval={refreshInterval}
          onRefreshIntervalChange={setRefreshInterval}
        />
        <FeatureLocked featureName="Analytics Dashboard" phase="Phase 4" />
      </>
    );
  }

  // Map state data to chart format
  const throughputSeries = data.map(d => ({ t: d.t, v: d.throughput }));
  const latencySeries = data.map(d => ({ t: d.t, v: d.avgLatency }));
  const errorSeries = data.map(d => ({ t: d.t, v: d.errorRate }));
  const queueDepthSeries = data.map(d => ({ t: d.t, v: d.waiting }));
  const p50Series = data.map(d => ({ t: d.t, v: d.p50 }));
  const p95Series = data.map(d => ({ t: d.t, v: d.p95 }));
  const p99Series = data.map(d => ({ t: d.t, v: d.p99 }));
  const successSeries = data.map(d => ({ t: d.t, v: d.successRate }));
  const retrySeries = data.map(d => ({ t: d.t, v: d.retryRate }));

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

  const latestThroughput = throughputSeries[throughputSeries.length - 1]?.v ?? 0;
  const latestLatency    = latencySeries[latencySeries.length - 1]?.v ?? 0;
  const latestError      = errorSeries[errorSeries.length - 1]?.v ?? 0;
  const latestP99        = p99Series[p99Series.length - 1]?.v ?? 0;
  const latestDepth      = queueDepthSeries[queueDepthSeries.length - 1]?.v ?? 0;
  const latestSuccess    = successSeries[successSeries.length - 1]?.v ?? 0;

  return (
    <>
      <Topbar
        title="Analytics"
        subtitle={`Aggregated metrics · ${timeRange}`}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        refreshInterval={refreshInterval}
        onRefreshIntervalChange={setRefreshInterval}
      />
      <div className="page-content" style={{ padding: 12 }}>
        {loading && data.length === 0 ? (
          <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading live telemetry analytics...
          </div>
        ) : data.length === 0 ? (
          <div className="panel" style={{ padding: 48, textAlign: 'center' }}>
            <h3 style={{ marginBottom: 8, color: 'var(--text-primary)' }}>No Telemetry History Yet</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, maxWidth: 480, margin: '0 auto' }}>
              We couldn't locate any historical hourly metrics in Redis. Verify that your worker processes are active and processing jobs to begin collecting performance statistics.
            </p>
          </div>
        ) : (
          <>
            {/* Golden Signals strip — New Relic pattern */}
            <div className="grid-12" style={{ marginBottom: 8 }}>
              {[
                { label: 'Throughput',   value: `${latestThroughput.toFixed(1)}/min`, color: '#06b6d4', sub: 'Traffic' },
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
                  <AreaSeries data={throughputSeries} color="#06b6d4" name="jobs/min" height={140} formatter={v => `${v.toFixed(1)}/min`} />
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
          </>
        )}
      </div>
    </>
  );
}
