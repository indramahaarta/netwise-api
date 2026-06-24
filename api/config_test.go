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

func TestServesOnOpenPaywallField(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	Handler(rec, req)

	// The field must be present in the served body so the iOS app reads it
	// rather than falling back to its bundled default.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("response not an object: %v", err)
	}
	if _, ok := raw["onOpenPaywallEnabled"]; !ok {
		t.Fatalf("served config missing onOpenPaywallEnabled field")
	}

	var c appConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &c); err != nil {
		t.Fatalf("response body not valid config: %v", err)
	}
	if c.OnOpenPaywallEnabled {
		t.Fatalf("expected onOpenPaywallEnabled false in the shipped config")
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
	if c.SchemaVersion != 1 {
		t.Fatalf("expected schemaVersion 1, got %d", c.SchemaVersion)
	}
	if c.Limits.Wallets <= 0 {
		t.Fatalf("expected a positive served wallets limit, got %d", c.Limits.Wallets)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=300" {
		t.Fatalf("expected Cache-Control public, max-age=300, got %q", cc)
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
	// RFC 7232: a 304 must still carry the cache-validating headers.
	if rec2.Header().Get("ETag") != etag {
		t.Fatalf("expected ETag on 304 response")
	}
	if cc := rec2.Header().Get("Cache-Control"); cc != "public, max-age=300" {
		t.Fatalf("expected Cache-Control on 304 response, got %q", cc)
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

func TestParseVersion(t *testing.T) {
	cases := []struct {
		in   string
		want []int
		ok   bool
	}{
		{"1.0.2", []int{1, 0, 2}, true},
		{"1.0", []int{1, 0}, true},
		{"10", []int{10}, true},
		{"", nil, false},
		{"1.x.0", nil, false},
		{"1..2", nil, false},
	}
	for _, c := range cases {
		got, ok := parseVersion(c.in)
		if ok != c.ok {
			t.Fatalf("parseVersion(%q) ok = %v, want %v", c.in, ok, c.ok)
		}
		if ok && !equalInts(got, c.want) {
			t.Fatalf("parseVersion(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.2", "1.0.10", -1}, // numeric, not lexical
		{"1.0.10", "1.0.2", 1},
		{"1.0", "1.0.0", 0}, // zero-padding
		{"2.0", "1.9.9", 1},
		{"1.0.0", "1.0.0", 0},
	}
	for _, c := range cases {
		av, _ := parseVersion(c.a)
		bv, _ := parseVersion(c.b)
		if got := compareVersions(av, bv); got != c.want {
			t.Fatalf("compareVersions(%q,%q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestParseUserAgent(t *testing.T) {
	cases := []struct {
		ua          string
		wantEnv     string
		wantVersion string
	}{
		{"NetWise/1.0.2 (build 47; testflight; iOS 17.5)", "testflight", "1.0.2"},
		{"NetWise/1.0.0 (build 12; debug; iOS 18.0)", "debug", "1.0.0"},
		{"NetWise/2.1.0 (build 90; appstore; iOS 17.4)", "appstore", "2.1.0"},
		{"", "", ""},                          // no header
		{"Mozilla/5.0", "", ""},               // unrelated UA
		{"NetWise/1.0.2", "", "1.0.2"},        // version only, no env comment
	}
	for _, c := range cases {
		env, version := parseUserAgent(c.ua)
		if env != c.wantEnv || version != c.wantVersion {
			t.Fatalf("parseUserAgent(%q) = (%q,%q), want (%q,%q)",
				c.ua, env, version, c.wantEnv, c.wantVersion)
		}
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestMatchRuleApplies(t *testing.T) {
	cases := []struct {
		name        string
		m           matchRule
		env, ver    string
		want        bool
	}{
		{"empty match applies to all", matchRule{}, "appstore", "1.0.0", true},
		{"env match", matchRule{Env: "testflight"}, "testflight", "1.0.0", true},
		{"env mismatch", matchRule{Env: "testflight"}, "appstore", "1.0.0", false},
		{"min inclusive", matchRule{MinVersion: "1.0.2"}, "", "1.0.2", true},
		{"below min", matchRule{MinVersion: "1.0.2"}, "", "1.0.1", false},
		{"max inclusive", matchRule{MaxVersion: "2.0.0"}, "", "2.0.0", true},
		{"above max", matchRule{MaxVersion: "2.0.0"}, "", "2.0.1", false},
		{"range hit", matchRule{MinVersion: "1.0.0", MaxVersion: "2.0.0"}, "", "1.5.0", true},
		{"version-bound fails closed on empty version", matchRule{MinVersion: "1.0.0"}, "testflight", "", false},
		{"env+version both required", matchRule{Env: "testflight", MinVersion: "1.0.2"}, "appstore", "1.0.3", false},
	}
	for _, c := range cases {
		if got := c.m.applies(c.env, c.ver); got != c.want {
			t.Fatalf("%s: applies(%q,%q) = %v, want %v", c.name, c.env, c.ver, got, c.want)
		}
	}
}

func TestResolveMergesOverrides(t *testing.T) {
	pTrue := true
	base := appConfig{
		SchemaVersion: 2,
		Limits:        configLimits{Wallets: 6, Portfolios: 3, Categories: 8, Tags: 3},
		Features:      map[string]string{"aiCapture": "all", "smartInsights": "off"},
		Overrides: []override{
			{Match: matchRule{Env: "testflight", MinVersion: "1.0.2"},
				Features: map[string]string{"smartInsights": "all"}},
			{Match: matchRule{Env: "testflight"},
				Limits:               map[string]int{"wallets": 99},
				OnOpenPaywallEnabled: &pTrue},
		},
	}

	// TestFlight 1.0.3: both overrides apply.
	got := resolve(base, "testflight", "1.0.3")
	if got.Features["smartInsights"] != "all" {
		t.Fatalf("smartInsights = %q, want all", got.Features["smartInsights"])
	}
	if got.Limits.Wallets != 99 {
		t.Fatalf("wallets = %d, want 99", got.Limits.Wallets)
	}
	if !got.OnOpenPaywallEnabled {
		t.Fatalf("paywall = false, want true")
	}
	if got.Overrides != nil {
		t.Fatalf("overrides must be stripped, got %v", got.Overrides)
	}
	// Base must be untouched (deep copy).
	if base.Features["smartInsights"] != "off" {
		t.Fatalf("base mutated: smartInsights = %q", base.Features["smartInsights"])
	}

	// App Store same version: no override applies.
	store := resolve(base, "appstore", "1.0.3")
	if store.Features["smartInsights"] != "off" {
		t.Fatalf("appstore smartInsights = %q, want off", store.Features["smartInsights"])
	}
	if store.Limits.Wallets != 6 {
		t.Fatalf("appstore wallets = %d, want 6", store.Limits.Wallets)
	}

	// No UA at all: base config.
	none := resolve(base, "", "")
	if none.Features["smartInsights"] != "off" || none.Limits.Wallets != 6 {
		t.Fatalf("empty-UA resolve must equal base")
	}
}
