import { useMemo, useState } from 'react'
import { full, num } from '../format.js'
import { mergeSeries } from '../series.js'

// Barrierefreie Tabellenansicht der Graph-Daten (aufklappbar).
export default function DataTable({ data, aligned }) {
  const [open, setOpen] = useState(false)
  const rows = useMemo(() => (open ? mergeSeries(data, aligned).reverse() : []), [open, data, aligned])

  return (
    <details className="panel table-panel" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Daten als Tabelle anzeigen</summary>
      {open && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Zeit</th>
                <th scope="col">Schnee gemessen</th>
                <th scope="col">Schnee Prognose</th>
                <th scope="col">Temp. gemessen</th>
                <th scope="col">Temp. Prognose</th>
                <th scope="col">Wind gemessen</th>
                <th scope="col">Wind Prognose</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.t} className={r.t > data.now ? 'future' : undefined}>
                  <td>{full(r.t)}</td>
                  <td>{r.snowM != null ? `${num(r.snowM)} cm` : ''}</td>
                  <td>{r.snowF != null ? `${num(r.snowF)} cm` : ''}</td>
                  <td>{r.tempM != null ? `${num(r.tempM, 1)} °C` : ''}</td>
                  <td>{r.tempF != null ? `${num(r.tempF, 1)} °C` : ''}</td>
                  <td>{r.windM != null ? `${num(r.windM)} km/h` : ''}</td>
                  <td>{r.windF != null ? `${num(r.windF)} km/h` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  )
}
