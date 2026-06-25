package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// fakeCounter is an in-memory quotaCounter for tests. available=false simulates
// an unreachable store (fail-open path).
type fakeCounter struct {
	mu        sync.Mutex
	counts    map[string]int
	available bool
	incrs     int
}

func newFakeCounter(available bool) *fakeCounter {
	return &fakeCounter{counts: map[string]int{}, available: available}
}

func (f *fakeCounter) used(_ context.Context, key string) (int, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.available {
		return 0, false
	}
	return f.counts[key], true
}

func (f *fakeCounter) incr(_ context.Context, key string, _ time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.counts[key]++
	f.incrs++
}

func swapCounter(t *testing.T, c quotaCounter) {
	t.Helper()
	prev := defaultQuotaCounter
	defaultQuotaCounter = c
	t.Cleanup(func() { defaultQuotaCounter = prev })
}

// newCaptureRequest builds a POST /api/capture request with the shared secret.
func newCaptureRequest(body, secret string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/capture", bytes.NewBufferString(body))
	if secret != "" {
		req.Header.Set("X-NetWise-Key", secret)
	}
	return req
}

func doCapture(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	Handler(rec, req)
	return rec
}

func TestLocalDayFromClientNow(t *testing.T) {
	if got := localDay("2026-06-25T14:30:00"); got != "2026-06-25" {
		t.Fatalf("expected 2026-06-25, got %q", got)
	}
}

func TestLocalDayFallsBackWhenEmpty(t *testing.T) {
	if got := localDay(""); len(got) != 10 {
		t.Fatalf("expected a YYYY-MM-DD fallback, got %q", got)
	}
}

func TestNextLocalMidnight(t *testing.T) {
	if got := nextLocalMidnight("2026-06-25"); got != "2026-06-26T00:00:00" {
		t.Fatalf("expected 2026-06-26T00:00:00, got %q", got)
	}
}

func TestEvaluateQuotaOldClientUncounted(t *testing.T) {
	d, allowed := evaluateQuota(context.Background(), "", false, "2026-06-25T10:00:00")
	if !allowed {
		t.Fatal("old client should be allowed")
	}
	if d.enforced {
		t.Fatal("old client should not be enforced")
	}
}

func TestEvaluateQuotaUnlimitedSkipsStore(t *testing.T) {
	t.Setenv("AI_CAPTURE_DAILY_LIMIT_FREE", "0")
	fc := newFakeCounter(true)
	swapCounter(t, fc)
	d, allowed := evaluateQuota(context.Background(), "dev1", false, "2026-06-25T10:00:00")
	if !allowed || !d.enforced || d.limit != 0 {
		t.Fatalf("expected allowed/enforced/limit0, got %+v allowed=%v", d, allowed)
	}
}

func TestEvaluateQuotaBlocksWhenUsedAtLimit(t *testing.T) {
	t.Setenv("AI_CAPTURE_DAILY_LIMIT_FREE", "3")
	fc := newFakeCounter(true)
	fc.counts[quotaKey("dev1", "2026-06-25")] = 3
	swapCounter(t, fc)
	d, allowed := evaluateQuota(context.Background(), "dev1", false, "2026-06-25T10:00:00")
	if allowed {
		t.Fatal("should be blocked at limit")
	}
	if d.remaining != 0 {
		t.Fatalf("expected remaining 0, got %d", d.remaining)
	}
}

func TestEvaluateQuotaAllowsUnderLimit(t *testing.T) {
	t.Setenv("AI_CAPTURE_DAILY_LIMIT_FREE", "5")
	fc := newFakeCounter(true)
	fc.counts[quotaKey("dev1", "2026-06-25")] = 2
	swapCounter(t, fc)
	d, allowed := evaluateQuota(context.Background(), "dev1", false, "2026-06-25T10:00:00")
	if !allowed {
		t.Fatal("should be allowed under limit")
	}
	if d.remaining != 3 {
		t.Fatalf("expected remaining 3, got %d", d.remaining)
	}
}

