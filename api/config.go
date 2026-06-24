package handler

import (
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

//go:embed appconfig.json
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
	// OnOpenPaywallEnabled gates the launch paywall shown to non-premium users.
	OnOpenPaywallEnabled bool       `json:"onOpenPaywallEnabled"`
	// Overrides are evaluated server-side and never served to clients.
	Overrides []override `json:"overrides"`
}

var validStates = map[string]bool{"all": true, "premium": true, "off": true}

// knownEnvs are the only environment keywords recognized in the UA and in
// override match rules.
var knownEnvs = []string{"debug", "testflight", "appstore"}

// parseUserAgent extracts the app version and environment from a NetWise
// User-Agent. A missing or unrecognized UA yields empty strings, which makes
// every version- or env-bounded override fail to match (backward compatibility).
func parseUserAgent(ua string) (env, version string) {
	const prefix = "NetWise/"
	if i := strings.Index(ua, prefix); i >= 0 {
		rest := ua[i+len(prefix):]
		if j := strings.IndexAny(rest, " \t"); j >= 0 {
			version = rest[:j]
		} else {
			version = rest
		}
	}
	for _, e := range knownEnvs {
		if strings.Contains(ua, e) {
			env = e
			break
		}
	}
	return env, version
}

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

// parseVersion splits a dotted version into numeric components. Returns ok=false
// for an empty string or any non-numeric component, so callers can fail closed.
func parseVersion(s string) ([]int, bool) {
	if s == "" {
		return nil, false
	}
	parts := strings.Split(s, ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, false
		}
		out[i] = n
	}
	return out, true
}

// compareVersions returns -1, 0, or 1, padding the shorter slice with zeros.
func compareVersions(a, b []int) int {
	n := len(a)
	if len(b) > n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		var av, bv int
		if i < len(a) {
			av = a[i]
		}
		if i < len(b) {
			bv = b[i]
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	return 0
}

type matchRule struct {
	Env        string `json:"env"`
	MinVersion string `json:"minVersion"`
	MaxVersion string `json:"maxVersion"`
}

type override struct {
	Match                matchRule         `json:"match"`
	Features             map[string]string `json:"features"`
	Limits               map[string]int    `json:"limits"`
	OnOpenPaywallEnabled *bool             `json:"onOpenPaywallEnabled"`
}

// applies reports whether every present field of the rule matches the request.
// Version-bounded rules fail closed when the client version can't be parsed.
func (m matchRule) applies(env, version string) bool {
	if m.Env != "" && m.Env != env {
		return false
	}
	if m.MinVersion != "" || m.MaxVersion != "" {
		cv, ok := parseVersion(version)
		if !ok {
			return false
		}
		if m.MinVersion != "" {
			bv, bok := parseVersion(m.MinVersion)
			if !bok || compareVersions(cv, bv) < 0 {
				return false
			}
		}
		if m.MaxVersion != "" {
			bv, bok := parseVersion(m.MaxVersion)
			if !bok || compareVersions(cv, bv) > 0 {
				return false
			}
		}
	}
	return true
}

// setLimit applies a single named limit onto the struct, ignoring unknown keys.
func setLimit(l *configLimits, key string, v int) {
	switch key {
	case "wallets":
		l.Wallets = v
	case "portfolios":
		l.Portfolios = v
	case "categories":
		l.Categories = v
	case "tags":
		l.Tags = v
	}
}

// resolve merges every matching override onto a copy of base, in array order
// (later match wins), then clears Overrides so they are never served.
func resolve(base appConfig, env, version string) appConfig {
	out := base
	out.Features = make(map[string]string, len(base.Features))
	for k, v := range base.Features {
		out.Features[k] = v
	}
	for _, o := range base.Overrides {
		if !o.Match.applies(env, version) {
			continue
		}
		for k, v := range o.Features {
			out.Features[k] = v
		}
		for k, v := range o.Limits {
			setLimit(&out.Limits, k, v)
		}
		if o.OnOpenPaywallEnabled != nil {
			out.OnOpenPaywallEnabled = *o.OnOpenPaywallEnabled
		}
	}
	out.Overrides = nil
	return out
}
