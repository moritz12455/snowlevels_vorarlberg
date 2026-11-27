import { useEffect, useMemo, useState } from 'react'
import { fetchMap } from '../api.js'
import { num } from '../format.js'
import SnowMap from './SnowMap.jsx'
import Timeline from './Timeline.jsx'
import { SCALES, cellValues, hotspot as findHotspot, prepare, rampColors, windowSum } from './field.js'

const WINDOWS = [3, 24, 72]

function useDarkMode() {
  const q = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const fn = (e) => setDark(e.matches)
    m.addEventListener('change', fn)
    return () => m.removeEventListener('change', fn)
  }, [])
  return dark
}

function Legend({ scale, dark }) {
  const colors = rampColors(dark)
  return (
    <div className="map-legend">
      <div className="legend-steps">
        {colors.map((c, i) => (
          <span key={c} className="legend-step" style={{ background: c, opacity: 0.55 + i * 0.07 }} />
        ))}
      </div>
      <div className="legend-ticks">
        {scale.stops.map((s) => (
          <span key={s}>{s}</span>
        ))}
        <span>+</span>
      </div>
      <div className="legend-unit">{scale.label} in {scale.unit}</div>
    </div>
  )
}

export default function MapView({ onOpenStation }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [index, setIndex] = useState(null)
  const [layer, setLayer] = useState('snowfall')
  const [windowH, setWindowH] = useState(24)
  const [playing, setPlaying] = useState(false)
  const dark = useDarkMode()

  useEffect(() => {
    const ctl = new AbortController()
    const load = () =>
      fetchMap(ctl.signal)
        .then((d) => {
          setData(d)
          setIndex((i) => i ?? d.nowIndex)
          setError(null)
        })
        .catch((e) => e.name !== 'AbortError' && setError(e.message))
    load()
    const id = setInterval(load, 10 * 60 * 1000)
    return () => { ctl.abort(); clearInterval(id) }
  }, [])

  // Abspielen: 1 h pro Schritt
  useEffect(() => {
    if (!playing || !data) return
    const id = setInterval(() => {
      setIndex((i) => {
        if (i >= data.count - 1) { setPlaying(false); return i }
        return i + 1
      })
    }, 110)
    return () => clearInterval(id)
  }, [playing, data])

  const togglePlay = () => {
    if (!playing && index >= data.count - 1) setIndex(0)
    setPlaying((p) => !p)
  }

  const prep = useMemo(() => (data ? prepare(data) : null), [data])
  const scale = SCALES[layer]
  const values = useMemo(() => (prep && index != null ? cellValues(prep, layer, index, windowH) : null), [prep, layer, index, windowH])

  // Stationswerte zum gewählten Zeitpunkt
  const ranked = useMemo(() => {
    if (!prep || index == null) return []
    return prep.stations
      .map((s) => ({
        ...s,
        depth: s.depth[index],
        newSnow: windowSum(s.cum, index, windowH),
      }))
      .sort((a, b) => (layer === 'snowfall' ? b.newSnow - a.newSnow : (b.depth ?? -1) - (a.depth ?? -1)))
  }, [prep, index, windowH, layer])

  const markers = useMemo(() => {
    const maxDepth = Math.max(1, ...ranked.map((s) => s.depth ?? 0))
    const topId = ranked[0] && (layer === 'snowfall' ? ranked[0].newSnow >= 0.5 : true) ? ranked[0].id : null
    return ranked.map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      top: s.id === topId,
      forecast: index > data.nowIndex,
      label: layer === 'snowfall' ? `${s.newSnow >= 0.05 ? '+' : ''}${num(s.newSnow, s.newSnow < 10 ? 1 : 0)}` : `${num(s.depth)} cm`,
      dotScale: 0.7 + 0.8 * Math.sqrt((s.depth ?? 0) / maxDepth),
      tooltip:
        `<strong>${s.name}</strong> · ${Math.round(s.altitude)} m<br>` +
        `Schneehöhe: <b>${num(s.depth)} cm</b> ${index > data.nowIndex ? '(Prognose)' : '(gemessen)'}<br>` +
        `Neuschnee ${windowH} h: <b>${num(s.newSnow, 1)} cm</b> (Modell)<br><span class="tt-hint">Klicken für Details</span>`,
    }))
  }, [ranked, layer, index, windowH, data])

  const hot = useMemo(() => {
    if (!prep?.hasGrid || !values) return null
    const h = findHotspot(prep, values)
    if (!h || (layer === 'snowfall' ? h.value < 0.5 : h.value < 1)) return null
    let near = null
    let best = Infinity
    for (const s of prep.stations) {
      const d = (s.lat - h.lat) ** 2 + ((s.lon - h.lon) * 0.68) ** 2
      if (d < best) { best = d; near = s }
    }
    return { ...h, near: near?.name, label: `max. ${num(h.value, h.value < 10 ? 1 : 0)} cm` }
  }, [prep, values, layer])

  const regionalMean = useMemo(() => {
    if (!prep || !values) return null
    let s = 0
    let n = 0
    prep.cells.forEach((c, k) => { if (c?.inside) { s += values[k]; n++ } })
    return n ? s / n : null
  }, [prep, values])

  if (error && !data) return <div className="banner error">Kartendaten konnten nicht geladen werden: {error}</div>
  if (!data || index == null) return <div className="placeholder">Karte wird geladen …</div>

  const maxRank = Math.max(0.1, ...ranked.map((s) => (layer === 'snowfall' ? s.newSnow : s.depth ?? 0)))

  return (
    <div className="mapview">
      {data.errors?.map((e) => <div key={e} className="banner warn">{e}</div>)}

      <div className="mapview-grid">
        <div className="map-card">
          <SnowMap
            data={data}
            values={prep.hasGrid ? values : null}
            scale={scale}
            dark={dark}
            stations={markers}
            hotspot={hot}
            onStationClick={onOpenStation}
          />
          <div className="map-overlay-top">
            <div className="segmented small" role="radiogroup" aria-label="Ebene">
              {[['snowfall', 'Neuschnee'], ['depth', 'Schneehöhe']].map(([v, l]) => (
                <button key={v} role="radio" aria-checked={layer === v} className={layer === v ? 'seg active' : 'seg'} onClick={() => setLayer(v)}>{l}</button>
              ))}
            </div>
            {layer === 'snowfall' && (
              <div className="segmented small" role="radiogroup" aria-label="Zeitfenster">
                {WINDOWS.map((w) => (
                  <button key={w} role="radio" aria-checked={windowH === w} className={windowH === w ? 'seg active' : 'seg'} onClick={() => setWindowH(w)}>{w} h</button>
                ))}
              </div>
            )}
          </div>
          <Legend scale={scale} dark={dark} />
        </div>

        <aside className="map-side">
          <div className="side-block">
            <div className="kpi-label">{layer === 'snowfall' ? `Neuschnee · letzte ${windowH} h` : 'Schneehöhe'}</div>
            <div className="side-big">
              {hot ? num(hot.value, hot.value < 10 ? 1 : 0) : '0'}<span className="kpi-unit">cm</span>
            </div>
            <div className="kpi-sub">
              {hot ? <>Modell-Maximum{hot.near ? <> bei <strong>{hot.near}</strong></> : null}</> : layer === 'snowfall' ? 'Kein nennenswerter Neuschnee' : 'Kaum Schnee'}
              {regionalMean != null && <> · Ø Vorarlberg {num(regionalMean, 1)} cm</>}
            </div>
          </div>

          <div className="side-block">
            <h3 className="side-title">{layer === 'snowfall' ? 'Wo schneit es am meisten?' : 'Wo liegt am meisten Schnee?'}</h3>
            <ol className="rank">
              {ranked.map((s, n) => {
                const v = layer === 'snowfall' ? s.newSnow : s.depth
                return (
                  <li key={s.id}>
                    <button className="rank-row" onClick={() => onOpenStation(s.id)} title="Details zur Station öffnen">
                      <span className="rank-n">{n + 1}</span>
                      <span className="rank-name">{s.name}<small>{Math.round(s.altitude)} m</small></span>
                      <span className="rank-bar"><span style={{ width: `${Math.max(0, ((v ?? 0) / maxRank) * 100)}%` }} /></span>
                      <span className="rank-val">{v == null ? '–' : `${num(v, layer === 'snowfall' && v < 10 ? 1 : 0)} cm`}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
            <p className="muted small">
              {layer === 'snowfall'
                ? 'Neuschnee aus dem Wettermodell am Stationsort.'
                : index > data.nowIndex
                  ? 'Prognose, an die letzte Messung angeglichen.'
                  : 'Gemessene Schneehöhe (Stundenmittel).'}
            </p>
          </div>
        </aside>
      </div>

      <Timeline
        start={data.start}
        stepMs={data.stepMs}
        count={data.count}
        nowIndex={data.nowIndex}
        index={index}
        onChange={(i) => { setPlaying(false); setIndex(i) }}
        windowH={windowH}
        showWindow={layer === 'snowfall'}
        regional={prep.regional}
        playing={playing}
        onTogglePlay={togglePlay}
      />

      <footer className="sources">
        <span>{data.sources.grid}</span>
        <span>{data.sources.stations}</span>
        <span>{data.sources.boundary}</span>
      </footer>
    </div>
  )
}
