import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { canvasSize, overlayBounds, renderField } from './field.js'

// Leaflet-ImageOverlay, das statt eines <img> direkt ein <canvas> positioniert
// (gleiches Prinzip wie L.SVGOverlay) – so kann bei jedem Timeline-Schritt neu gezeichnet werden.
const CanvasOverlay = L.ImageOverlay.extend({
  _initImage() {
    const el = (this._image = this._url)
    L.DomUtil.addClass(el, 'leaflet-image-layer')
    if (this._zoomAnimated) L.DomUtil.addClass(el, 'leaflet-zoom-animated')
    if (this.options.className) L.DomUtil.addClass(el, this.options.className)
    el.onselectstart = L.Util.falseFn
    el.onmousemove = L.Util.falseFn
  },
})

// Esri-Grundkarten (ohne API-Key nutzbar), dazu Relief-Schummerung.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services'
// Untergrund ist ein reines Relief – passt zu einer Schneekarte und lenkt nicht ab.
const TILES = {
  light: {
    base: `${ESRI}/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  },
  dark: {
    base: `${ESRI}/Elevation/World_Hillshade_Dark/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  },
}
const ATTRIBUTION =
  'Relief &amp; Beschriftung &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; OpenStreetMap-Mitwirkende'

export default function SnowMap({ data, values, scale, dark, stations, hotspot, onStationClick }) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const layersRef = useRef({})
  const canvasRef = useRef(null)
  const markersRef = useRef(new Map())
  const clickRef = useRef(onStationClick)
  useEffect(() => { clickRef.current = onStationClick }, [onStationClick])

  const ring = data.boundary.geometry.coordinates[0]

  // Karte einmalig aufbauen
  useEffect(() => {
    const map = L.map(elRef.current, {
      zoomControl: false,
      attributionControl: true,
      minZoom: 8,
      maxZoom: 13,
      zoomSnap: 0.25,
      scrollWheelZoom: true,
    })
    L.control.zoom({ position: 'topright' }).addTo(map)
    map.attributionControl.setPrefix(false)
    map.createPane('field').style.zIndex = 350
    map.createPane('mask').style.zIndex = 360
    map.createPane('labels').style.zIndex = 380
    map.getPane('labels').style.pointerEvents = 'none'

    const latlngs = ring.map(([lon, lat]) => [lat, lon])
    const bounds = L.latLngBounds(latlngs)
    map.fitBounds(bounds, { padding: [24, 24] })
    map.setMaxBounds(bounds.pad(0.8))

    mapRef.current = map
    const markers = markersRef.current
    // Größe nachführen (sonst sind Maske/Overlays auf die Anfangsgröße beschränkt)
    const ro = new ResizeObserver(() => {
      map.invalidateSize({ pan: false })
      map.fire('moveend')
    })
    ro.observe(elRef.current)
    requestAnimationFrame(() => {
      map.invalidateSize({ pan: false })
      map.fitBounds(bounds, { padding: [24, 24], animate: false })
    })
    return () => {
      ro.disconnect()
      map.remove()
      mapRef.current = null
      layersRef.current = {}
      markers.clear()
    }
  }, [ring])

  // Kartengrund (hell/dunkel), Maske außerhalb und Grenzlinie
  useEffect(() => {
    const map = mapRef.current
    const ls = layersRef.current
    ;['base', 'labels', 'mask', 'border'].forEach((k) => ls[k]?.remove())
    const t = dark ? TILES.dark : TILES.light
    ls.base = L.tileLayer(t.base, { attribution: ATTRIBUTION, maxNativeZoom: 16, className: dark ? 'relief-dark' : 'relief-light' }).addTo(map)
    ls.labels = L.tileLayer(t.labels, { pane: 'labels', opacity: 0.9, maxNativeZoom: 16 }).addTo(map)

    const latlngs = ring.map(([lon, lat]) => [lat, lon])
    const world = [[-89, -179], [-89, 179], [89, 179], [89, -179]]
    ls.mask = L.polygon([world, latlngs], {
      pane: 'mask', renderer: L.svg({ pane: 'mask', padding: 1.5 }), stroke: false, fillColor: dark ? '#0b0d10' : '#f3f6fa', fillOpacity: dark ? 0.55 : 0.55, interactive: false,
    }).addTo(map)
    ls.border = L.polygon(latlngs, {
      pane: 'mask', color: dark ? '#9dc8f7' : '#1757ac', weight: 1.6, opacity: 0.8, fill: false, interactive: false,
    }).addTo(map)
  }, [dark, ring])

  // Canvas-Overlay einmal pro Datensatz anlegen
  useEffect(() => {
    const map = mapRef.current
    const canvas = document.createElement('canvas')
    const { width, height } = canvasSize(data.grid)
    canvas.width = width
    canvas.height = height
    canvasRef.current = canvas
    const b = overlayBounds(data.grid)
    const overlay = new CanvasOverlay(canvas, [[b.south, b.west], [b.north, b.east]], { pane: 'field', interactive: false })
    overlay.addTo(map)
    return () => overlay.remove()
  }, [data.grid])

  // Feld bei jeder Änderung neu zeichnen
  useEffect(() => {
    if (canvasRef.current && values) renderField(canvasRef.current, data.grid, values, scale, dark, ring)
  }, [values, scale, dark, data.grid, ring])

  // Stationsmarker anlegen / aktualisieren
  useEffect(() => {
    const map = mapRef.current
    const markers = markersRef.current
    for (const s of stations) {
      let m = markers.get(s.id)
      if (!m) {
        m = L.marker([s.lat, s.lon], {
          icon: L.divIcon({ className: 'st-marker', html: '<div class="st-pin"><span class="st-dot"></span><span class="st-val"></span></div>', iconSize: null }),
          keyboard: true,
          title: s.name,
          riseOnHover: true,
        })
        m.on('click', () => clickRef.current?.(s.id))
        m.bindTooltip('', { direction: 'top', offset: [0, -14], className: 'st-tooltip', opacity: 1 })
        m.addTo(map)
        markers.set(s.id, m)
      }
      const el = m.getElement()
      if (el) {
        el.querySelector('.st-val').textContent = s.label
        el.classList.toggle('is-top', !!s.top)
        el.classList.toggle('is-forecast', !!s.forecast)
        el.querySelector('.st-dot').style.transform = `scale(${s.dotScale})`
      }
      m.setTooltipContent(s.tooltip)
    }
  }, [stations])

  // Hotspot-Markierung
  useEffect(() => {
    const map = mapRef.current
    const ls = layersRef.current
    ls.hot?.remove()
    if (!hotspot) return
    ls.hot = L.marker([hotspot.lat, hotspot.lon], {
      icon: L.divIcon({
        className: 'hot-marker',
        html: `<div class="hot-ring"></div><div class="hot-label">${hotspot.label}</div>`,
        iconSize: null,
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: -100,
    }).addTo(map)
  }, [hotspot])

  return <div ref={elRef} className="snowmap" role="region" aria-label="Karte von Vorarlberg mit Schneedaten" />
}
