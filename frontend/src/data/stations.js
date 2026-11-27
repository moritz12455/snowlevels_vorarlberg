// Stationssuche und Daten für die Stationsansicht (Messung + Prognose).
import { prettyName, timeseries, vorarlbergStations } from './geosphere.js'
import { hourly } from './openmeteo.js'
import { HOUR, MIN10, cached, floorTo, r1 } from './util.js'

/**
 * Alle Vorarlberger Stationen, die in den letzten 14 Tagen tatsächlich eine Schneehöhe
 * gemeldet haben – nach Seehöhe absteigend.
 */
export function snowStations() {
  return cached('stations', HOUR, findSnowStations, { persist: true })
}

async function findSnowStations() {
  const metas = await vorarlbergStations()
  if (!metas.length) throw new Error('Keine Vorarlberger Stationen in den Metadaten gefunden')
  const end = floorTo(Date.now(), MIN10)
  const { times, byId } = await timeseries(metas.map((m) => m.id), ['SCHNEE'], end - 14 * 24 * HOUR, end)

  const stations = []
  for (const m of metas) {
    const s = byId[m.id]
    if (!s) continue
    let count = 0
    let latest = null
    let latestAt = null
    s.snow.forEach((v, i) => {
      if (v != null) {
        count++
        latest = v
        latestAt = times[i]
      }
    })
    if (!count) continue // misst keine Schneehöhe
    stations.push({
      id: m.id,
      name: prettyName(m.name),
      altitude: m.altitude,
      lat: m.lat,
      lon: m.lon,
      latestSnowCm: latest,
      latestAt,
      coverage: r1((count / s.snow.length) * 100),
    })
  }
  return stations.sort((a, b) => b.altitude - a.altitude)
}

// ---------- Stationsansicht ----------

const RANGES = {
  day: { past: 24 * HOUR, future: 48 * HOUR, measBucket: MIN10, fcBucket: HOUR },
  week: { past: 7 * 24 * HOUR, future: 7 * 24 * HOUR, measBucket: HOUR, fcBucket: HOUR },
  month: { past: 30 * 24 * HOUR, future: 16 * 24 * HOUR, measBucket: 3 * HOUR, fcBucket: 3 * HOUR },
}

const mean = (a) => (a.length ? r1(a.reduce((s, x) => s + x, 0) / a.length) : null)

/**
 * Fasst Werte in Zeit-Buckets zusammen: Schnee/Temperatur/Wind gemittelt, Böen als Maximum,
 * Neuschnee als Summe. Leere Buckets entfallen.
 */
export function aggregate(times, cols, bucket, from, to) {
  const buckets = new Map()
  times.forEach((t, i) => {
    if (t < from || t > to) return
    const k = floorTo(t, bucket)
    let a = buckets.get(k)
    if (!a) {
      a = { snow: [], temp: [], wind: [], gust: null, sf: null }
      buckets.set(k, a)
    }
    const v = (name) => cols[name]?.[i] ?? null
    if (v('snow') != null) a.snow.push(v('snow'))
    if (v('temp') != null) a.temp.push(v('temp'))
    if (v('wind') != null) a.wind.push(v('wind'))
    if (v('gust') != null && (a.gust == null || v('gust') > a.gust)) a.gust = v('gust')
    if (v('snowfall') != null) a.sf = (a.sf ?? 0) + v('snowfall')
  })
  const out = []
  for (const [t, a] of buckets) {
    const p = { t, snow: mean(a.snow), temp: mean(a.temp), wind: mean(a.wind), gust: a.gust }
    if (a.sf != null) p.snowfall = r1(a.sf)
    if (p.snow == null && p.temp == null && p.wind == null) continue
    out.push(p)
  }
  return out
}

function latestValues(m) {
  const last = (arr) => {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return [arr[i], i]
    return [null, -1]
  }
  const idx = Math.max(last(m.snow)[1], last(m.temp)[1], last(m.wind)[1])
  if (idx < 0) return null
  return { t: m.times[idx], snow: last(m.snow)[0], temp: last(m.temp)[0], wind: last(m.wind)[0], gust: last(m.gust)[0] }
}

