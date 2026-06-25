package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// quotaTTL is how long a per-device daily counter lives. Generously longer than
// a day so a counter spans any client/server timezone slop and self-expires.
const quotaTTL = 48 * time.Hour

// quotaCounter abstracts the per-device daily counter so tests can swap a fake.
type quotaCounter interface {
	// used returns the current count for the key. ok=false means the store is
	// unavailable, and the caller fails OPEN (allows the request).
	used(ctx context.Context, key string) (int, bool)
	// incr increments the key and (re)sets its TTL. Best-effort; errors ignored.
	incr(ctx context.Context, key string, ttl time.Duration)
}

// defaultQuotaCounter is the live Upstash-backed counter; swapped in tests.
var defaultQuotaCounter quotaCounter = newUpstashCounter()

// quotaLimit reads the enforcement limit for the tier from env. 0 (or absent /
// invalid) = unlimited. Kept in env (not the embedded appconfig.json) because the
// capture function is a separate Go package and cannot embed ../appconfig.json;
// the JSON carries only the display numbers, which must be kept in sync.
func quotaLimit(isPremium bool) int {
	key := "AI_CAPTURE_DAILY_LIMIT_FREE"
	if isPremium {
		key = "AI_CAPTURE_DAILY_LIMIT_PREMIUM"
	}
	n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// localDay derives the device-local calendar day ("2006-01-02") from the client's
// timezone-less `now` string. Falls back to server UTC when absent/unparseable.
func localDay(now string) string {
	now = strings.TrimSpace(now)
	if len(now) >= 10 {
		if _, err := time.Parse("2006-01-02", now[:10]); err == nil {
			return now[:10]
		}
	}
	return time.Now().UTC().Format("2006-01-02")
}

// nextLocalMidnight returns the start of the day after `day` as a timezone-less
// ISO-8601 string ("2006-01-02T00:00:00") — the local reset time. Empty on error.
func nextLocalMidnight(day string) string {
	d, err := time.Parse("2006-01-02", day)
	if err != nil {
		return ""
	}
	return d.AddDate(0, 0, 1).Format("2006-01-02T15:04:05")
}

func quotaKey(deviceID, day string) string {
	return fmt.Sprintf("aicap:%s:%s", deviceID, day)
}

// quotaDecision captures everything the handler needs to emit headers, decide a
// 429, and increment after a successful extraction.
type quotaDecision struct {
	enforced  bool // false → emit no headers, never count (old client)
	limit     int  // 0 = unlimited
	remaining int
	resetAt   string
	key       string
	counted   bool // true when a successful call should increment the store
}

// evaluateQuota decides whether the request is allowed and prepares header/state.
// Returns (decision, allowed). Old clients (no device id) are always allowed and
// never counted. Unlimited tiers report limit 0 and skip the store entirely.
func evaluateQuota(ctx context.Context, deviceID string, isPremium bool, now string) (quotaDecision, bool) {
	if deviceID == "" {
		return quotaDecision{enforced: false}, true
	}
	day := localDay(now)
	reset := nextLocalMidnight(day)
	limit := quotaLimit(isPremium)
	if limit <= 0 {
		// Unlimited: still surface limit 0 so the app shows "Unlimited"; no Redis.
		return quotaDecision{enforced: true, limit: 0, remaining: 0, resetAt: reset}, true
	}

	key := quotaKey(deviceID, day)
	used, ok := defaultQuotaCounter.used(ctx, key)
	if !ok {
		// Store unavailable: fail open and report a full quota. counted:false so a
		// successful extraction doesn't try to INCR a store we just failed to read
		// (which would record partial counts while we're reporting a full quota).
		return quotaDecision{enforced: true, limit: limit, remaining: limit, resetAt: reset}, true
	}

	remaining := limit - used
	if remaining < 0 {
		remaining = 0
	}
	// Accepted race: the read above and the INCR in recordSuccess are not atomic,
	// so concurrent requests from one device can over-count by the number in
	// flight. Harmless for a per-device daily cap on a phone (requests are
	// effectively serial) and it fails in the user's favor.
	allowed := used < limit
	return quotaDecision{enforced: true, limit: limit, remaining: remaining, resetAt: reset, key: key, counted: true}, allowed
}

// recordSuccess increments the counter after a successful extraction and reflects
// the decrement in the decision's remaining (for the 200 response headers).
func (d *quotaDecision) recordSuccess(ctx context.Context) {
	if !d.counted || d.key == "" {
		return
	}
	defaultQuotaCounter.incr(ctx, d.key, quotaTTL)
	if d.remaining > 0 {
		d.remaining--
	}
}

// writeQuotaHeaders emits the X-NetWise-Quota-* headers (skipped for old clients).
func writeQuotaHeaders(w http.ResponseWriter, d quotaDecision) {
	if !d.enforced {
		return
	}
	w.Header().Set("X-NetWise-Quota-Limit", strconv.Itoa(d.limit))
	w.Header().Set("X-NetWise-Quota-Remaining", strconv.Itoa(d.remaining))
	if d.resetAt != "" {
		w.Header().Set("X-NetWise-Quota-Reset", d.resetAt)
	}
}

// dailyLimitBody is the 429 response body the client maps to its limit screen.
type dailyLimitBody struct {
	Error        string `json:"error"`
	Limit        int    `json:"limit"`
	Remaining    int    `json:"remaining"`
	ResetAtLocal string `json:"resetAtLocal,omitempty"`
	Tier         string `json:"tier,omitempty"`
}

// writeDailyLimit writes the 429 daily-limit response (headers + body).
func writeDailyLimit(w http.ResponseWriter, d quotaDecision, isPremium bool) {
	tier := "free"
	if isPremium {
		tier = "premium"
	}
	writeQuotaHeaders(w, d)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(w).Encode(dailyLimitBody{
		Error:        "daily_limit",
		Limit:        d.limit,
		Remaining:    0,
		ResetAtLocal: d.resetAt,
		Tier:         tier,
	})
}

// --- Upstash Redis (REST) counter ------------------------------------------

type upstashCounter struct {
	baseURL string
	token   string
	hc      *http.Client
}

// noopCounter is used when Upstash env is not configured: it reports the store as
// unavailable so quota checks fail open (enforcement effectively disabled).
type noopCounter struct{}

func (noopCounter) used(context.Context, string) (int, bool)    { return 0, false }
func (noopCounter) incr(context.Context, string, time.Duration) {}

func newUpstashCounter() quotaCounter {
	base := strings.TrimRight(os.Getenv("UPSTASH_REDIS_REST_URL"), "/")
	token := os.Getenv("UPSTASH_REDIS_REST_TOKEN")
	if base == "" || token == "" {
		return noopCounter{}
	}
	return upstashCounter{baseURL: base, token: token, hc: &http.Client{Timeout: 3 * time.Second}}
}

func (u upstashCounter) used(ctx context.Context, key string) (int, bool) {
	var out struct {
		Result *string `json:"result"`
	}
	if !u.do(ctx, "/get/"+url.PathEscape(key), &out) {
		return 0, false
	}
	if out.Result == nil {
		return 0, true // key absent = 0 used
	}
	n, err := strconv.Atoi(*out.Result)
	if err != nil {
		return 0, true
	}
	return n, true
}

func (u upstashCounter) incr(ctx context.Context, key string, ttl time.Duration) {
	if !u.do(ctx, "/incr/"+url.PathEscape(key), nil) {
		return
	}
	u.do(ctx, fmt.Sprintf("/expire/%s/%d", url.PathEscape(key), int(ttl.Seconds())), nil)
}

// do issues a single Upstash REST command (path form) and optionally decodes the
// JSON result. Returns false on any transport/non-200 error so callers fail open.
func (u upstashCounter) do(ctx context.Context, path string, out any) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.baseURL+path, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+u.token)
	resp, err := u.hc.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return false
		}
	}
	return true
}
