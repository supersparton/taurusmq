'use client';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine,
} from 'recharts';
import { fmtMs, fmtNum } from '@/lib/utils';
import type { MetricPoint } from '@/lib/types';

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
  formatter?: (v: number) => string;
}

function ChartTooltip({ active, payload, label, formatter }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {formatter ? formatter(p.value) : p.value.toFixed(1)}
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{p.name}</span>
        </div>
      ))}
    </div>
  );
}

function tickFormatter(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

interface AreaSeriesProps {
  data: MetricPoint[];
  color: string;
  name: string;
  height?: number;
  formatter?: (v: number) => string;
  threshold?: number;
  thresholdLabel?: string;
  gradientId?: string;
}

export function AreaSeries({ data, color, name, height = 140, formatter, threshold, thresholdLabel, gradientId = 'grad' }: AreaSeriesProps) {
  const id = `${gradientId}_${color.replace('#', '')}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.5} vertical={false} />
        <XAxis dataKey="t" tickFormatter={tickFormatter} tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
          tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false}
          tickFormatter={v => formatter ? formatter(v) : fmtNum(v)} />
        <Tooltip content={<ChartTooltip formatter={formatter} />} />
        {threshold && (
          <ReferenceLine y={threshold} stroke="#ef4444" strokeDasharray="4 2" strokeOpacity={0.8}
            label={{ value: thresholdLabel ?? `SLA: ${threshold}`, fill: '#ef4444', fontSize: 10, position: 'insideTopRight' }} />
        )}
        <Area type="monotone" dataKey="v" name={name} stroke={color} strokeWidth={1.5}
          fill={`url(#${id})`} dot={false} activeDot={{ r: 3, fill: color }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

interface MultiLineProps {
  data: Array<{ t: number; [key: string]: number }>;
  series: Array<{ key: string; color: string; name: string }>;
  height?: number;
  formatter?: (v: number) => string;
}

export function MultiLine({ data, series, height = 160, formatter }: MultiLineProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.5} vertical={false} />
        <XAxis dataKey="t" tickFormatter={tickFormatter} tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
          tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false}
          tickFormatter={v => formatter ? formatter(v) : fmtNum(v)} />
        <Tooltip content={<ChartTooltip formatter={formatter} />} />
        {series.map(s => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color}
            strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

interface BarSeriesProps {
  data: MetricPoint[];
  color: string;
  name: string;
  height?: number;
  formatter?: (v: number) => string;
}

export function BarSeries({ data, color, name, height = 120, formatter }: BarSeriesProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }} barCategoryGap="20%">
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.5} vertical={false} />
        <XAxis dataKey="t" tickFormatter={tickFormatter} tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
          tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false}
          tickFormatter={v => formatter ? formatter(v) : fmtNum(v)} />
        <Tooltip content={<ChartTooltip formatter={formatter} />} />
        <Bar dataKey="v" name={name} fill={color} fillOpacity={0.85} radius={[1, 1, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// Sparkline — tiny inline chart, no axes, no grid
interface SparklineProps {
  data: MetricPoint[];
  color: string;
  height?: number;
  width?: number;
}
export function Sparkline({ data, color, height = 32, width = 80 }: SparklineProps) {
  return (
    <ResponsiveContainer width={width} height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
        <defs>
          <linearGradient id={`spark_${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
          fill={`url(#spark_${color.replace('#', '')})`} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
