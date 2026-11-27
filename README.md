# Schneehöhen Vorarlberg ❄️

Webinterface für Schneehöhen an den Vorarlberger Wetterstationen: Messung und Prognose
in einem Graph, dazu Temperatur und Wind, umschaltbar zwischen Tag, Woche und Monat –
und eine Karte mit ziehbarer Timeline, die zeigt, wo in Vorarlberg am meisten Schnee fällt.

```
┌────────────────────┐      ┌──────────────────────┐      ┌───────────────────────────────┐
│  React (Vite)      │ ───► │  Go-API  :8080       │ ───► │ GeoSphere Austria (Messungen) │
│  frontend/         │ /api │  backend/            │ ───► │ Open-Meteo (Prognose)         │
└────────────────────┘      └──────────────────────┘      └───────────────────────────────┘
```

## Datenquellen

| Was | Quelle | Details |
|---|---|---|
| Messung | [GeoSphere Austria Dataset API](https://dataset.api.hub.geosphere.at/v1/docs/) – `tawes-v1-10min` | `SCHNEE` (cm), `TL` (°C), `FF` Mittelwind, `FFX` Böen (m/s → km/h) |
| Prognose | [Open-Meteo](https://open-meteo.com/en/docs) | `snow_depth`, `temperature_2m`, `wind_speed_10m`, `wind_gusts_10m`, `snowfall` – auf Stationshöhe skaliert |
| Karte: Raster | Open-Meteo, ~5-km-Raster (194 Punkte) | `snowfall`, `snow_depth`, 6 Tage zurück + 7 Tage voraus |
| Karte: Landesgrenze | Statistik Austria (CC BY 4.0) via [ginseng666/GeoJSON-TopoJSON-Austria](https://github.com/ginseng666/GeoJSON-TopoJSON-Austria) | `backend/vorarlberg.geojson`, ins Binary eingebettet |
| Karte: Relief & Ortsnamen | Esri World Hillshade / Light- & Dark-Gray-Reference | ohne API-Key |

GeoSphere liefert derzeit keine Prognosen, deshalb kommt die Prognose von Open-Meteo
(kostenlos, ohne API-Key). Um die Quelle zu tauschen, muss nur `backend/openmeteo.go`
ersetzt werden; das Frontend bleibt unverändert.

**Stationsauswahl:** Das Backend fragt beim Start die GeoSphere-Metadaten ab, filtert auf
`state = Vorarlberg` und aktive Stationen und behält nur die, die in den letzten 14 Tagen
tatsächlich eine Schneehöhe gemeldet haben (aktuell 12 von 17). Neue oder stillgelegte
Stationen werden so automatisch berücksichtigt (Aktualisierung stündlich).

## Starten

Voraussetzungen: Go ≥ 1.22, Node ≥ 20.

```bash
# 1) Backend
cd backend
go run .                 # http://localhost:8080

# 2) Frontend (zweites Terminal, Dev-Modus mit Hot Reload)
cd frontend
npm install
npm run dev              # http://localhost:5173, /api wird ans Backend weitergeleitet
```

**Produktiv (ein Prozess):**

```bash
cd frontend && npm install && npm run build
cd ../backend && go build -o schneehoehe-api . && ./schneehoehe-api
# Go liefert API + gebautes Frontend unter http://localhost:8080 aus
```

oder mit Docker:

```bash
docker build -t schneehoehe .
docker run -p 8080:8080 schneehoehe
```

Umgebungsvariablen (Backend): `PORT` (Standard `8080`), `STATIC_DIR` (Standard `../frontend/dist`).
Frontend: `API_URL` für den Dev-Proxy (Standard `http://localhost:8080`), `VITE_API_BASE`, falls die API
auf einem anderen Host läuft.

## API

### `GET /api/stations`
Vorarlberger Stationen mit Schneehöhenmessung, nach Seehöhe absteigend sortiert.

```json
[{ "id": "11251", "name": "Laterns/Gapfohl", "altitude": 1559, "lat": 47.275, "lon": 9.76,
   "latestSnowCm": 32, "latestAt": "2026-11-27T07:10:00Z", "coverage": 98 }]
```

### `GET /api/map`
Alles für die Kartenansicht in einer Antwort (gzip-komprimiert ca. 60 KB):

- `start`, `stepMs` (1 h), `count`, `nowIndex` – gemeinsame Zeitachse (6 Tage zurück bis 7 Tage voraus)
- `grid` – Raster (`lat0`, `lon0`, `dLat`, `dLon`, `nLat`, `nLon`), `inside` (Zelle in Vorarlberg),
  pro Zelle `snowfall` (cm/h) und `snowDepth` (cm); `null` für Zellen weit außerhalb
- `stations` – pro Station `depth` (gemessen bis jetzt, danach an die Messung angeglichene Prognose)
  und `snowfall` (Modell am Stationsort)
- `boundary` – Landesgrenze als GeoJSON

Caching: Raster 1 h, Stationsmessungen 10 min. Nach einem Fehler (z. B. Rate-Limit) wird die
Quelle 90 s lang nicht erneut angefragt.

### `GET /api/stations/{id}/data?range=day|week|month`

| range | Vergangenheit | Prognose | Auflösung |
|---|---|---|---|
| `day` | 24 h | 48 h | Messung 10 min, Prognose 1 h |
| `week` | 7 Tage | 7 Tage | 1 h |
| `month` | 30 Tage | 16 Tage (Maximum von Open-Meteo) | 3 h |

Antwort (gekürzt):

```json
{
  "station": { "...": "..." },
  "range": "week", "now": 1795764000000, "from": 1795159200000, "to": 1796368800000,
  "current":  { "t": 1795763400000, "snow": 32, "temp": -7.2, "wind": 5.8, "gust": 7.9 },
  "measurements": [{ "t": 1795762800000, "snow": 32, "temp": -7.2, "wind": 5.3, "gust": 7.9 }],
  "forecast":     [{ "t": 1795762800000, "snow": 27, "temp": -6.2, "wind": 1.1, "gust": 16.2, "snowfall": 0 }],
  "summary": { "snow24h": 26, "snowEnd": 8, "newSnow24h": 0, "newSnowTotal": 3.3,
               "offsetCm": 5, "tempMin": -7.1, "tempMax": 3.2, "gustMax": 28.1 },
  "errors": [],
  "sources": { "measurements": "...", "forecast": "..." }
}
```

Zeiten sind Unix-Millisekunden (UTC); Schnee in cm, Temperatur in °C, Wind in km/h.
Fällt eine der beiden Quellen aus, kommt die andere trotzdem, und die Meldung steht in `errors`.

**Caching:** Stationen 1 h, Messungen 5 min, Prognose 30 min. Schlägt ein Neuladen fehl,
werden die letzten Daten weiter ausgeliefert.

## Frontend-Funktionen

### Karte

- Neuschnee der letzten 3, 24 oder 72 Stunden bis zum gewählten Zeitpunkt (oder die Schneehöhe) als
  Farbfläche in Stufen, auf die Landesgrenze zugeschnitten, darunter das Relief
- **Ziehbare Timeline** (6 Tage zurück, 7 Tage Prognose): Die Balken zeigen den mittleren Neuschnee in
  Vorarlberg je 3 h, so sieht man sofort, wann es schneit. Abspielen mit ▶, Pfeiltasten ±1 h,
  Bild↑/↓ ±24 h, Leertaste = Play/Pause
- Stationsmarker mit Neuschnee bzw. Schneehöhe, die Station mit dem meisten Neuschnee ist hervorgehoben;
  Klick öffnet die Detailansicht
- Markierung des Modell-Maximums und eine Rangliste „Wo schneit es am meisten?“

### Stationen

- Tabs pro Station (mit Seehöhe und aktueller Schneehöhe), per Pfeiltasten bedienbar
- Schneehöhe: Messung (blau, Fläche) und Prognose (orange, gestrichelt) im selben Graph, Linie „jetzt“
- Temperatur und Wind als eigene, synchronisierte Graphen (gemeinsamer Hover-Cursor)
- **Prognose an Messung angleichen:** Modell-Schneehöhe und Messung weichen oft ein paar cm voneinander ab.
  Mit dem Schalter wird die Prognose um diese Differenz verschoben, damit sie an der letzten Messung
  ansetzt. Ohne Schalter: Modellwerte unverändert.
- Kennzahlen: Schneehöhe jetzt, Prognose in 24 h, Neuschnee, Temperatur, Wind/Böen
- Tabellenansicht, heller und dunkler Modus, Auswahl in der URL (`?station=11251&range=week`),
  automatische Aktualisierung alle 10 min

## Hinweise

- Die Modell-Schneehöhe ist eine grobe Größe (Rasterzelle, nicht Messfeld). Ab etwa 7–10 Tagen
  wechselt Open-Meteo auf gröbere Modelle, daher können dort Sprünge auftreten.
- Mittelberg meldet Schneehöhe nur lückenhaft; Lücken werden im Graph als Lücken gezeigt.
- Die Neuschneefläche der Karte ist Modell (auch für die Vergangenheit); die Schneehöhen an den
  Stationsmarkern sind bis „jetzt“ gemessen.
- Open-Meteo (kostenlos) erlaubt rund 10.000 Abfragen pro Tag und 5.000 pro Stunde; ein Raster-Abruf zählt
  ca. 200. Durch das Caching reicht das für den privaten Gebrauch locker.
- Lizenz der Daten: GeoSphere Austria und Open-Meteo, jeweils CC BY 4.0 (Quellenangabe ist im UI enthalten).
