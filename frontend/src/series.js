// Führt Messung und Prognose zu einer gemeinsamen, nach Zeit sortierten Reihe zusammen.
// Schlüssel: *M = Messung, *F = Prognose.
export function mergeSeries(data, aligned) {
  const off = aligned ? data.summary?.offsetCm ?? 0 : 0
  const rows = new Map()
  const row = (t) => {
    if (!rows.has(t)) rows.set(t, { t })
    return rows.get(t)
  }
  for (const p of data.measurements) {
    const r = row(p.t)
    r.snowM = p.snow
    r.tempM = p.temp
    r.windM = p.wind
    r.gustM = p.gust
  }
  for (const p of data.forecast) {
    const r = row(p.t)
    r.snowF = p.snow == null ? null : Math.max(0, Math.round((p.snow + off) * 10) / 10)
    r.snowRawF = p.snow
    r.tempF = p.temp
    r.windF = p.wind
    r.gustF = p.gust
    r.snowfallF = p.snowfall
  }
  return [...rows.values()].sort((a, b) => a.t - b.t)
}
