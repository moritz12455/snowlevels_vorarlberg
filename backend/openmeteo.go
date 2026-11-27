package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Open-Meteo Forecast API (kostenlos, kein API-Key nötig).
// Doku: https://open-meteo.com/en/docs
// Wird für die Prognose verwendet, solange GeoSphere keine Prognosen liefert.
const openMeteoBase = "https://api.open-meteo.com/v1/forecast"

type OpenMeteoClient struct {
	http *http.Client
}

type omResponse struct {
	Hourly struct {
		Time      []string   `json:"time"`
		SnowDepth []*float64 `json:"snow_depth"`     // m
		Temp      []*float64 `json:"temperature_2m"` // °C
		Wind      []*float64 `json:"wind_speed_10m"` // km/h
		Gust      []*float64 `json:"wind_gusts_10m"` // km/h
		Snowfall  []*float64 `json:"snowfall"`       // cm
	} `json:"hourly"`
	Error  bool   `json:"error"`
	Reason string `json:"reason"`
}

type ForecastSeries struct {
	Times    []time.Time
	Snow     []*float64 // cm
	Temp     []*float64
	Wind     []*float64
	Gust     []*float64
	Snowfall []*float64
}

// MultiHourly fragt mehrere Koordinaten auf einmal ab (Open-Meteo erlaubt kommagetrennte
// Listen). Ergebnis: Zeitachse (UTC) und pro Ort eine Map Variable -> Werte.
// Ist elevs nil, verwendet Open-Meteo sein eigenes 90-m-Höhenmodell.
func (c *OpenMeteoClient) MultiHourly(ctx context.Context, lats, lons, elevs []float64, vars []string, pastDays, forecastDays int) ([]time.Time, []map[string][]*float64, error) {
	const batch = 100
	var times []time.Time
	out := make([]map[string][]*float64, 0, len(lats))
	for from := 0; from < len(lats); from += batch {
		to := min(from+batch, len(lats))
		join := func(v []float64, digits int) string {
			s := make([]string, 0, to-from)
			for _, x := range v[from:to] {
				s = append(s, strconv.FormatFloat(x, 'f', digits, 64))
			}
			return strings.Join(s, ",")
		}
		q := url.Values{}
		q.Set("latitude", join(lats, 4))
		q.Set("longitude", join(lons, 4))
		if elevs != nil {
			q.Set("elevation", join(elevs, 0))
		}
		q.Set("hourly", strings.Join(vars, ","))
		q.Set("timezone", "UTC")
		q.Set("past_days", strconv.Itoa(pastDays))
		q.Set("forecast_days", strconv.Itoa(forecastDays))

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, openMeteoBase+"?"+q.Encode(), nil)
		if err != nil {
			return nil, nil, err
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return nil, nil, err
		}
		var raw json.RawMessage
		err = json.NewDecoder(resp.Body).Decode(&raw)
		resp.Body.Close()
		if err != nil {
			return nil, nil, fmt.Errorf("open-meteo: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			var e omResponse
			_ = json.Unmarshal(raw, &e)
			return nil, nil, fmt.Errorf("open-meteo: HTTP %d %s", resp.StatusCode, e.Reason)
		}
		// Bei einem einzelnen Ort kommt ein Objekt statt eines Arrays zurück.
		var items []struct {
			Hourly map[string]json.RawMessage `json:"hourly"`
		}
		if len(raw) > 0 && raw[0] == '{' {
			raw = append(append([]byte{'['}, raw...), ']')
		}
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, nil, fmt.Errorf("open-meteo: %w", err)
		}
		for _, it := range items {
			if times == nil {
				var ts []string
				if err := json.Unmarshal(it.Hourly["time"], &ts); err != nil {
					return nil, nil, fmt.Errorf("open-meteo: zeit: %w", err)
				}
				times = make([]time.Time, len(ts))
				for i, s := range ts {
					t, err := time.Parse("2006-01-02T15:04", s)
					if err != nil {
						return nil, nil, err
					}
					times[i] = t.UTC()
				}
			}
			m := map[string][]*float64{}
			for _, v := range vars {
				var vals []*float64
				_ = json.Unmarshal(it.Hourly[v], &vals)
				m[v] = vals
			}
			out = append(out, m)
		}
	}
	return times, out, nil
}

// Forecast lädt eine stündliche Prognose für die Stationskoordinaten. Über `elevation`
// rechnet Open-Meteo Temperatur & Co. auf die echte Stationshöhe herunter.
func (c *OpenMeteoClient) Forecast(ctx context.Context, st Station, days int) (*ForecastSeries, error) {
	if days < 1 {
		days = 1
	}
	if days > 16 {
		days = 16
	}
	q := url.Values{}
	q.Set("latitude", strconv.FormatFloat(st.Lat, 'f', 4, 64))
	q.Set("longitude", strconv.FormatFloat(st.Lon, 'f', 4, 64))
	q.Set("elevation", strconv.FormatFloat(st.Altitude, 'f', 0, 64))
	q.Set("hourly", "snow_depth,temperature_2m,wind_speed_10m,wind_gusts_10m,snowfall")
	q.Set("wind_speed_unit", "kmh")
	q.Set("timezone", "UTC")
	q.Set("past_days", "1")
	q.Set("forecast_days", strconv.Itoa(days))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, openMeteoBase+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var om omResponse
	if err := json.NewDecoder(resp.Body).Decode(&om); err != nil {
		return nil, fmt.Errorf("open-meteo: %w", err)
	}
	if resp.StatusCode != http.StatusOK || om.Error {
		return nil, fmt.Errorf("open-meteo: HTTP %d %s", resp.StatusCode, om.Reason)
	}

	h := om.Hourly
	fs := &ForecastSeries{
		Times:    make([]time.Time, len(h.Time)),
		Snow:     make([]*float64, len(h.Time)),
		Temp:     h.Temp,
		Wind:     h.Wind,
		Gust:     h.Gust,
		Snowfall: h.Snowfall,
	}
	for i, s := range h.Time {
		t, err := time.Parse("2006-01-02T15:04", s)
		if err != nil {
			return nil, fmt.Errorf("open-meteo: zeitstempel %q: %w", s, err)
		}
		fs.Times[i] = t.UTC()
		if i < len(h.SnowDepth) && h.SnowDepth[i] != nil {
			cm := round1(*h.SnowDepth[i] * 100)
			fs.Snow[i] = &cm
		}
	}
	return fs, nil
}
