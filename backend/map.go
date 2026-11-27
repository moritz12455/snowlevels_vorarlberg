package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sync"
	"time"
)

// Landesgrenze Vorarlberg – Statistik Austria (CC BY 4.0),
// vereinfacht via github.com/ginseng666/GeoJSON-TopoJSON-Austria
//
//go:embed vorarlberg.geojson
var boundaryGeoJSON []byte

const (
	// Open-Meteo zählt Abfragen über 14 Tage mehrfach – daher 6 Tage zurück + 8 Tage (inkl. heute) voraus.
	mapPastDays     = 6
	mapForecastDays = 8
	mapFutureDays   = 7
	gridStepLat     = 0.045 // ≈ 5 km
	gridStepLon     = 0.065 // ≈ 5 km
	gridBufferDeg   = 0.07  // Rasterpunkte bis ~6 km außerhalb der Grenze mitnehmen (für weiche Ränder)
)

// ---------- Landesgrenze ----------

type Boundary struct {
	Ring                           [][2]float64 // lon, lat
	MinLon, MaxLon, MinLat, MaxLat float64
	Feature                        json.RawMessage
}

func loadBoundary() (*Boundary, error) {
	var f struct {
		Geometry struct {
			Coordinates [][][2]float64 `json:"coordinates"`
		} `json:"geometry"`
	}
	if err := json.Unmarshal(boundaryGeoJSON, &f); err != nil {
		return nil, err
	}
	if len(f.Geometry.Coordinates) == 0 {
		return nil, fmt.Errorf("grenze: keine koordinaten")
	}
	b := &Boundary{Ring: f.Geometry.Coordinates[0], Feature: boundaryGeoJSON,
		MinLon: 180, MaxLon: -180, MinLat: 90, MaxLat: -90}
	for _, p := range b.Ring {
		b.MinLon, b.MaxLon = math.Min(b.MinLon, p[0]), math.Max(b.MaxLon, p[0])
		b.MinLat, b.MaxLat = math.Min(b.MinLat, p[1]), math.Max(b.MaxLat, p[1])
	}
	return b, nil
}

// Contains: Punkt-in-Polygon (Ray Casting).
func (b *Boundary) Contains(lon, lat float64) bool {
	in := false
	r := b.Ring
	for i, j := 0, len(r)-1; i < len(r); j, i = i, i+1 {
		xi, yi, xj, yj := r[i][0], r[i][1], r[j][0], r[j][1]
		if (yi > lat) != (yj > lat) && lon < (xj-xi)*(lat-yi)/(yj-yi)+xi {
			in = !in
		}
	}
	return in
}

// Distance: ungefährer Abstand zur Grenzlinie in "Breitengrad-Grad" (Länge mit cos(lat) skaliert).
func (b *Boundary) Distance(lon, lat float64) float64 {
	k := math.Cos(lat * math.Pi / 180)
	best := math.Inf(1)
	r := b.Ring
	for i := 1; i < len(r); i++ {
		ax, ay := r[i-1][0]*k, r[i-1][1]
		bx, by := r[i][0]*k, r[i][1]
		px, py := lon*k, lat
		dx, dy := bx-ax, by-ay
		t := 0.0
		if l := dx*dx + dy*dy; l > 0 {
			t = math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/l))
		}
		ex, ey := ax+t*dx-px, ay+t*dy-py
		best = math.Min(best, math.Hypot(ex, ey))
	}
	return best
}

// ---------- Antwortformat ----------

type MapGrid struct {
	Lat0   float64 `json:"lat0"` // südlichster Rasterpunkt
	Lon0   float64 `json:"lon0"` // westlichster Rasterpunkt
	DLat   float64 `json:"dLat"`
	DLon   float64 `json:"dLon"`
	NLat   int     `json:"nLat"`
	NLon   int     `json:"nLon"`
	Inside []bool  `json:"inside"` // Zelle liegt in Vorarlberg (Index = iLat*nLon + iLon)
	// Pro Zelle eine Zeitreihe; null = Zelle nicht abgefragt (weit außerhalb).
	Snowfall  [][]float32 `json:"snowfall"`  // cm pro Stunde
	SnowDepth [][]float32 `json:"snowDepth"` // cm
	Elevation []float32   `json:"elevation"`
}

type MapStation struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Lat      float64    `json:"lat"`
	Lon      float64    `json:"lon"`
	Altitude float64    `json:"altitude"`
	Depth    []*float32 `json:"depth"`    // Schneehöhe: Messung bis jetzt, danach angeglichene Prognose
	Snowfall []*float32 `json:"snowfall"` // Modell-Neuschnee am Stationspunkt, cm/h
	OffsetCm *float64   `json:"offsetCm"`
}

type MapResponse struct {
	Now      int64             `json:"now"`
	Start    int64             `json:"start"`
	StepMs   int64             `json:"stepMs"`
	Count    int               `json:"count"`
	NowIndex int               `json:"nowIndex"`
	Grid     MapGrid           `json:"grid"`
	Stations []MapStation      `json:"stations"`
	Boundary json.RawMessage   `json:"boundary"`
	Errors   []string          `json:"errors,omitempty"`
	Sources  map[string]string `json:"sources"`
}

