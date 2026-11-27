// Daten für die Kartenansicht: Neuschnee-/Schneehöhenraster über Vorarlberg (Open-Meteo),
// Stationsreihen (GeoSphere-Messung + angeglichene Prognose) und Landesgrenze.
import boundary from './vorarlberg.json'
import { snowStations } from './stations.js'
import { timeseries } from './geosphere.js'
import { hourly } from './openmeteo.js'
import { HOUR, MIN10, cached, floorTo, r1 } from './util.js'

// Open-Meteo zählt Abfragen über 14 Tage mehrfach – daher 6 Tage zurück + 8 Tage (inkl. heute) voraus.
const PAST_DAYS = 6
const FORECAST_DAYS = 8
const FUTURE_DAYS = 7
const STEP_LAT = 0.045 // ≈ 5 km
const STEP_LON = 0.065 // ≈ 5 km
const BUFFER = 0.07 // Rasterpunkte bis ~6 km außerhalb der Grenze (für weiche Ränder)

const ring = boundary.geometry.coordinates[0] // [lon, lat]
const bbox = ring.reduce(
  (b, [x, y]) => ({ minLon: Math.min(b.minLon, x), maxLon: Math.max(b.maxLon, x), minLat: Math.min(b.minLat, y), maxLat: Math.max(b.maxLat, y) }),
  { minLon: 180, maxLon: -180, minLat: 90, maxLat: -90 },
)

/** Punkt-in-Polygon (Ray Casting). */
function inside(lon, lat) {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** Ungefährer Abstand zur Grenzlinie in Breitengrad-Grad. */
function distance(lon, lat) {
  const k = Math.cos((lat * Math.PI) / 180)
  let best = Infinity
  for (let i = 1; i < ring.length; i++) {
    const ax = ring[i - 1][0] * k
    const ay = ring[i - 1][1]
    const dx = ring[i][0] * k - ax
    const dy = ring[i][1] - ay
    const px = lon * k
    const l = dx * dx + dy * dy
    const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (lat - ay) * dy) / l)) : 0
    best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - lat))
  }
  return best
}

const round4 = (v) => Math.round(v * 1e4) / 1e4

/** Rasterdefinition (rein geometrisch, ohne Abfrage). */
function gridLayout() {
  const lat0 = Math.floor((bbox.minLat - BUFFER) / STEP_LAT) * STEP_LAT
  const lon0 = Math.floor((bbox.minLon - BUFFER) / STEP_LON) * STEP_LON
  const nLat = Math.ceil((bbox.maxLat + BUFFER - lat0) / STEP_LAT) + 1
  const nLon = Math.ceil((bbox.maxLon + BUFFER - lon0) / STEP_LON) + 1
  const ins = []
  const query = [] // { k, lat, lon }
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const lat = lat0 + i * STEP_LAT
      const lon = lon0 + j * STEP_LON
      const k = i * nLon + j
      ins[k] = inside(lon, lat)
      if (ins[k] || distance(lon, lat) <= BUFFER) query.push({ k, lat: round4(lat), lon: round4(lon) })
    }
  }
  return { lat0: round4(lat0), lon0: round4(lon0), dLat: STEP_LAT, dLon: STEP_LON, nLat, nLon, inside: ins, query }
}

/** Raster bei Open-Meteo abfragen (≈ 200 Orte, daher 1 h zwischengespeichert, auch über Neuladen hinweg). */
function gridData() {
  return cached(
    'map:grid',
    HOUR,
    async () => {
      const layout = gridLayout()
      const { times, places } = await hourly({
        lats: layout.query.map((q) => q.lat),
        lons: layout.query.map((q) => q.lon),
        vars: ['snowfall', 'snow_depth'],
        pastDays: PAST_DAYS,
        forecastDays: FORECAST_DAYS,
      })
      if (places.length !== layout.query.length) throw new Error(`${places.length} statt ${layout.query.length} Rasterpunkte`)
      const n = layout.nLat * layout.nLon
      const snowfall = Array(n).fill(null)
      const snowDepth = Array(n).fill(null)
      layout.query.forEach((q, idx) => {
        snowfall[q.k] = places[idx].snowfall.map((v) => (v == null ? 0 : r1(v)))
        snowDepth[q.k] = places[idx].snow_depth.map((v) => (v == null ? 0 : r1(v * 100)))
      })
      const { lat0, lon0, dLat, dLon, nLat, nLon, inside: ins } = layout
      return { grid: { lat0, lon0, dLat, dLon, nLat, nLon, inside: ins, snowfall, snowDepth }, times }
    },
    { persist: true },
  )
}

function stationForecasts(stations) {
  return cached(
    'map:stfc',
    30 * 60e3,
    () =>
      hourly({
        lats: stations.map((s) => s.lat),
        lons: stations.map((s) => s.lon),
        elevs: stations.map((s) => s.altitude),
        vars: ['snowfall', 'snow_depth'],
        pastDays: PAST_DAYS,
        forecastDays: FORECAST_DAYS,
      }),
    { persist: true },
  )
}

