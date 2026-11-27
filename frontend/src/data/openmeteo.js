// Open-Meteo Forecast API (kostenlos, kein API-Key). Doku: https://open-meteo.com/en/docs
// Wird für die Prognose verwendet, solange GeoSphere keine Prognosen liefert.
import { getJSON } from './util.js'

const BASE = 'https://api.open-meteo.com/v1/forecast'

/**
 * Stündliche Werte für einen oder mehrere Orte. Ist `elevs` gesetzt, rechnet Open-Meteo
 * auf diese Höhe herunter, sonst nutzt es sein 90-m-Höhenmodell.
 * Ergebnis: { times: [ms], places: [{ [variable]: [werte] }] }
 */
export async function hourly({ lats, lons, elevs, vars, pastDays, forecastDays, windKmh = true }) {
  const BATCH = 100
  let times = null
  const places = []
  for (let from = 0; from < lats.length; from += BATCH) {
    const to = Math.min(from + BATCH, lats.length)
    const q = new URLSearchParams({
      latitude: lats.slice(from, to).map((v) => v.toFixed(4)).join(','),
      longitude: lons.slice(from, to).map((v) => v.toFixed(4)).join(','),
      hourly: vars.join(','),
      timezone: 'UTC',
      timeformat: 'unixtime',
      past_days: String(pastDays),
      forecast_days: String(forecastDays),
    })
    if (elevs) q.set('elevation', elevs.slice(from, to).map((v) => Math.round(v)).join(','))
    if (windKmh) q.set('wind_speed_unit', 'kmh')
    let body = await getJSON(`${BASE}?${q}`)
    if (!Array.isArray(body)) body = [body] // ein einzelner Ort kommt als Objekt
    for (const item of body) {
      if (!times) times = item.hourly.time.map((s) => s * 1000)
      const place = {}
      for (const v of vars) place[v] = item.hourly[v] ?? []
      places.push(place)
    }
  }
  return { times: times ?? [], places }
}
