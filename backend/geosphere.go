package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// GeoSphere Austria Dataset API – TAWES 10-Minuten-Stationsdaten.
// Doku: https://dataset.api.hub.geosphere.at/v1/docs/
const (
	geosphereBase    = "https://dataset.api.hub.geosphere.at/v1"
	geosphereDataset = "tawes-v1-10min"
	geoTimeLayout    = "2006-01-02T15:04-07:00"
	geoQueryLayout   = "2006-01-02T15:04"
)

type GeoSphereClient struct {
	http *http.Client
}

type geoStationMeta struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	State    string  `json:"state"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Altitude float64 `json:"altitude"`
	IsActive bool    `json:"is_active"`
}

type geoMetadata struct {
	Stations []geoStationMeta `json:"stations"`
}

type geoParam struct {
	Unit string     `json:"unit"`
	Data []*float64 `json:"data"`
}

type geoFeature struct {
	Properties struct {
		Station    any                 `json:"station"`
		Parameters map[string]geoParam `json:"parameters"`
	} `json:"properties"`
}

type geoTimeseries struct {
	Timestamps []string     `json:"timestamps"`
	Features   []geoFeature `json:"features"`
}

func (c *GeoSphereClient) getJSON(ctx context.Context, u string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("geosphere: HTTP %d für %s", resp.StatusCode, u)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// VorarlbergStations liefert alle aktiven TAWES-Stationen in Vorarlberg (noch ohne Schnee-Filter).
func (c *GeoSphereClient) VorarlbergStations(ctx context.Context) ([]geoStationMeta, error) {
	var meta geoMetadata
	u := fmt.Sprintf("%s/station/historical/%s/metadata", geosphereBase, geosphereDataset)
	if err := c.getJSON(ctx, u, &meta); err != nil {
		return nil, err
	}
	var out []geoStationMeta
	for _, s := range meta.Stations {
		if strings.EqualFold(s.State, "Vorarlberg") && s.IsActive {
			out = append(out, s)
		}
	}
	return out, nil
}

// StationSeries enthält die Rohwerte einer Station (10-Minuten-Auflösung).
type StationSeries struct {
	Times []time.Time
	Snow  []*float64 // cm
	Temp  []*float64 // °C
	Wind  []*float64 // km/h
	Gust  []*float64 // km/h
}

// Timeseries lädt SCHNEE, TL, FF und FFX für mehrere Stationen im Zeitraum [start, end].
func (c *GeoSphereClient) Timeseries(ctx context.Context, ids []string, params []string, start, end time.Time) (map[string]*StationSeries, error) {
	q := url.Values{}
	q.Set("parameters", strings.Join(params, ","))
	q.Set("station_ids", strings.Join(ids, ","))
	q.Set("start", start.UTC().Format(geoQueryLayout))
	q.Set("end", end.UTC().Format(geoQueryLayout))
	u := fmt.Sprintf("%s/station/historical/%s?%s", geosphereBase, geosphereDataset, q.Encode())

	var ts geoTimeseries
	if err := c.getJSON(ctx, u, &ts); err != nil {
		return nil, err
	}
	times := make([]time.Time, len(ts.Timestamps))
	for i, s := range ts.Timestamps {
		t, err := time.Parse(geoTimeLayout, s)
		if err != nil {
			return nil, fmt.Errorf("geosphere: zeitstempel %q: %w", s, err)
		}
		times[i] = t
	}

	out := map[string]*StationSeries{}
	for _, f := range ts.Features {
		id := fmt.Sprint(f.Properties.Station)
		p := f.Properties.Parameters
		s := &StationSeries{
			Times: times,
			Snow:  clampNonNegative(p["SCHNEE"].Data),
			Temp:  p["TL"].Data,
			Wind:  msToKmh(p["FF"].Data),
			Gust:  msToKmh(p["FFX"].Data),
		}
		out[id] = s
	}
	return out, nil
}

// clampNonNegative: Schneepegel rauschen bei aperem Boden leicht ins Negative (z. B. −1 cm).
func clampNonNegative(in []*float64) []*float64 {
	for i, v := range in {
		if v != nil && *v < 0 {
			z := 0.0
			in[i] = &z
		}
	}
	return in
}

func msToKmh(in []*float64) []*float64 {
	out := make([]*float64, len(in))
	for i, v := range in {
		if v != nil {
			k := round1(*v * 3.6)
			out[i] = &k
		}
	}
	return out
}

// FindSnowStations ermittelt dynamisch alle Vorarlberger Stationen, die in den
// letzten `lookback` Tagen tatsächlich Schneehöhe (SCHNEE) gemeldet haben.
func (c *GeoSphereClient) FindSnowStations(ctx context.Context, lookback time.Duration) ([]Station, error) {
	metas, err := c.VorarlbergStations(ctx)
	if err != nil {
		return nil, err
	}
	if len(metas) == 0 {
		return nil, fmt.Errorf("keine Vorarlberger Stationen in den Metadaten gefunden")
	}
	ids := make([]string, len(metas))
	for i, m := range metas {
		ids[i] = m.ID
	}
	end := time.Now().UTC().Truncate(10 * time.Minute)
	series, err := c.Timeseries(ctx, ids, []string{"SCHNEE"}, end.Add(-lookback), end)
	if err != nil {
		return nil, err
	}

	var stations []Station
	for _, m := range metas {
		s, ok := series[m.ID]
		if !ok {
			continue
		}
		count, total := 0, len(s.Snow)
		var latest *float64
		var latestAt time.Time
		for i, v := range s.Snow {
			if v != nil {
				count++
				latest = v
				latestAt = s.Times[i]
			}
		}
		if count == 0 {
			continue // misst keine Schneehöhe
		}
		st := Station{
			ID:           m.ID,
			Name:         prettyName(m.Name),
			Altitude:     m.Altitude,
			Lat:          m.Lat,
			Lon:          m.Lon,
			LatestSnowCm: latest,
			Coverage:     round1(float64(count) / float64(total) * 100),
		}
		if !latestAt.IsZero() {
			t := latestAt
			st.LatestAt = &t
		}
		stations = append(stations, st)
	}
	// Höchste Stationen zuerst – die sind für Schnee meist am interessantesten.
	sort.Slice(stations, func(i, j int) bool { return stations[i].Altitude > stations[j].Altitude })
	return stations, nil
}

// prettyName: "LATERNS/GAPFOHL" -> "Laterns/Gapfohl", "SCHROECKEN" -> "Schröcken"
func prettyName(n string) string {
	special := map[string]string{
		"SCHROECKEN": "Schröcken",
	}
	if v, ok := special[n]; ok {
		return v
	}
	var b strings.Builder
	upperNext := true
	for _, r := range strings.ToLower(n) {
		if upperNext && r >= 'a' && r <= 'z' {
			b.WriteRune(r - 32)
			upperNext = false
			continue
		}
		b.WriteRune(r)
		upperNext = r == '/' || r == ' ' || r == '-' || r == '('
	}
	return b.String()
}
