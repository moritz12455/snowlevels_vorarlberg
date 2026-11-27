import { useEffect, useMemo, useState } from 'react'
import { fetchStationData, fetchStations } from './api.js'
import StationTabs from './components/StationTabs.jsx'
import RangeSwitch from './components/RangeSwitch.jsx'
import Kpis from './components/Kpis.jsx'
import WeatherCharts from './components/WeatherCharts.jsx'
import DataTable from './components/DataTable.jsx'
import { full } from './format.js'

const REFRESH_MS = 10 * 60 * 1000

function readUrlState() {
  const p = new URLSearchParams(window.location.search)
  return { station: p.get('station'), range: p.get('range') || 'week' }
}

export default function App() {
  const initial = useMemo(() => readUrlState(), [])
  const [stations, setStations] = useState(null)
  const [stationsError, setStationsError] = useState(null)
  const [stationId, setStationId] = useState(initial.station)
  const [range, setRange] = useState(['day', 'week', 'month'].includes(initial.range) ? initial.range : 'week')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [aligned, setAligned] = useState(true)
  const [tick, setTick] = useState(0)

  // Stationen laden
  useEffect(() => {
    const ctl = new AbortController()
    fetchStations(ctl.signal)
      .then((s) => {
        setStations(s)
        setStationId((cur) => (cur && s.some((x) => x.id === cur) ? cur : s[0]?.id ?? null))
      })
      .catch((e) => e.name !== 'AbortError' && setStationsError(e.message))
    return () => ctl.abort()
  }, [])

  // Auswahl in der URL merken (teilbare Links)
  useEffect(() => {
    if (!stationId) return
    const p = new URLSearchParams({ station: stationId, range })
    window.history.replaceState(null, '', `${window.location.pathname}?${p}`)
  }, [stationId, range])

  // Daten laden + alle 10 Minuten aktualisieren
  useEffect(() => {
    if (!stationId) return
    const ctl = new AbortController()
    setLoading(true)
    setError(null)
    fetchStationData(stationId, range, ctl.signal)
      .then(setData)
      .catch((e) => e.name !== 'AbortError' && setError(e.message))
      .finally(() => !ctl.signal.aborted && setLoading(false))
    return () => ctl.abort()
  }, [stationId, range, tick])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const showData = data && data.station.id === stationId && data.range === range ? data : null

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <svg className="brand-icon" viewBox="0 0 32 32" aria-hidden="true">
              <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none">
                <path d="M16 4v24M5.6 10l20.8 12M5.6 22l20.8-12" />
                <path d="M12.5 5.8 16 8.6l3.5-2.8M12.5 26.2l3.5-2.8 3.5 2.8" />
              </g>
            </svg>
            <div>
              <h1>Schneehöhen Vorarlberg</h1>
              <p className="subtitle">Messung &amp; Prognose an den TAWES-Stationen</p>
            </div>
          </div>
        </div>
        {stations && (
          <StationTabs stations={stations} selected={stationId} onSelect={setStationId} />
        )}
      </header>

      <main className="main">
        {stationsError && <div className="banner error">Stationen konnten nicht geladen werden: {stationsError}</div>}
        {!stations && !stationsError && <div className="placeholder">Stationen werden geladen …</div>}

        {stations && stationId && (
          <>
            <div className="toolbar">
              <div className="station-title">
                <h2>{stations.find((s) => s.id === stationId)?.name}</h2>
                <span className="muted">
                  {Math.round(stations.find((s) => s.id === stationId)?.altitude ?? 0)} m ü. A. · Station {stationId}
                </span>
              </div>
              <div className="controls">
                <label className="toggle" title="Verschiebt die Modell-Schneehöhe so, dass sie an der letzten Messung ansetzt">
                  <input type="checkbox" checked={aligned} onChange={(e) => setAligned(e.target.checked)} />
                  <span>Prognose an Messung angleichen</span>
                </label>
                <RangeSwitch value={range} onChange={setRange} />
              </div>
            </div>

            {error && <div className="banner error">Fehler beim Laden: {error}</div>}
            {showData?.errors?.map((e) => (
              <div key={e} className="banner warn">{e}</div>
            ))}

            {showData ? (
              <div className={loading ? 'content is-loading' : 'content'}>
                <Kpis data={showData} aligned={aligned} />
                <WeatherCharts data={showData} aligned={aligned} />
                <DataTable data={showData} aligned={aligned} />
                <footer className="sources">
                  <span>Stand: {full(showData.now)}</span>
                  <span>Messdaten: {showData.sources.measurements}</span>
                  <span>Prognose: {showData.sources.forecast}</span>
                </footer>
              </div>
            ) : (
              !error && <div className="placeholder">Daten werden geladen …</div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