// ---------- Aufbau ----------

type gridData struct {
	grid  MapGrid
	times []time.Time
}

// loadGrid fragt das Neuschnee-/Schneehöhen-Raster über Vorarlberg bei Open-Meteo ab.
func (s *Server) loadGrid(ctx context.Context) (*gridData, error) {
	b := s.boundary
	lat0 := math.Floor((b.MinLat-gridBufferDeg)/gridStepLat) * gridStepLat
	lon0 := math.Floor((b.MinLon-gridBufferDeg)/gridStepLon) * gridStepLon
	nLat := int(math.Ceil((b.MaxLat+gridBufferDeg-lat0)/gridStepLat)) + 1
	nLon := int(math.Ceil((b.MaxLon+gridBufferDeg-lon0)/gridStepLon)) + 1

	g := MapGrid{Lat0: round4(lat0), Lon0: round4(lon0), DLat: gridStepLat, DLon: gridStepLon, NLat: nLat, NLon: nLon,
		Inside: make([]bool, nLat*nLon), Snowfall: make([][]float32, nLat*nLon),
		SnowDepth: make([][]float32, nLat*nLon), Elevation: make([]float32, nLat*nLon)}

	var lats, lons []float64
	var idx []int
	for i := 0; i < nLat; i++ {
		for j := 0; j < nLon; j++ {
			lat, lon := lat0+float64(i)*gridStepLat, lon0+float64(j)*gridStepLon
			k := i*nLon + j
			g.Inside[k] = b.Contains(lon, lat)
			if g.Inside[k] || b.Distance(lon, lat) <= gridBufferDeg {
				lats, lons, idx = append(lats, round4(lat)), append(lons, round4(lon)), append(idx, k)
			}
		}
	}

	times, res, err := s.om.MultiHourly(ctx, lats, lons, nil, []string{"snowfall", "snow_depth"}, mapPastDays, mapForecastDays)
	if err != nil {
		return nil, err
	}
	if len(res) != len(idx) {
		return nil, fmt.Errorf("open-meteo: %d statt %d Rasterpunkte", len(res), len(idx))
	}
	for n, k := range idx {
		g.Snowfall[k] = toF32(res[n]["snowfall"], 1)
		g.SnowDepth[k] = toF32(res[n]["snow_depth"], 100) // m -> cm
	}
	return &gridData{grid: g, times: times}, nil
}

