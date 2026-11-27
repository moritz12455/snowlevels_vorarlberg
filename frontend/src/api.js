// Datenzugriff: holt alles direkt von GeoSphere Austria und Open-Meteo (beide erlauben
// Abfragen aus dem Browser) – ein eigenes Backend ist nicht nötig.
import { mapData } from './data/map.js'
import { snowStations, stationData } from './data/stations.js'
import { checkAbort } from './data/util.js'

// Gemeinsam genutzte Abfragen werden nicht abgebrochen; ein abgebrochener Aufrufer
// bekommt nur das Ergebnis nicht mehr.
const withSignal = async (promise, signal) => {
  const v = await promise
  checkAbort(signal)
  return v
}

export const fetchStations = (signal) => withSignal(snowStations(), signal)

export const fetchStationData = (id, range, signal) => withSignal(stationData(id, range), signal)

export const fetchMap = (signal) => withSignal(mapData(), signal)
