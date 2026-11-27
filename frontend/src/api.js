// Dünne Schicht über das Go-Backend.
const BASE = import.meta.env.VITE_API_BASE || ''

async function get(path, signal) {
  const res = await fetch(BASE + path, { signal })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

export const fetchStations = (signal) => get('/api/stations', signal)

export const fetchStationData = (id, range, signal) =>
  get(`/api/stations/${encodeURIComponent(id)}/data?range=${range}`, signal)

export const fetchMap = (signal) => get('/api/map', signal)
