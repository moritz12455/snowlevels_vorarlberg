import { useEffect, useMemo, useRef, useState } from 'react'
import { full } from '../format.js'

const H = 76 // Höhe der Balkenfläche
const BAR_H = 3 // Stunden pro Balken
const dayFmt = new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', weekday: 'short', day: 'numeric' })
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', hour: '2-digit', hourCycle: 'h23' })

/**
 * Ziehbare Zeitleiste: Balken = mittlerer Neuschnee in Vorarlberg (je 3 h),
 * hervorgehoben ist das gewählte Zeitfenster.
 */
export default function Timeline({ start, stepMs, count, nowIndex, index, onChange, windowH, showWindow, regional, playing, onTogglePlay }) {
  const wrapRef = useRef(null)
  const [width, setWidth] = useState(800)
  const dragging = useRef(false)

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, e.contentRect.width)))
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  const pad = 8
  const innerW = width - pad * 2
  const xOf = (i) => pad + (i / (count - 1)) * innerW
  const iOf = (x) => Math.round(((x - pad) / innerW) * (count - 1))
  const clamp = (i) => Math.max(0, Math.min(count - 1, i))

  const bars = useMemo(() => {
    const out = []
    for (let i = 0; i < count; i += BAR_H) {
      let s = 0
      for (let j = i; j < Math.min(count, i + BAR_H); j++) s += regional[j]
      out.push({ i, v: s })
    }
    return out
  }, [regional, count])
  const maxBar = Math.max(1, ...bars.map((b) => b.v))

  const midnights = useMemo(() => {
    const out = []
    for (let i = 0; i < count; i++) if (hourFmt.format(start + i * stepMs) === '00') out.push(i)
    return out
  }, [start, stepMs, count])

  const fromEvent = (e) => {
    const r = wrapRef.current.getBoundingClientRect()
    onChange(clamp(iOf(e.clientX - r.left)))
  }
  const onPointerDown = (e) => {
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    fromEvent(e)
  }
  const onPointerMove = (e) => dragging.current && fromEvent(e)
  const onPointerUp = () => { dragging.current = false }

  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1, PageUp: 24, PageDown: -24 }[e.key]
    if (step) { e.preventDefault(); onChange(clamp(index + step)) }
    if (e.key === 'Home') { e.preventDefault(); onChange(0) }
    if (e.key === 'End') { e.preventDefault(); onChange(count - 1) }
    if (e.key === ' ') { e.preventDefault(); onTogglePlay() }
  }

  const bw = Math.max(1, (innerW / (count - 1)) * BAR_H - 1.5)
  const x = xOf(index)
  const wx0 = xOf(Math.max(0, index - windowH + 1))
  const t = start + index * stepMs

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <button className="play" onClick={onTogglePlay} aria-label={playing ? 'Pause' : 'Abspielen'}>
          {playing ? (
            <svg viewBox="0 0 16 16" width="16" height="16"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 2.5v11a.8.8 0 0 0 1.2.7l9-5.5a.8.8 0 0 0 0-1.4l-9-5.5A.8.8 0 0 0 4 2.5z" /></svg>
          )}
        </button>
        <div className="timeline-time">
          <strong>{full(t)}</strong>
          <span className={index > nowIndex ? 'badge forecast' : 'badge'}>
            {index > nowIndex ? 'Prognose' : index === nowIndex ? 'jetzt' : 'Vergangenheit'}
          </span>
        </div>
        <button className="now-btn" onClick={() => onChange(nowIndex)} disabled={index === nowIndex}>
          Jetzt
        </button>
      </div>

      <div
        ref={wrapRef}
        className="timeline-track"
        role="slider"
        tabIndex={0}
        aria-label="Zeitpunkt"
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={index}
        aria-valuetext={full(t)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <svg width={width} height={H + 26}>
          {/* Prognose-Hintergrund */}
          <rect x={xOf(nowIndex)} y={0} width={xOf(count - 1) - xOf(nowIndex)} height={H} className="tl-future" />
          <text x={xOf(nowIndex) + 6} y={13} className="tl-zone">Prognose</text>
          <text x={xOf(nowIndex) - 6} y={13} className="tl-zone" textAnchor="end">Vergangenheit</text>

          {midnights.map((i) => (
            <g key={i}>
              <line x1={xOf(i)} x2={xOf(i)} y1={0} y2={H} className="tl-day" />
              <text x={xOf(i) + 4} y={H + 16} className="tl-label">{dayFmt.format(start + i * stepMs)}</text>
            </g>
          ))}

          {showWindow && <rect x={wx0} y={0} width={Math.max(2, x - wx0)} height={H} className="tl-window" />}

          {bars.map((b) => {
            const h = (b.v / maxBar) * (H - 22)
            return (
              <rect
                key={b.i}
                x={xOf(b.i)}
                y={H - h}
                width={bw}
                height={h}
                rx={Math.min(2, bw / 2)}
                className={b.i + BAR_H - 1 >= Math.max(0, index - windowH + 1) && b.i <= index && showWindow ? 'tl-bar active' : 'tl-bar'}
              />
            )
          })}
          <line x1={pad} x2={width - pad} y1={H} y2={H} className="tl-axis" />

          <line x1={xOf(nowIndex)} x2={xOf(nowIndex)} y1={0} y2={H} className="tl-now" />

          <g className="tl-thumb" transform={`translate(${x},0)`}>
            <line y1={0} y2={H} />
            <circle cy={H} r={7} />
          </g>
        </svg>
      </div>
      <p className="timeline-hint">Balken: mittlerer Neuschnee in Vorarlberg je 3 h (Modell) · ziehen oder mit ← → verschieben</p>
    </div>
  )
}
