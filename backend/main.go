// Schneehöhen Vorarlberg – Aggregations-API
//
// Sammelt Messdaten (Schneehöhe, Temperatur, Wind) der GeoSphere-Austria-TAWES-Stationen
// in Vorarlberg und Prognosedaten von Open-Meteo und liefert sie in einem einheitlichen
// Format an das React-Frontend.
//
//	GET /api/health
//	GET /api/stations
//	GET /api/stations/{id}/data?range=day|week|month
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- Datentypen der API ----------

type Station struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Altitude     float64    `json:"altitude"`
	Lat          float64    `json:"lat"`
	Lon          float64    `json:"lon"`
	LatestSnowCm *float64   `json:"latestSnowCm"`
	LatestAt     *time.Time `json:"latestAt,omitempty"`
	Coverage     float64    `json:"coverage"` // % der 10-Min-Werte mit Schneehöhe (letzte 14 Tage)
}

type Point struct {
	T    int64    `json:"t"` // Unix-Millisekunden (UTC)
	Snow *float64 `json:"snow"`
	Temp *float64 `json:"temp"`
	Wind *float64 `json:"wind"`
	Gust *float64 `json:"gust"`
	// nur Prognose:
	Snowfall *float64 `json:"snowfall,omitempty"`
}

type Current struct {
	T    int64    `json:"t"`
	Snow *float64 `json:"snow"`
	Temp *float64 `json:"temp"`
	Wind *float64 `json:"wind"`
	Gust *float64 `json:"gust"`
}

type ForecastSummary struct {
	Snow24h      *float64 `json:"snow24h"`      // prognostizierte Schneehöhe in 24 h (cm)
	SnowEnd      *float64 `json:"snowEnd"`      // Schneehöhe am Ende des Zeitraums (cm)
	NewSnow24h   float64  `json:"newSnow24h"`   // Neuschneesumme nächste 24 h (cm)
	NewSnowTotal float64  `json:"newSnowTotal"` // Neuschneesumme im Prognosezeitraum (cm)
	OffsetCm     *float64 `json:"offsetCm"`     // Messung minus Modell zum letzten Messzeitpunkt
	TempMin      *float64 `json:"tempMin"`
	TempMax      *float64 `json:"tempMax"`
	GustMax      *float64 `json:"gustMax"`
}

type DataResponse struct {
	Station       Station           `json:"station"`
	Range         string            `json:"range"`
	Now           int64             `json:"now"`
	From          int64             `json:"from"`
	To            int64             `json:"to"`
	ResolutionMin int               `json:"resolutionMin"`
	Current       *Current          `json:"current"`
	Measurements  []Point           `json:"measurements"`
	Forecast      []Point           `json:"forecast"`
	Summary       ForecastSummary   `json:"summary"`
	Errors        []string          `json:"errors,omitempty"`
	Sources       map[string]string `json:"sources"`
}

// ---------- Zeitbereiche ----------

type rangeCfg struct {
	past, future time.Duration
	measBucket   time.Duration
	fcBucket     time.Duration
}

var ranges = map[string]rangeCfg{
	"day":   {past: 24 * time.Hour, future: 48 * time.Hour, measBucket: 10 * time.Minute, fcBucket: time.Hour},
	"week":  {past: 7 * 24 * time.Hour, future: 7 * 24 * time.Hour, measBucket: time.Hour, fcBucket: time.Hour},
	"month": {past: 30 * 24 * time.Hour, future: 16 * 24 * time.Hour, measBucket: 3 * time.Hour, fcBucket: 3 * time.Hour},
}

// ---------- einfacher TTL-Cache ----------

type cacheEntry struct {
	val any
	exp time.Time
}

type Cache struct {
	mu sync.Mutex
	m  map[string]cacheEntry
}

func NewCache() *Cache { return &Cache{m: map[string]cacheEntry{}} }

