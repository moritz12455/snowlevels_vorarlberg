# Schneehöhen Vorarlberg ❄️

Webinterface für Schneehöhen an den Vorarlberger Wetterstationen: Messung und Prognose
in einem Graph, dazu Temperatur und Wind, umschaltbar zwischen Tag, Woche und Monat –
und eine Karte mit ziehbarer Timeline, die zeigt, wo in Vorarlberg am meisten Schnee fällt.

```
┌──────────────────────────┐  ───►  GeoSphere Austria Dataset API   (Messungen)
│  React (Vite), im Browser │
│  frontend/               │  ───►  Open-Meteo Forecast API         (Prognose, Kartenraster)
└──────────────────────────┘
```

Es gibt kein eigenes Backend: Beide APIs erlauben Abfragen direkt aus dem Browser (CORS),
das Frontend holt die Daten selbst und bereitet sie auf.

## Datenquellen

| Was | Quelle | Details |
|---|---|---|
| Messung | [GeoSphere Austria Dataset API](https://dataset.api.hub.geosphere.at/v1/docs/) – `tawes-v1-10min` | `SCHNEE` (cm), `TL` (°C), `FF` Mittelwind, `FFX` Böen (m/s → km/h) |
| Prognose | [Open-Meteo](https://open-meteo.com/en/docs) | `snow_depth`, `temperature_2m`, `wind_speed_10m`, `wind_gusts_10m`, `snowfall` – auf Stationshöhe skaliert |
| Karte: Raster | Open-Meteo, ~5-km-Raster (194 Punkte) | `snowfall`, `snow_depth`, 6 Tage zurück + 7 Tage voraus |
| Karte: Landesgrenze | Statistik Austria (CC BY 4.0) via [ginseng666/GeoJSON-TopoJSON-Austria](https://github.com/ginseng666/GeoJSON-TopoJSON-Austria) | `frontend/src/data/vorarlberg.json` |
| Karte: Relief & Ortsnamen | Esri World Hillshade / Light- & Dark-Gray-Reference | ohne API-Key |

GeoSphere liefert derzeit keine Prognosen, deshalb kommt die Prognose von Open-Meteo
(kostenlos, ohne API-Key). Um die Quelle zu tauschen, muss nur `frontend/src/data/openmeteo.js`
ersetzt werden.

**Stationsauswahl:** Beim Start werden die GeoSphere-Metadaten abgefragt, auf
`state = Vorarlberg` und aktive Stationen gefiltert, und behalten werden nur die, die in den
letzten 14 Tagen tatsächlich eine Schneehöhe gemeldet haben (aktuell 12 von 17).

## Starten

Voraussetzung: Node ≥ 20.

```bash
cd frontend
npm install
npm run dev              # http://localhost:5173
```

In VS Code geht es auch per Klick: Terminal → *Run Task…* → **Schneehöhen: App starten**.

**Produktiv:** `npm run build` erzeugt in `frontend/dist/` eine rein statische Seite, die auf
jedem Webserver läuft (GitHub Pages, Netlify, nginx …). Oder mit Docker:

```bash
docker build -t schneehoehe .
docker run -p 8080:80 schneehoehe
```

## Code-Aufbau

```
frontend/src/
├── api.js                 fetchStations / fetchStationData / fetchMap – Einstieg für die Komponenten
├── data/
│   ├── util.js            HTTP, Cache (Speicher + localStorage), Rundung
│   ├── geosphere.js       GeoSphere-TAWES: Metadaten und Zeitreihen
│   ├── openmeteo.js       Open-Meteo: stündliche Werte für einen oder viele Orte
│   ├── stations.js        Stationssuche, Aggregation, Kennzahlen für die Stationsansicht
│   ├── map.js             Kartenraster, Stationsreihen, Landesgrenze
│   └── vorarlberg.json    Landesgrenze (GeoJSON)
├── components/            Stationsansicht (Tabs, Graphen, Kennzahlen, Tabelle)
└── map/                   Kartenansicht (Leaflet, Feld-Rendering, Timeline)
```

| Zeitraum | Vergangenheit | Prognose | Auflösung |
|---|---|---|---|
| Tag | 24 h | 48 h | Messung 10 min, Prognose 1 h |
| Woche | 7 Tage | 7 Tage | 1 h |
| Monat | 30 Tage | 16 Tage (Maximum von Open-Meteo) | 3 h |

**Caching:** Stationsliste 1 h, Messungen 5–10 min, Stationsprognosen 30 min, Kartenraster 1 h.
Stationsliste, Raster und Stationsprognosen der Karte liegen zusätzlich in `localStorage`,
damit Neuladen die APIs nicht erneut belastet. Nach einem Fehler (z. B. Rate-Limit) wird eine
Quelle 90 s lang nicht erneut angefragt; vorhandene ältere Daten werden weiter angezeigt.
Fällt eine Quelle aus, erscheint ein Hinweis, die andere wird trotzdem angezeigt.

## Funktionen

### Karte

- Neuschnee der letzten 3, 24 oder 72 Stunden bis zum gewählten Zeitpunkt (oder die Schneehöhe) als
  Farbfläche in Stufen, auf die Landesgrenze zugeschnitten, darunter das Relief
- **Ziehbare Timeline** (6 Tage zurück, 7 Tage Prognose): Die Balken zeigen den mittleren Neuschnee in
  Vorarlberg je 3 h. Abspielen mit ▶, Pfeiltasten ±1 h, Bild↑/↓ ±24 h, Leertaste = Play/Pause
- Stationsmarker mit Neuschnee bzw. Schneehöhe, Klick öffnet die Detailansicht
- Markierung des Modell-Maximums und eine Rangliste „Wo schneit es am meisten?“

### Stationen

- Tabs pro Station (mit Seehöhe und aktueller Schneehöhe), per Pfeiltasten bedienbar
- Schneehöhe: Messung (blau, Fläche) und Prognose (orange, gestrichelt) im selben Graph, Linie „jetzt“
- Temperatur und Wind als eigene, synchronisierte Graphen (gemeinsamer Hover-Cursor)
- **Prognose an Messung angleichen:** Modell-Schneehöhe und Messung weichen oft ein paar cm voneinander ab.
  Mit dem Schalter wird die Prognose um diese Differenz verschoben, damit sie an der letzten Messung
  ansetzt.
- Kennzahlen, Tabellenansicht, heller und dunkler Modus, Auswahl in der URL
  (`?station=11251&range=week`, `?view=map`), automatische Aktualisierung alle 10 min

## Hinweise

- Die Modell-Schneehöhe ist eine grobe Größe (Rasterzelle, nicht Messfeld). Ab etwa 7–10 Tagen
  wechselt Open-Meteo auf gröbere Modelle, daher können dort Sprünge auftreten.
- Die Neuschneefläche der Karte ist Modell (auch für die Vergangenheit); die Schneehöhen an den
  Stationsmarkern sind bis „jetzt“ gemessen.
- Open-Meteo (kostenlos) erlaubt rund 10.000 Abfragen pro Tag und 5.000 pro Stunde **pro IP-Adresse**.
  Da jetzt jeder Browser selbst abfragt, zählt das pro Besucher; ein Kartenabruf kostet ca. 200,
  wird aber 1 h zwischengespeichert.
- Lizenz der Daten: GeoSphere Austria, Open-Meteo und Statistik Austria, jeweils CC BY 4.0
  (Quellenangabe ist im UI enthalten).
