package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEmbeddedConfigIsValid(t *testing.T) {
	var c appConfig
	if err := json.Unmarshal(configJSON, &c); err != nil {
		t.Fatalf("embedded config.json does not parse: %v", err)
	}
	if err := validate(c); err != nil {
		t.Fatalf("embedded config.json is invalid: %v", err)
	}
}

func TestHandlerServesJSON200(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	Handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("expected application/json, got %q", ct)
	}
	if rec.Header().Get("ETag") == "" {
		t.Fatalf("expected ETag header")
	}
	var c appConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &c); err != nil {
		t.Fatalf("response body not valid config: %v", err)
	}
	if c.Limits.Wallets < 0 {
		t.Fatalf("served wallets limit negative")
	}
}

func TestHandlerHonorsIfNoneMatch(t *testing.T) {
	req1 := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec1 := httptest.NewRecorder()
	Handler(rec1, req1)
	etag := rec1.Header().Get("ETag")

	req2 := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	req2.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	Handler(rec2, req2)

	if rec2.Code != http.StatusNotModified {
		t.Fatalf("expected 304 for matching ETag, got %d", rec2.Code)
	}
}

func TestValidateRejectsBadState(t *testing.T) {
	c := appConfig{SchemaVersion: 1, Features: map[string]string{"x": "maybe"}}
	if err := validate(c); err == nil {
		t.Fatalf("expected validation error for bad feature state")
	}
}

func TestValidateRejectsNegativeLimit(t *testing.T) {
	c := appConfig{SchemaVersion: 1, Limits: configLimits{Wallets: -1}}
	if err := validate(c); err == nil {
		t.Fatalf("expected validation error for negative limit")
	}
}