func TestEvaluateQuotaFailsOpenWhenStoreDown(t *testing.T) {
	t.Setenv("AI_CAPTURE_DAILY_LIMIT_FREE", "1")
	fc := newFakeCounter(false) // unavailable
	swapCounter(t, fc)
	_, allowed := evaluateQuota(context.Background(), "dev1", false, "2026-06-25T10:00:00")
	if !allowed {
		t.Fatal("should fail open when store unavailable")
	}
}

func TestEvaluateQuotaPremiumUsesPremiumLimit(t *testing.T) {
	t.Setenv("AI_CAPTURE_DAILY_LIMIT_FREE", "1")
	t.Setenv("AI_CAPTURE_DAILY_LIMIT_PREMIUM", "10")
	fc := newFakeCounter(true)
	fc.counts[quotaKey("dev1", "2026-06-25")] = 5
	swapCounter(t, fc)
	_, allowed := evaluateQuota(context.Background(), "dev1", true, "2026-06-25T10:00:00")
	if !allowed {
		t.Fatal("premium under premium limit should be allowed")
	}
}

// --- Handler-level integration ---------------------------------------------

func TestCaptureReturns429WhenOverLimit(t *testing.T) {
	t.Setenv("AI_CAPTURE_DAILY_LIMIT_FREE", "2")
	fc := newFakeCounter(true)
	fc.counts[quotaKey("dev-over", localDay("2026-06-25T10:00:00"))] = 2
	swapCounter(t, fc)

	prev := defaultExtractor
	defaultExtractor = fakeExtractor{result: captureResult{IsTransaction: true}}
	defer func() { defaultExtractor = prev }()

	req := newCaptureRequest(`{"text":"KFC","now":"2026-06-25T10:00:00"}`, "test-secret")
	req.Header.Set("X-NetWise-Device", "dev-over")
	rec := doCapture(req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", rec.Code)
	}
	var body dailyLimitBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad body: %v", err)
	}
	if body.Error != "daily_limit" || body.Limit != 2 {
		t.Fatalf("unexpected body: %+v", body)
	}
	if rec.Header().Get("X-NetWise-Quota-Limit") != "2" {
		t.Fatalf("missing/incorrect quota header: %q", rec.Header().Get("X-NetWise-Quota-Limit"))
	}
}

func TestCaptureSetsQuotaHeadersOn200(t *testing.T) {
	t.Setenv("AI_CAPTURE_DAILY_LIMIT_FREE", "5")
	fc := newFakeCounter(true)
	fc.counts[quotaKey("dev-ok", localDay("2026-06-25T10:00:00"))] = 1
	swapCounter(t, fc)

	prev := defaultExtractor
	defaultExtractor = fakeExtractor{result: captureResult{IsTransaction: true, Kind: "wallet"}}
	defer func() { defaultExtractor = prev }()

	req := newCaptureRequest(`{"text":"KFC","now":"2026-06-25T10:00:00"}`, "test-secret")
	req.Header.Set("X-NetWise-Device", "dev-ok")
	rec := doCapture(req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	// used was 1, limit 5 → remaining 4 before increment, 3 after success.
	if got := rec.Header().Get("X-NetWise-Quota-Remaining"); got != "3" {
		t.Fatalf("expected remaining 3 after success, got %q", got)
	}
}

func TestCaptureFailureDoesNotIncrement(t *testing.T) {
	t.Setenv("AI_CAPTURE_DAILY_LIMIT_FREE", "5")
	fc := newFakeCounter(true)
	swapCounter(t, fc)

	prev := defaultExtractor
	defaultExtractor = fakeExtractor{err: errFakeExtractorFailed}
	defer func() { defaultExtractor = prev }()

	req := newCaptureRequest(`{"text":"KFC","now":"2026-06-25T10:00:00"}`, "test-secret")
	req.Header.Set("X-NetWise-Device", "dev-fail")
	rec := doCapture(req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", rec.Code)
	}
	if fc.incrs != 0 {
		t.Fatalf("expected no increments on failure, got %d", fc.incrs)
	}
}
