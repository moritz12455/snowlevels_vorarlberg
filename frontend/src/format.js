const TZ = 'Europe/Vienna'

const fmtTime = new Intl.DateTimeFormat('de-AT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
const fmtDay = new Intl.DateTimeFormat('de-AT', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' })
const fmtDate = new Intl.DateTimeFormat('de-AT', { timeZone: TZ, day: '2-digit', month: '2-digit' })
const fmtFull = new Intl.DateTimeFormat('de-AT', {
  timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
})
const fmtHour = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' })

export const time = (t) => fmtTime.format(t)
export const day = (t) => fmtDay.format(t)
export const date = (t) => fmtDate.format(t)
export const full = (t) => fmtFull.format(t)

export function num(v, digits = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–'
  return v.toLocaleString('de-AT', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

// Stunde (0–23) in Wiener Zeit – für Achsen-Ticks auf lokale Mitternacht etc.
const viennaHour = (t) => Number(fmtHour.format(t))

/**
 * Achsen-Ticks passend zum Zeitbereich, ausgerichtet auf Wiener Lokalzeit.
 * day: alle 6 h, week: täglich 00:00, month: alle 4 Tage 00:00
 */
export function makeTicks(from, to, range) {
  const H = 3600e3
  const stepH = range === 'day' ? 6 : 24
  const everyNthDay = range === 'month' ? 4 : 1
  const ticks = []
  let dayCount = 0
  // stündlich durchlaufen und passende Lokalstunden auswählen (robust bei Zeitumstellung)
  for (let t = Math.ceil(from / H) * H; t <= to; t += H) {
    const h = viennaHour(t)
    if (h % stepH !== 0) continue
    if (stepH === 24 && dayCount++ % everyNthDay !== 0) continue
    ticks.push(t)
  }
  return ticks
}

export function tickLabel(t, range) {
  if (range === 'day') return viennaHour(t) === 0 ? day(t) : time(t)
  if (range === 'week') return day(t)
  return date(t)
}
