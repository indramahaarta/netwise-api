package handler

import (
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
)

//go:embed config.json
var configJSON []byte

type configLimits struct {
	Wallets    int `json:"wallets"`
	Portfolios int `json:"portfolios"`
	Categories int `json:"categories"`
	Tags       int `json:"tags"`
}

type appConfig struct {
	SchemaVersion int               `json:"schemaVersion"`
	Limits        configLimits      `json:"limits"`
	Features      map[string]string `json:"features"`
}

var validStates = map[string]bool{"all": true, "premium": true, "off": true}

// validate returns an error if the embedded config is structurally unusable.
func validate(c appConfig) error {
	if c.SchemaVersion < 1 {
		return fmt.Errorf("schemaVersion must be >= 1, got %d", c.SchemaVersion)
	}
	if c.Limits.Wallets < 0 || c.Limits.Portfolios < 0 || c.Limits.Categories < 0 || c.Limits.Tags < 0 {
		return fmt.Errorf("limits must be >= 0")
	}
	for k, v := range c.Features {
		if !validStates[v] {
			return fmt.Errorf("feature %q has invalid state %q", k, v)
		}
	}
	return nil
}

// Handler serves the validated config document.
func Handler(w http.ResponseWriter, r *http.Request) {
	var c appConfig
	if err := json.Unmarshal(configJSON, &c); err != nil {
		http.Error(w, "config unparseable", http.StatusInternalServerError)
		return
	}
	if err := validate(c); err != nil {
		http.Error(w, "config invalid: "+err.Error(), http.StatusInternalServerError)
		return
	}

	etag := fmt.Sprintf(`"%x"`, sha256.Sum256(configJSON))
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "public, max-age=300")
	if match := r.Header.Get("If-None-Match"); match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(configJSON)
}
