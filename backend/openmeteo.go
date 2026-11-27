package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
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
