import { num, time } from '../format.js'

function Tile({ label, value, unit, sub }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">
        {value}
        {unit && <span className="kpi-unit">{unit}</span>}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

const shift = (v, off, on) => (v == null ? null : on && off != null ? Math.max(0, v + off) : v)

export default function Kpis({ data, aligned }) {
  const c = data.current
  const s = data.summary
  const off = s.offsetCm
  const snow24 = shift(s.snow24h, off, aligned)
  const delta = snow24 != null && c?.snow != null ? snow24 - c.snow : null
  const horizon = { day: '48 h', week: '7 Tage', month: '16 Tage' }[data.range]

  return (
    <section className="kpis" aria-label="Kennzahlen">
      <Tile
        label="Schneehöhe jetzt"
        value={num(c?.snow)}
        unit="cm"
        sub={c ? `gemessen ${time(c.t)} Uhr` : 'keine Messung'}
      />
      <Tile
        label="Prognose in 24 h"
        value={num(snow24)}
        unit="cm"
        sub={delta == null ? 'Modell' : `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${num(Math.abs(delta))} cm zu jetzt`}
      />
      <Tile
        label="Neuschnee"
        value={num(s.newSnow24h, 1)}
        unit="cm"
        sub={`nächste 24 h · ${num(s.newSnowTotal, 1)} cm in ${horizon}`}
      />
      <Tile
        label="Temperatur"
        value={num(c?.temp, 1)}
        unit="°C"
        sub={`Prognose ${num(s.tempMin, 0)} bis ${num(s.tempMax, 0)} °C`}
      />
      <Tile
        label="Wind"
        value={num(c?.wind)}
        unit="km/h"
        sub={`Böen ${num(c?.gust)} km/h · max. ${num(s.gustMax)} km/h erwartet`}
      />
    </section>
  )
}