function summarize(fc, now, to, lastMeasT, lastMeasSnow) {
  const sum = { snow24h: null, snowEnd: null, newSnow24h: 0, newSnowTotal: 0, offsetCm: null, tempMin: null, tempMax: null, gustMax: null }
  const in24 = now + 24 * HOUR
  const fromHour = floorTo(now, HOUR)
  let best24 = Infinity
  let bestMeas = Infinity
  let modelAtMeas = null
  fc.times.forEach((t, i) => {
    const snow = fc.snow[i]
    if (snow != null && lastMeasT != null && Math.abs(t - lastMeasT) < bestMeas) {
      bestMeas = Math.abs(t - lastMeasT)
      modelAtMeas = snow
    }
    if (t < fromHour || t > to) return
    if (snow != null) {
      if (Math.abs(t - in24) < best24) {
        best24 = Math.abs(t - in24)
        sum.snow24h = snow
      }
      sum.snowEnd = snow
    }
    const sf = fc.snowfall[i]
    if (sf != null) {
      sum.newSnowTotal += sf
      if (t < in24) sum.newSnow24h += sf
    }
    const tmp = fc.temp[i]
    if (tmp != null) {
      sum.tempMin = sum.tempMin == null ? tmp : Math.min(sum.tempMin, tmp)
      sum.tempMax = sum.tempMax == null ? tmp : Math.max(sum.tempMax, tmp)
    }
    const g = fc.gust[i]
    if (g != null) sum.gustMax = sum.gustMax == null ? g : Math.max(sum.gustMax, g)
  })
  sum.newSnow24h = r1(sum.newSnow24h)
  sum.newSnowTotal = r1(sum.newSnowTotal)
  if (lastMeasSnow != null && modelAtMeas != null && bestMeas <= 2 * HOUR) sum.offsetCm = r1(lastMeasSnow - modelAtMeas)
  return sum
}

function stationForecast(st, days) {
  return cached(`fc:${st.id}:${days}`, 30 * 60e3, async () => {
    const { times, places } = await hourly({
      lats: [st.lat],
      lons: [st.lon],
      elevs: [st.altitude],
      vars: ['snow_depth', 'temperature_2m', 'wind_speed_10m', 'wind_gusts_10m', 'snowfall'],
      pastDays: 1,
      forecastDays: days,
    })
    const p = places[0]
    return {
      times,
      snow: p.snow_depth.map((v) => (v == null ? null : r1(v * 100))), // m -> cm
      temp: p.temperature_2m,
      wind: p.wind_speed_10m,
      gust: p.wind_gusts_10m,
      snowfall: p.snowfall,
    }
  })
}

function stationMeasurements(id, range, past) {
  return cached(`meas:${id}:${range}`, 5 * 60e3, async () => {
    const end = floorTo(Date.now(), MIN10)
    const { times, byId } = await timeseries([id], ['SCHNEE', 'TL', 'FF', 'FFX'], end - past, end)
    if (!byId[id]) throw new Error('keine Messdaten für Station')
    return { times, ...byId[id] }
  })
}

/** Daten für die Stationsansicht – gleiches Format wie früher das Go-Backend. */
export async function stationData(id, range) {
  const cfg = RANGES[range]
  if (!cfg) throw new Error('range muss day, week oder month sein')
  const stations = await snowStations()
  const station = stations.find((s) => s.id === id)
  if (!station) throw new Error(`Station ${id} unbekannt oder ohne Schneehöhenmessung`)

  const now = Date.now()
  const from = now - cfg.past
  const to = now + cfg.future
  const days = Math.min(16, Math.ceil(cfg.future / (24 * HOUR)) + 1)

  const [mRes, fRes] = await Promise.allSettled([stationMeasurements(id, range, cfg.past), stationForecast(station, days)])
  const resp = {
    station,
    range,
    now,
    from,
    to,
    resolutionMin: cfg.measBucket / 60e3,
    current: null,
    measurements: [],
    forecast: [],
    summary: {},
    errors: [],
    sources: {
      measurements: 'GeoSphere Austria – TAWES 10-Minuten-Stationsdaten (CC BY 4.0)',
      forecast: 'Open-Meteo.com – Wettermodelle (best match), auf Stationshöhe skaliert (CC BY 4.0)',
    },
  }
  if (mRes.status === 'rejected') resp.errors.push(`Messdaten (GeoSphere): ${mRes.reason.message}`)
  if (fRes.status === 'rejected') resp.errors.push(`Prognose (Open-Meteo): ${fRes.reason.message}`)

  let lastMeasT = null
  let lastMeasSnow = null
  if (mRes.status === 'fulfilled') {
    const m = mRes.value
    resp.measurements = aggregate(m.times, m, cfg.measBucket, from, now)
    resp.current = latestValues(m)
    for (let i = m.snow.length - 1; i >= 0; i--) {
      if (m.snow[i] != null) {
        lastMeasT = m.times[i]
        lastMeasSnow = m.snow[i]
        break
      }
    }
  }
  if (fRes.status === 'fulfilled') {
    const fc = fRes.value
    resp.forecast = aggregate(fc.times, fc, cfg.fcBucket, floorTo(now, HOUR), to)
    resp.summary = summarize(fc, now, to, lastMeasT, lastMeasSnow)
  }
  return resp
}
