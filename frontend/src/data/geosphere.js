// GeoSphere Austria Dataset API – TAWES 10-Minuten-Stationsdaten.
// Doku: https://dataset.api.hub.geosphere.at/v1/docs/
import { getJSON, r1 } from './util.js'

const BASE = 'https://dataset.api.hub.geosphere.at/v1'
const DATASET = 'tawes-v1-10min'

const queryTime = (t) => new Date(t).toISOString().slice(0, 16) // YYYY-MM-DDTHH:mm (UTC)

/** Aktive TAWES-Stationen in Vorarlberg (noch ohne Schnee-Filter). */
export async function vorarlbergStations() {
  const meta = await getJSON(`${BASE}/station/historical/${DATASET}/metadata`)
  return meta.stations.filter((s) => s.state?.toLowerCase() === 'vorarlberg' && s.is_active)
}

const kmh = (arr = []) => arr.map((v) => (v == null ? null : r1(v * 3.6)))
// Schneepegel rauschen bei aperem Boden leicht ins Negative (z. B. −1 cm).
const nonNegative = (arr = []) => arr.map((v) => (v == null ? null : Math.max(0, v)))

/**
 * Zeitreihen mehrerer Stationen im Zeitraum [start, end] (ms).
 * Ergebnis: { times: [ms], byId: { [id]: { snow, temp, wind, gust } } } – Schnee in cm,
 * Temperatur in °C, Wind/Böen in km/h.
 */
export async function timeseries(ids, params, start, end) {
  const q = new URLSearchParams({
    parameters: params.join(','),
    station_ids: ids.join(','),
    start: queryTime(start),
    end: queryTime(end),
  })
  const ts = await getJSON(`${BASE}/station/historical/${DATASET}?${q}`)
  const times = ts.timestamps.map((s) => Date.parse(s))
  const byId = {}
  for (const f of ts.features ?? []) {
    const p = f.properties.parameters
    byId[String(f.properties.station)] = {
      snow: nonNegative(p.SCHNEE?.data),
      temp: p.TL?.data ?? [],
      wind: kmh(p.FF?.data),
      gust: kmh(p.FFX?.data),
    }
  }
  return { times, byId }
}

/** "LATERNS/GAPFOHL" -> "Laterns/Gapfohl", "SCHROECKEN" -> "Schröcken" */
export function prettyName(n) {
  const special = { SCHROECKEN: 'Schröcken' }
  if (special[n]) return special[n]
  return n.toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (_, a, b) => a + b.toUpperCase())
}
