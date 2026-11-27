// Rechenkern der Karte: Zeitfenster-Summen, Farbskalen und das Zeichnen des Schneefelds.

// ---------- Farbskalen (sequenziell, eine Farbe: hell -> dunkel) ----------

export const SCALES = {
  snowfall: { stops: [0.5, 2, 5, 10, 20, 30, 50], label: 'Neuschnee', unit: 'cm' },
  depth: { stops: [1, 10, 20, 40, 60, 100, 150], label: 'Schneehöhe', unit: 'cm' },
}

// Blau-Rampe der Referenzpalette. Im dunklen Modus umgekehrt, damit viel Schnee hell leuchtet.
const RAMP_LIGHT = ['#b6d5f8', '#84b9f3', '#519ced', '#257de0', '#1b64be', '#1757ac', '#0e3d7e']
const RAMP_DARK = ['#1757ac', '#1b64be', '#257de0', '#338ced', '#6aabf1', '#9dc8f7', '#e1eefd']
const ALPHA = [0.4, 0.55, 0.66, 0.74, 0.8, 0.85, 0.9]

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const RGB_LIGHT = RAMP_LIGHT.map(hex)
const RGB_DARK = RAMP_DARK.map(hex)

export const rampColors = (dark) => (dark ? RAMP_DARK : RAMP_LIGHT)

/** Index der Farbstufe für einen Wert (-1 = unter der ersten Stufe). */
export function bandOf(v, scale) {
  const stops = scale.stops
  if (!(v >= stops[0])) return -1
  let i = 0
  while (i < stops.length - 1 && v >= stops[i + 1]) i++
  return i
}

/**
 * Wert -> [r, g, b, a(0..255)] in Stufen (wie Höhenschichten), damit Schwerpunkte klar
 * hervortreten. Unter der ersten Stufe wird weich ausgeblendet.
 */
export function colorFor(v, scale, dark, out) {
  const rgb = dark ? RGB_DARK : RGB_LIGHT
  const i = bandOf(v, scale)
  if (i < 0) {
    const f = v > 0 ? v / scale.stops[0] : 0
    out[0] = rgb[0][0]; out[1] = rgb[0][1]; out[2] = rgb[0][2]
    out[3] = 255 * ALPHA[0] * 0.5 * f * f
    return out
  }
  out[0] = rgb[i][0]; out[1] = rgb[i][1]; out[2] = rgb[i][2]; out[3] = 255 * ALPHA[i]
  return out
}

// ---------- Vorbereitung der Daten ----------

function cumulative(series, count) {
  const c = new Float32Array(count + 1)
  for (let i = 0; i < count; i++) c[i + 1] = c[i] + (series?.[i] ?? 0)
  return c
}

export function prepare(data) {
  const { grid, count } = data
  const n = grid.nLat * grid.nLon
  const cells = []
  for (let k = 0; k < n; k++) {
    if (!grid.snowfall?.[k]) {
      cells.push(null)
      continue
    }
    const lat = grid.lat0 + Math.floor(k / grid.nLon) * grid.dLat
    const lon = grid.lon0 + (k % grid.nLon) * grid.dLon
    cells.push({ k, lat, lon, inside: grid.inside[k], cum: cumulative(grid.snowfall[k], count), depth: grid.snowDepth[k] })
  }
  const stations = data.stations.map((s) => ({ ...s, cum: cumulative(s.snowfall, count) }))

  // Regionale Neuschnee-Kurve (Mittel über alle Zellen in Vorarlberg) für die Timeline.
  const inside = cells.filter((c) => c?.inside)
  const regional = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    let s = 0
    for (const c of inside) s += c.cum[i + 1] - c.cum[i]
    regional[i] = inside.length ? s / inside.length : 0
  }
  return { cells, stations, regional, hasGrid: inside.length > 0 }
}

export const windowSum = (cum, idx, hours) => cum[idx + 1] - cum[Math.max(0, idx + 1 - hours)]

/** Werte aller Rasterzellen zum Zeitpunkt idx (NaN = keine Daten). */
export function cellValues(prep, layer, idx, hours) {
  const out = new Float32Array(prep.cells.length).fill(NaN)
  prep.cells.forEach((c, k) => {
    if (!c) return
    out[k] = layer === 'snowfall' ? windowSum(c.cum, idx, hours) : c.depth[idx]
  })
  return out
}