// Get liefert einen frischen Wert oder lädt ihn neu. Schlägt das Laden fehl, wird – falls
// vorhanden – der abgelaufene Wert zurückgegeben (besser alte Daten als gar keine).
func (c *Cache) Get(key string, ttl time.Duration, load func() (any, error)) (any, error) {
	c.mu.Lock()
	e, ok := c.m[key]
	c.mu.Unlock()
	if ok && time.Now().Before(e.exp) {
		return e.val, nil
	}
	v, err := load()
	if err != nil {
		if ok {
			log.Printf("cache: %s neu laden fehlgeschlagen, verwende alte Daten: %v", key, err)
			return e.val, nil
		}
		return nil, err
	}
	c.mu.Lock()
	c.m[key] = cacheEntry{val: v, exp: time.Now().Add(ttl)}
	c.mu.Unlock()
	return v, nil
}

// ---------- Server ----------

type Server struct {
	geo   *GeoSphereClient
	om    *OpenMeteoClient
	cache *Cache
}

func (s *Server) stations(ctx context.Context) ([]Station, error) {
	v, err := s.cache.Get("stations", 1*time.Hour, func() (any, error) {
		return s.geo.FindSnowStations(ctx, 14*24*time.Hour)
	})
	if err != nil {
		return nil, err
	}
	return v.([]Station), nil
}

