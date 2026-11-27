import { useEffect, useRef } from 'react'
import { num } from '../format.js'

export default function StationTabs({ stations, selected, onSelect }) {
  const listRef = useRef(null)

  // ausgewählten Tab in den sichtbaren Bereich scrollen
  useEffect(() => {
    const el = listRef.current?.querySelector('[aria-selected="true"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [selected])

  const onKey = (e) => {
    const i = stations.findIndex((s) => s.id === selected)
    let next = null
    if (e.key === 'ArrowRight') next = stations[(i + 1) % stations.length]
    if (e.key === 'ArrowLeft') next = stations[(i - 1 + stations.length) % stations.length]
    if (next) {
      e.preventDefault()
      onSelect(next.id)
      requestAnimationFrame(() => listRef.current?.querySelector(`[data-id="${next.id}"]`)?.focus())
    }
  }

  return (
    <nav className="tabs-wrap" aria-label="Wetterstationen">
      <div className="tabs" role="tablist" ref={listRef} onKeyDown={onKey}>
        {stations.map((s) => {
          const active = s.id === selected
          return (
            <button
              key={s.id}
              data-id={s.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={active ? 'tab active' : 'tab'}
              onClick={() => onSelect(s.id)}
            >
              <span className="tab-name">{s.name}</span>
              <span className="tab-meta">
                {Math.round(s.altitude)} m
                <span className="tab-snow">{num(s.latestSnowCm)} cm</span>
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
