// Kleine Helfer: HTTP, Caching, Rundung.

export const HOUR = 3600e3
export const MIN10 = 600e3

export const r1 = (v) => Math.round(v * 10) / 10
export const floorTo = (t, step) => Math.floor(t / step) * step

export async function getJSON(url) {
  const res = await fetch(url)
  let body = null
  try {
    body = await res.json()
  } catch {
    /* kein JSON */
  }
  if (!res.ok) {
    const reason = body?.reason || body?.detail || body?.error || res.statusText
    throw new Error(`HTTP ${res.status}${reason ? ` – ${reason}` : ''}`)
  }
  return body
}

/** Wirft einen AbortError, falls die Anfrage inzwischen abgebrochen wurde. */
export function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError')
}

// ---------- Cache ----------
// Ergebnisse werden im Speicher gehalten (gleichzeitige Anfragen teilen sich ein Promise)
// und optional in localStorage, damit ein Neuladen der Seite die APIs nicht erneut belastet.
// Nach einem Fehler wird 90 s lang nicht neu angefragt; ein abgelaufener Wert wird dann
// weiter verwendet (besser alte Daten als gar keine).

const ERROR_TTL = 90e3
const PREFIX = 'schneehoehe:v1:'
const mem = new Map()

function readStore(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeStore(key, entry) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(entry))
  } catch {
    /* Speicher voll oder nicht verfügbar – dann eben nur im Speicher */
  }
}

export function cached(key, ttl, load, { persist = false } = {}) {
  const now = Date.now()
  let e = mem.get(key)
  if (!e && persist) {
    const stored = readStore(key)
    if (stored) {
      e = { value: stored.value, exp: stored.exp }
      mem.set(key, e)
    }
  }
  if (e?.value !== undefined && now < e.exp) return Promise.resolve(e.value)
  if (e?.pending) return e.pending
  if (e?.error && now < e.errExp) {
    return e.value !== undefined ? Promise.resolve(e.value) : Promise.reject(e.error)
  }

  const stale = e?.value
  const pending = load()
    .then((value) => {
      const entry = { value, exp: Date.now() + ttl }
      mem.set(key, entry)
      if (persist) writeStore(key, entry)
      return value
    })
    .catch((error) => {
      console.warn(`[daten] ${key}: ${error.message}`)
      mem.set(key, { value: stale, exp: 0, error, errExp: Date.now() + ERROR_TTL })
      if (stale !== undefined) return stale
      throw error
    })
  mem.set(key, { ...(e || {}), pending })
  return pending
}

export function forget(key) {
  mem.delete(key)
}