/** Zelle mit dem höchsten Wert innerhalb Vorarlbergs. */
export function hotspot(prep, values) {
  let best = null
  prep.cells.forEach((c, k) => {
    if (c?.inside && values[k] > (best?.value ?? -1)) best = { lat: c.lat, lon: c.lon, value: values[k] }
  })
  return best
}

// ---------- Zeichnen ----------

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const invMercY = (y) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90

/** Ausdehnung des Overlays: jede Rasterzelle ist um ihren Punkt zentriert. */
export function overlayBounds(grid) {
  return {
    south: grid.lat0 - grid.dLat / 2,
    north: grid.lat0 + (grid.nLat - 0.5) * grid.dLat,
    west: grid.lon0 - grid.dLon / 2,
    east: grid.lon0 + (grid.nLon - 0.5) * grid.dLon,
  }
}

export function canvasSize(grid, width = 640) {
  const b = overlayBounds(grid)
  const ratio = (mercY(b.north) - mercY(b.south)) / (((b.east - b.west) * Math.PI) / 180)
  return { width, height: Math.round(width * ratio) }
}

const fieldCanvas = document.createElement('canvas')
const rgba = [0, 0, 0, 0]

/**
 * Zeichnet das Feld: bilinear interpoliert (in Web-Mercator, passend zu Leaflet),
 * eingefärbt und auf die Landesgrenze zugeschnitten.
 */
export function renderField(canvas, grid, values, scale, dark, ring) {
  const b = overlayBounds(grid)
  const { width: W, height: H } = canvas
  const yN = mercY(b.north)
  const yS = mercY(b.south)

  // 1) Werte auf ein Zwischenraster (6x pro Zelle) interpolieren und einfärben
  const fw = grid.nLon * 14
  const fh = Math.max(1, Math.round((fw * H) / W))
  fieldCanvas.width = fw
  fieldCanvas.height = fh
  const fctx = fieldCanvas.getContext('2d')
  const img = fctx.createImageData(fw, fh)
  const px = img.data
  const { nLat, nLon } = grid
  const at = (i, j) => (i < 0 || j < 0 || i >= nLat || j >= nLon ? NaN : values[i * nLon + j])

  for (let y = 0; y < fh; y++) {
    const lat = invMercY(yN - ((y + 0.5) / fh) * (yN - yS))
    const gi = (lat - grid.lat0) / grid.dLat
    const i0 = Math.floor(gi)
    const fi = gi - i0
    for (let x = 0; x < fw; x++) {
      const lon = b.west + ((x + 0.5) / fw) * (b.east - b.west)
      const gj = (lon - grid.lon0) / grid.dLon
      const j0 = Math.floor(gj)
      const fj = gj - j0
      let sum = 0
      let wsum = 0
      const add = (v, w) => {
        if (!Number.isNaN(v) && w > 0) { sum += v * w; wsum += w }
      }
      add(at(i0, j0), (1 - fi) * (1 - fj))
      add(at(i0, j0 + 1), (1 - fi) * fj)
      add(at(i0 + 1, j0), fi * (1 - fj))
      add(at(i0 + 1, j0 + 1), fi * fj)
      const o = (y * fw + x) * 4
      if (wsum < 0.05) { px[o + 3] = 0; continue }
      colorFor(sum / wsum, scale, dark, rgba)
      px[o] = rgba[0]; px[o + 1] = rgba[1]; px[o + 2] = rgba[2]; px[o + 3] = rgba[3]
    }
  }
  fctx.putImageData(img, 0, 0)

  // 2) Hochskalieren und auf Vorarlberg zuschneiden
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, W, H)
  ctx.save()
  ctx.beginPath()
  ring.forEach(([lon, lat], n) => {
    const x = ((lon - b.west) / (b.east - b.west)) * W
    const y = ((yN - mercY(lat)) / (yN - yS)) * H
    if (n === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.closePath()
  ctx.clip()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(fieldCanvas, 0, 0, W, H)
  ctx.restore()
}