func (s *Server) buildMap(ctx context.Context) (*MapResponse, error) {
	now := time.Now().UTC()
	start := now.Truncate(time.Hour).Add(-mapPastDays * 24 * time.Hour)
	count := (mapPastDays+mapFutureDays)*24 + 1
	nowIdx := mapPastDays * 24
	resp := &MapResponse{
		Now: now.UnixMilli(), Start: start.UnixMilli(), StepMs: time.Hour.Milliseconds(),
		Count: count, NowIndex: nowIdx, Boundary: s.boundary.Feature,
		Sources: map[string]string{
			"grid":     "Open-Meteo.com – Neuschnee & Schneehöhe im ~5-km-Raster (Modell, CC BY 4.0)",
			"stations": "GeoSphere Austria – TAWES-Schneehöhen (Messung, CC BY 4.0); Prognose Open-Meteo",
			"boundary": "Landesgrenze: Statistik Austria (CC BY 4.0)",
		},
	}

	stations, err := s.stations(ctx)
	if err != nil {
		return nil, err
	}

	var (
		wg      sync.WaitGroup
		grid    *gridData
		gErr    error
		meas    map[string]*StationSeries
		mErr    error
		stTimes []time.Time
		stFc    []map[string][]*float64
		sErr    error
	)
	wg.Add(3)
	go func() {
		defer wg.Done()
		v, err := s.cache.Get("map:grid", time.Hour, func() (any, error) { return s.loadGrid(ctx) })
		if err != nil {
			gErr = err
			return
		}
		grid = v.(*gridData)
	}()
	go func() {
		defer wg.Done()
		ids := make([]string, len(stations))
		for i, st := range stations {
			ids[i] = st.ID
		}
		v, err := s.cache.Get("map:meas", 10*time.Minute, func() (any, error) {
			end := now.Truncate(10 * time.Minute)
			return s.geo.Timeseries(ctx, ids, []string{"SCHNEE"}, start.Add(-time.Hour), end)
		})
		if err != nil {
			mErr = err
			return
		}
		meas = v.(map[string]*StationSeries)
	}()
	go func() {
		defer wg.Done()
		lats, lons, elevs := make([]float64, len(stations)), make([]float64, len(stations)), make([]float64, len(stations))
		for i, st := range stations {
			lats[i], lons[i], elevs[i] = st.Lat, st.Lon, st.Altitude
		}
		type stfc struct {
			t []time.Time
			v []map[string][]*float64
		}
		v, err := s.cache.Get("map:stfc", 30*time.Minute, func() (any, error) {
			t, v, err := s.om.MultiHourly(ctx, lats, lons, elevs, []string{"snowfall", "snow_depth"}, mapPastDays, mapForecastDays)
			return stfc{t, v}, err
		})
		if err != nil {
			sErr = err
			return
		}
		stTimes, stFc = v.(stfc).t, v.(stfc).v
	}()
	wg.Wait()

	if gErr != nil {
		resp.Errors = append(resp.Errors, "Raster (Open-Meteo): "+gErr.Error())
	}
	if mErr != nil {
		resp.Errors = append(resp.Errors, "Messungen (GeoSphere): "+mErr.Error())
	}
	if sErr != nil {
		resp.Errors = append(resp.Errors, "Stationsprognose (Open-Meteo): "+sErr.Error())
	}
	if gErr != nil && mErr != nil && sErr != nil {
		return nil, fmt.Errorf("keine Datenquelle erreichbar")
	}

	slot := func(t time.Time) int {
		d := t.Sub(start)
		if d < 0 || d%time.Hour != 0 {
			return -1
		}
		i := int(d / time.Hour)
		if i >= count {
			return -1
		}
		return i
	}

	// Raster auf die gemeinsame Zeitachse bringen.
	if grid != nil {
		g := grid.grid
		g.Snowfall = make([][]float32, len(grid.grid.Snowfall))
		g.SnowDepth = make([][]float32, len(grid.grid.SnowDepth))
		for k := range g.Snowfall {
			if grid.grid.Snowfall[k] == nil {
				continue
			}
			sf, sd := make([]float32, count), make([]float32, count)
			for i, t := range grid.times {
				if n := slot(t); n >= 0 {
					sf[n], sd[n] = grid.grid.Snowfall[k][i], grid.grid.SnowDepth[k][i]
				}
			}
			g.Snowfall[k], g.SnowDepth[k] = sf, sd
		}
		resp.Grid = g
	}

	// Stationen: Messung (stündlich gemittelt) bis jetzt, danach Prognose an letzte Messung angeglichen.
	for si, st := range stations {
		ms := MapStation{ID: st.ID, Name: st.Name, Lat: st.Lat, Lon: st.Lon, Altitude: st.Altitude,
			Depth: make([]*float32, count), Snowfall: make([]*float32, count)}

		lastIdx := -1
		if m := meas[st.ID]; m != nil {
			sum, cnt := make([]float64, count), make([]int, count)
			for i, t := range m.Times {
				if m.Snow[i] == nil {
					continue
				}
				// 10-Min-Werte der Stunde h (h-1:00 < t <= h:00) dem Slot h zuordnen
				n := slot(t.Add(59 * time.Minute).Truncate(time.Hour))
				if n >= 0 && n <= nowIdx {
					sum[n] += *m.Snow[i]
					cnt[n]++
				}
			}
			for n := range sum {
				if cnt[n] > 0 {
					v := float32(round1(sum[n] / float64(cnt[n])))
					ms.Depth[n] = &v
					lastIdx = n
				}
			}
		}

		if stFc != nil && si < len(stFc) {
			model := make([]*float64, count)
			for i, t := range stTimes {
				if n := slot(t); n >= 0 {
					model[n] = stFc[si]["snow_depth"][i]
					if v := stFc[si]["snowfall"][i]; v != nil {
						f := float32(round1(*v))
						ms.Snowfall[n] = &f
					}
				}
			}
			var off float64
			if lastIdx >= 0 && model[lastIdx] != nil {
				off = round1(float64(*ms.Depth[lastIdx]) - *model[lastIdx]*100)
				ms.OffsetCm = &off
			}
			for n := max(lastIdx+1, nowIdx+1); n < count; n++ {
				if model[n] != nil {
					v := float32(math.Max(0, round1(*model[n]*100+off)))
					ms.Depth[n] = &v
				}
			}
		}
		resp.Stations = append(resp.Stations, ms)
	}
	return resp, nil
}

func (s *Server) handleMap(w http.ResponseWriter, r *http.Request) {
	v, err := s.cache.Get("map", 10*time.Minute, func() (any, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		return s.buildMap(ctx)
	})
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Kartendaten konnten nicht geladen werden: "+err.Error())
		return
	}
	// Teilweise fehlgeschlagene Antworten nicht 10 Minuten lang festhalten.
	if m := v.(*MapResponse); len(m.Errors) > 0 {
		s.cache.Delete("map")
	}
	writeJSON(w, http.StatusOK, v)
}

func toF32(in []*float64, factor float64) []float32 {
	out := make([]float32, len(in))
	for i, v := range in {
		if v != nil {
			out[i] = float32(round1(*v * factor))
		}
	}
	return out
}

func round4(v float64) float64 { return math.Round(v*1e4) / 1e4 }