func (s *Server) handleStations(w http.ResponseWriter, r *http.Request) {
	st, err := s.stations(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Stationen konnten nicht geladen werden: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleData(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rng := r.URL.Query().Get("range")
	if rng == "" {
		rng = "week"
	}
	cfg, ok := ranges[rng]
	if !ok {
		writeErr(w, http.StatusBadRequest, "range muss day, week oder month sein")
		return
	}

	stations, err := s.stations(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	var station *Station
	for i := range stations {
		if stations[i].ID == id {
			station = &stations[i]
		}
	}
	if station == nil {
		writeErr(w, http.StatusNotFound, "Station "+id+" unbekannt oder ohne Schneehöhenmessung")
		return
	}

	now := time.Now().UTC()
	from := now.Add(-cfg.past)
	to := now.Add(cfg.future)
	resp := DataResponse{
		Station:       *station,
		Range:         rng,
		Now:           now.UnixMilli(),
		From:          from.UnixMilli(),
		To:            to.UnixMilli(),
		ResolutionMin: int(cfg.measBucket.Minutes()),
		Measurements:  []Point{},
		Forecast:      []Point{},
		Sources: map[string]string{
			"measurements": "GeoSphere Austria – TAWES 10-Minuten-Stationsdaten (CC BY 4.0)",
			"forecast":     "Open-Meteo.com – Wettermodelle (best match), auf Stationshöhe skaliert (CC BY 4.0)",
		},
	}

	var (
		wg   sync.WaitGroup
		meas *StationSeries
		fc   *ForecastSeries
		mErr error
		fErr error
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		key := "meas:" + id + ":" + rng
		v, err := s.cache.Get(key, 5*time.Minute, func() (any, error) {
			end := now.Truncate(10 * time.Minute)
			res, err := s.geo.Timeseries(r.Context(), []string{id}, []string{"SCHNEE", "TL", "FF", "FFX"}, end.Add(-cfg.past), end)
			if err != nil {
				return nil, err
			}
			ss, ok := res[id]
			if !ok {
				return nil, errors.New("keine Messdaten für Station")
			}
			return ss, nil
		})
		if err != nil {
			mErr = err
			return
		}
		meas = v.(*StationSeries)
	}()
	go func() {
		defer wg.Done()
		days := int(math.Ceil(cfg.future.Hours()/24)) + 1
		key := "fc:" + id + ":" + strconv.Itoa(days)
		v, err := s.cache.Get(key, 30*time.Minute, func() (any, error) {
			return s.om.Forecast(r.Context(), *station, days)
		})
		if err != nil {
			fErr = err
			return
		}
		fc = v.(*ForecastSeries)
	}()
	wg.Wait()

	if mErr != nil {
		resp.Errors = append(resp.Errors, "Messdaten (GeoSphere): "+mErr.Error())
	}
	if fErr != nil {
		resp.Errors = append(resp.Errors, "Prognose (Open-Meteo): "+fErr.Error())
	}

	var lastMeasT time.Time
	var lastMeasSnow *float64
	if meas != nil {
		resp.Measurements = aggregate(meas.Times, meas.Snow, meas.Temp, meas.Wind, meas.Gust, nil, cfg.measBucket, from, now)
		resp.Current = latest(meas)
		for i := len(meas.Times) - 1; i >= 0; i-- {
			if meas.Snow[i] != nil {
				lastMeasT, lastMeasSnow = meas.Times[i], meas.Snow[i]
				break
			}
		}
	}

	if fc != nil {
		// Prognose ab der aktuellen vollen Stunde.
		fcFrom := now.Truncate(time.Hour)
		resp.Forecast = aggregate(fc.Times, fc.Snow, fc.Temp, fc.Wind, fc.Gust, fc.Snowfall, cfg.fcBucket, fcFrom, to)
		resp.Summary = summarize(fc, now, to, lastMeasT, lastMeasSnow)
	}

	writeJSON(w, http.StatusOK, resp)
}

// ---------- Hilfsfunktionen für Zeitreihen ----------

// aggregate fasst Werte in Zeit-Buckets zusammen: Schneehöhe/Temperatur/Wind als Mittelwert,
// Böen als Maximum, Neuschnee als Summe. Leere Buckets werden ausgelassen.
func aggregate(times []time.Time, snow, temp, wind, gust, snowfall []*float64, bucket time.Duration, from, to time.Time) []Point {
	type acc struct {
		snow, temp, wind []float64
		gust, sf         *float64
	}
	var order []int64
	buckets := map[int64]*acc{}
	at := func(arr []*float64, i int) *float64 {
		if i < len(arr) {
			return arr[i]
		}
		return nil
	}
	for i, t := range times {
		if t.Before(from) || t.After(to) {
			continue
		}
		k := t.Truncate(bucket).UnixMilli()
		a, ok := buckets[k]
		if !ok {
			a = &acc{}
			buckets[k] = a
			order = append(order, k)
		}
		if v := at(snow, i); v != nil {
			a.snow = append(a.snow, *v)
		}
		if v := at(temp, i); v != nil {
			a.temp = append(a.temp, *v)
		}
		if v := at(wind, i); v != nil {
			a.wind = append(a.wind, *v)
		}
		if v := at(gust, i); v != nil && (a.gust == nil || *v > *a.gust) {
			g := *v
			a.gust = &g
		}
		if v := at(snowfall, i); v != nil {
			if a.sf == nil {
				a.sf = new(float64)
			}
			*a.sf += *v
		}
	}
	out := make([]Point, 0, len(order))
	for _, k := range order {
		a := buckets[k]
		p := Point{T: k, Snow: mean(a.snow), Temp: mean(a.temp), Wind: mean(a.wind), Gust: a.gust}
		if a.sf != nil {
			v := round1(*a.sf)
			p.Snowfall = &v
		}
		if p.Snow == nil && p.Temp == nil && p.Wind == nil {
			continue
		}
		out = append(out, p)
	}
	return out
}

func latest(s *StationSeries) *Current {
	pick := func(arr []*float64) (*float64, int) {
		for i := len(arr) - 1; i >= 0; i-- {
			if arr[i] != nil {
				return arr[i], i
			}
		}
		return nil, -1
	}
	c := &Current{}
	idx := -1
	for _, arr := range [][]*float64{s.Snow, s.Temp, s.Wind} {
		if _, i := pick(arr); i > idx {
			idx = i
		}
	}
	if idx < 0 {
		return nil
	}
	c.T = s.Times[idx].UnixMilli()
	c.Snow, _ = pick(s.Snow)
	c.Temp, _ = pick(s.Temp)
	c.Wind, _ = pick(s.Wind)
	c.Gust, _ = pick(s.Gust)
	return c
}

func summarize(fc *ForecastSeries, now, to, lastMeasT time.Time, lastMeasSnow *float64) ForecastSummary {
	var sum ForecastSummary
	in24 := now.Add(24 * time.Hour)
	bestDiff24 := time.Duration(math.MaxInt64)
	bestDiffMeas := time.Duration(math.MaxInt64)
	var modelAtMeas *float64
	for i, t := range fc.Times {
		snow := fc.Snow[i]
		if snow != nil && !lastMeasT.IsZero() {
			if d := absDur(t.Sub(lastMeasT)); d < bestDiffMeas {
				bestDiffMeas, modelAtMeas = d, snow
			}
		}
		if t.Before(now.Truncate(time.Hour)) || t.After(to) {
			continue
		}
		if snow != nil {
			if d := absDur(t.Sub(in24)); d < bestDiff24 {
				bestDiff24, sum.Snow24h = d, snow
			}
			sum.SnowEnd = snow
		}
		if i < len(fc.Snowfall) && fc.Snowfall[i] != nil {
			sum.NewSnowTotal += *fc.Snowfall[i]
			if t.Before(in24) {
				sum.NewSnow24h += *fc.Snowfall[i]
			}
		}
		if i < len(fc.Temp) && fc.Temp[i] != nil {
			v := *fc.Temp[i]
			if sum.TempMin == nil || v < *sum.TempMin {
				sum.TempMin = &v
			}
			if sum.TempMax == nil || v > *sum.TempMax {
				sum.TempMax = &v
			}
		}
		if i < len(fc.Gust) && fc.Gust[i] != nil {
			v := *fc.Gust[i]
			if sum.GustMax == nil || v > *sum.GustMax {
				sum.GustMax = &v
			}
		}
	}
	sum.NewSnow24h = round1(sum.NewSnow24h)
	sum.NewSnowTotal = round1(sum.NewSnowTotal)
	if lastMeasSnow != nil && modelAtMeas != nil && bestDiffMeas <= 2*time.Hour {
		off := round1(*lastMeasSnow - *modelAtMeas)
		sum.OffsetCm = &off
	}
	return sum
}

func mean(v []float64) *float64 {
	if len(v) == 0 {
		return nil
	}
	s := 0.0
	for _, x := range v {
		s += x
	}
	m := round1(s / float64(len(v)))
	return &m
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

// ---------- HTTP-Helfer ----------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s (%s)", r.Method, r.URL.RequestURI(), time.Since(start).Round(time.Millisecond))
		}
	})
}

