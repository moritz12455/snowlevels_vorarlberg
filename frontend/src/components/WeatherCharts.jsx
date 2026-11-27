import { useMemo } from 'react'
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { full, makeTicks, num, tickLabel } from '../format.js'
import { mergeSeries } from '../series.js'

const C_MEAS = 'var(--series-1)'
const C_FC = 'var(--series-2)'

function Legend({ extra }) {
  return (
    <div className="legend" aria-hidden="true">
      <span className="legend-item">
        <svg width="22" height="10"><line x1="1" y1="5" x2="21" y2="5" stroke={C_MEAS} strokeWidth="2.5" strokeLinecap="round" /></svg>
        Messung
      </span>
      <span className="legend-item">
        <svg width="22" height="10"><line x1="1" y1="5" x2="21" y2="5" stroke={C_FC} strokeWidth="2.5" strokeDasharray="5 4" strokeLinecap="round" /></svg>
        Prognose
      </span>
      {extra}
    </div>
  )
}

function makeTooltip(unit, digits, extraRows) {
  return function ChartTooltip({ active, payload, label }) {
    if (!active || !payload?.length) return null
    const r = payload[0].payload
    const rows = []
    for (const p of payload) {
      if (p.value == null) continue
      rows.push(
        <div key={p.dataKey} className="tt-row">
          <span className="tt-swatch" style={{ background: p.dataKey.endsWith('F') ? C_FC : C_MEAS }} />
          <span className="tt-name">{p.dataKey.endsWith('F') ? 'Prognose' : 'Messung'}</span>
          <span className="tt-val">{num(p.value, digits)} {unit}</span>
        </div>,
      )
    }
    const extra = extraRows?.(r) ?? []
    if (!rows.length && !extra.length) return null
    return (
      <div className="tooltip">
        <div className="tt-time">{full(label)}</div>
        {rows}
        {extra.map(([k, v]) => (
          <div key={k} className="tt-row tt-extra">
            <span className="tt-name">{k}</span>
            <span className="tt-val">{v}</span>
          </div>
        ))}
      </div>
    )
  }
}

function Panel({ title, subtitle, height, children, legendExtra }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="muted small">{subtitle}</p>}
        </div>
        <Legend extra={legendExtra} />
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </section>
  )
}

export default function WeatherCharts({ data, aligned }) {
  const rows = useMemo(() => mergeSeries(data, aligned), [data, aligned])
  const ticks = useMemo(() => makeTicks(data.from, data.to, data.range), [data.from, data.to, data.range])

  const common = {
    data: rows,
    syncId: 'wetter',
    syncMethod: 'value',
    margin: { top: 8, right: 16, bottom: 0, left: 0 },
  }
  const xAxis = (
    <XAxis
      dataKey="t"
      type="number"
      scale="time"
      domain={[data.from, data.to]}
      ticks={ticks}
      tickFormatter={(t) => tickLabel(t, data.range)}
      tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
      tickLine={false}
      axisLine={{ stroke: 'var(--axis)' }}
      minTickGap={8}
    />
  )
  const grid = <CartesianGrid stroke="var(--grid)" vertical={false} />
  const nowLine = (
    <ReferenceLine
      x={data.now}
      stroke="var(--text-secondary)"
      strokeDasharray="2 3"
      label={{ value: 'jetzt', position: 'insideTopLeft', fill: 'var(--text-secondary)', fontSize: 11, offset: 6 }}
    />
  )
  const yAxis = (unit, extra = {}) => (
    <YAxis
      width={56}
      tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
      tickLine={false}
      axisLine={false}
      tickFormatter={(v) => `${num(v)} ${unit}`}
      {...extra}
    />
  )
  const cursor = { stroke: 'var(--text-secondary)', strokeWidth: 1 }
  const lineProps = { type: 'monotone', dot: false, strokeWidth: 2, isAnimationActive: false, connectNulls: false }

  const snowSubtitle = aligned && data.summary.offsetCm != null && data.summary.offsetCm !== 0
    ? `Prognose um ${data.summary.offsetCm > 0 ? '+' : ''}${num(data.summary.offsetCm)} cm an die letzte Messung angeglichen`
    : 'Modell-Schneehöhe ungeändert'

  return (
    <div className="charts">
      <Panel title="Schneehöhe" subtitle={snowSubtitle} height={320}>
        <ComposedChart {...common}>
          <defs>
            <linearGradient id="snowFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C_MEAS} stopOpacity={0.28} />
              <stop offset="100%" stopColor={C_MEAS} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {grid}
          {xAxis}
          {yAxis('cm', { domain: [0, (max) => Math.max(10, Math.ceil((max * 1.15) / 5) * 5)], allowDecimals: false })}
          <Tooltip
            cursor={cursor}
            content={makeTooltip('cm', 0, (r) => {
              const out = []
              if (r.snowfallF > 0) out.push(['Neuschnee', `${num(r.snowfallF, 1)} cm`])
              if (aligned && r.snowRawF != null && r.snowRawF !== r.snowF) out.push(['Modell roh', `${num(r.snowRawF)} cm`])
              return out
            })}
          />
          {nowLine}
          <Area dataKey="snowM" stroke={C_MEAS} fill="url(#snowFill)" {...lineProps} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }} />
          <Line dataKey="snowF" stroke={C_FC} strokeDasharray="6 4" {...lineProps} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }} />
        </ComposedChart>
      </Panel>

      <div className="charts-row">
        <Panel title="Temperatur" subtitle="Lufttemperatur 2 m" height={200}>
          <ComposedChart {...common}>
            {grid}
            {xAxis}
            {yAxis('°', { domain: ['auto', 'auto'] })}
            <ReferenceLine y={0} stroke="var(--axis)" />
            <Tooltip cursor={cursor} content={makeTooltip('°C', 1)} />
            {nowLine}
            <Line dataKey="tempM" stroke={C_MEAS} {...lineProps} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }} />
            <Line dataKey="tempF" stroke={C_FC} strokeDasharray="6 4" {...lineProps} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }} />
          </ComposedChart>
        </Panel>

        <Panel title="Windstärke" subtitle="Mittelwind 10 m · Böen im Tooltip" height={200}>
          <ComposedChart {...common}>
            {grid}
            {xAxis}
            {yAxis('', { domain: [0, 'auto'], allowDecimals: false, tickFormatter: (v) => num(v) })}
            <Tooltip
              cursor={cursor}
              content={makeTooltip('km/h', 0, (r) => {
                const g = r.gustM ?? r.gustF
                return g != null ? [['Böen', `${num(g)} km/h`]] : []
              })}
            />
            {nowLine}
            <Line dataKey="windM" stroke={C_MEAS} {...lineProps} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }} />
            <Line dataKey="windF" stroke={C_FC} strokeDasharray="6 4" {...lineProps} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }} />
          </ComposedChart>
        </Panel>
      </div>
    </div>
  )
}