function stationMeasurements(stations, start) {
  return cached('map:meas', 10 * 60e3, () => {
    const end = floorTo(Date.now(), MIN10)
    return timeseries(stations.map((s) => s.id), ['SCHNEE'], start - HOUR, end)
  })
}

/** Alles für die Kartenansicht – gleiches Format wie früher /api/map. */
export async function mapData() {
  const now = Date.now()
  const start = floorTo(now, HOUR) - PAST_DAYS * 24 * HOUR
  const count = (PAST_DAYS + FUTURE_DAYS) * 24 + 1
  const nowIndex = PAST_DAYS * 24
  const stations = await snowStations()

  const [gRes, mRes, sRes] = await Promise.allSettled([gridData(), stationMeasurements(stations, start), stationForecasts(stations)])
  const errors = []
  if (gRes.status === 'rejected') errors.push(`Raster (Open-Meteo): ${gRes.reason.message}`)
  if (mRes.status === 'rejected') errors.push(`Messungen (GeoSphere): ${mRes.reason.message}`)
  if (sRes.status === 'rejected') errors.push(`Stationsprognose (Open-Meteo): ${sRes.reason.message}`)
  if (errors.length === 3) throw new Error('Keine Datenquelle erreichbar')

  const slot = (t) => {
    const d = t - start
    if (d < 0 || d % HOUR !== 0) return -1
    const i = d / HOUR
    return i < count ? i : -1
  }

  // Raster auf die gemeinsame Zeitachse bringen
  const layout = gridLayout()
  let grid = { lat0: layout.lat0, lon0: layout.lon0, dLat: layout.dLat, dLon: layout.dLon, nLat: layout.nLat, nLon: layout.nLon, inside: layout.inside, snowfall: [], snowDepth: [] }
  if (gRes.status === 'fulfilled') {
    const g = gRes.value
    const map = (series) =>
      series.map((s) => {
        if (!s) return null
        const out = new Array(count).fill(0)
        g.times.forEach((t, i) => {
          const n = slot(t)
          if (n >= 0) out[n] = s[i]
        })
        return out
      })
    grid = { ...g.grid, snowfall: map(g.grid.snowfall), snowDepth: map(g.grid.snowDepth) }
  }

  // Stationen: Messung (Stundenmittel) bis jetzt, danach Prognose an letzte Messung angeglichen
  const meas = mRes.status === 'fulfilled' ? mRes.value : null
  const fc = sRes.status === 'fulfilled' ? sRes.value : null
  const mapStations = stations.map((st, si) => {
    const depth = new Array(count).fill(null)
    const snowfall = new Array(count).fill(null)
    let lastIdx = -1
    const m = meas?.byId[st.id]
    if (m) {
      const sum = new Array(count).fill(0)
      const cnt = new Array(count).fill(0)
      meas.times.forEach((t, i) => {
        const v = m.snow[i]
        if (v == null) return
        // 10-Min-Werte der Stunde h (h-1:00 < t <= h:00) dem Slot h zuordnen
        const n = slot(floorTo(t + 59 * 60e3, HOUR))
        if (n >= 0 && n <= nowIndex) {
          sum[n] += v
          cnt[n]++
        }
      })
      cnt.forEach((c, n) => {
        if (c) {
          depth[n] = r1(sum[n] / c)
          lastIdx = n
        }
      })
    }
    let offsetCm = null
    if (fc?.places[si]) {
      const p = fc.places[si]
      const model = new Array(count).fill(null)
      fc.times.forEach((t, i) => {
        const n = slot(t)
        if (n < 0) return
        model[n] = p.snow_depth[i]
        if (p.snowfall[i] != null) snowfall[n] = r1(p.snowfall[i])
      })
      let off = 0
      if (lastIdx >= 0 && model[lastIdx] != null) {
        off = r1(depth[lastIdx] - model[lastIdx] * 100)
        offsetCm = off
      }
      for (let n = Math.max(lastIdx + 1, nowIndex + 1); n < count; n++) {
        if (model[n] != null) depth[n] = Math.max(0, r1(model[n] * 100 + off))
      }
    }
    return { id: st.id, name: st.name, lat: st.lat, lon: st.lon, altitude: st.altitude, depth, snowfall, offsetCm }
  })

  return {
    now,
    start,
    stepMs: HOUR,
    count,
    nowIndex,
    grid,
    stations: mapStations,
    boundary,
    errors,
    sources: {
      grid: 'Open-Meteo.com – Neuschnee & Schneehöhe im ~5-km-Raster (Modell, CC BY 4.0)',
      stations: 'GeoSphere Austria – TAWES-Schneehöhen (Messung, CC BY 4.0); Prognose Open-Meteo',
      boundary: 'Landesgrenze: Statistik Austria (CC BY 4.0)',
    },
  }
}