// spaHandler liefert das gebaute Frontend aus und fällt für unbekannte Pfade auf index.html zurück.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		fs.ServeHTTP(w, r)
	})
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	httpClient := &http.Client{Timeout: 25 * time.Second}
	s := &Server{
		geo:   &GeoSphereClient{http: httpClient},
		om:    &OpenMeteoClient{http: httpClient},
		cache: NewCache(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/stations", s.handleStations)
	mux.HandleFunc("GET /api/stations/{id}/data", s.handleData)

	staticDir := env("STATIC_DIR", "../frontend/dist")
	if st, err := os.Stat(filepath.Join(staticDir, "index.html")); err == nil && !st.IsDir() {
		mux.Handle("/", spaHandler(staticDir))
		log.Printf("Frontend wird aus %s ausgeliefert", staticDir)
	}

	// Stationsliste im Hintergrund vorwärmen.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if st, err := s.stations(ctx); err != nil {
			log.Printf("Stationen vorladen fehlgeschlagen: %v", err)
		} else {
			log.Printf("%d Vorarlberger Stationen mit Schneehöhenmessung gefunden", len(st))
		}
	}()

	addr := ":" + env("PORT", "8080")
	log.Printf("API läuft auf http://localhost%s", addr)
	log.Fatal(http.ListenAndServe(addr, withLogging(withCORS(mux))))
}
