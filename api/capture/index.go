package handler

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/anthropics/anthropic-sdk-go"
)

const maxCaptureTextChars = 10000

// captureSecret is read from env at init; overridable in tests.
var captureSecret = os.Getenv("CAPTURE_SHARED_SECRET")

type walletRef struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Currency string `json:"currency"`
}

type categoryRef struct {
	Name     string `json:"name"`
	IsIncome bool   `json:"isIncome"`
}

type portfolioRef struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Market   string   `json:"market"`
	Holdings []string `json:"holdings"`
}

type captureRequest struct {
	Text       string         `json:"text"`
	Wallets    []walletRef    `json:"wallets"`
	Categories []categoryRef  `json:"categories"`
	Portfolios []portfolioRef `json:"portfolios"`
	// Now is the client's current local date/time as a timezone-less ISO-8601
	// string ("2006-01-02T15:04:05"). Used as the fallback for the now-required
	// wallet dateTime when the text carries no date — supplied by the client so
	// the fallback is in the user's wall-clock, not the server's UTC.
	Now string `json:"now"`
}

type walletExtraction struct {
	TargetWalletID string `json:"targetWalletId"`
	Direction      string `json:"direction"`
	Amount         string `json:"amount"`
	// CategoryName and DateTime are required (see walletSchema) so Claude always
	// fills them — best-fit category and the transaction date — leaving the
	// confirm form with fewer empty fields. Note stays optional.
	CategoryName string  `json:"categoryName"`
	Note         *string `json:"note"`
	DateTime     string  `json:"dateTime"`
}

type portfolioExtraction struct {
	TargetPortfolioID string `json:"targetPortfolioId"`
	Type              string `json:"type"`
	Symbol            string `json:"symbol"`
	Quantity          string `json:"quantity"`
	PricePerShare     string `json:"pricePerShare"`
	// DateTime is required (see portfolioSchema); fee and note stay optional —
	// a trade often has no fee, and forcing one would fabricate a value.
	Fee      *string `json:"fee"`
	Note     *string `json:"note"`
	DateTime string  `json:"dateTime"`
}

type transferExtraction struct {
	SourceWalletID      string  `json:"sourceWalletId"`
	DestinationWalletID string  `json:"destinationWalletId"`
	Amount              string  `json:"amount"`
	// Note stays optional; DateTime is required (see transferSchema).
	Note     *string `json:"note"`
	DateTime string  `json:"dateTime"`
}

type captureResult struct {
	IsTransaction bool                 `json:"isTransaction"`
	Kind          string               `json:"kind"`
	Confidence    float64              `json:"confidence"`
	Wallet        *walletExtraction    `json:"wallet"`
	Portfolio     *portfolioExtraction `json:"portfolio"`
	Transfer      *transferExtraction  `json:"transfer"`
}

// requestContext is an alias for context.Context, used in the extractor interface.
type requestContext = context.Context

type extractor interface {
	extract(ctx requestContext, req captureRequest) (captureResult, error)
}

// defaultExtractor is the live Claude-backed impl (Task 2); swapped in tests.
var defaultExtractor extractor = claudeExtractor{}

// Handler serves POST /api/capture (Vercel maps api/capture/ → /api/capture).
func Handler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	key := r.Header.Get("X-NetWise-Key")
	if !secretMatches(key, captureSecret) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req captureRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if len(req.Text) == 0 || utf8.RuneCountInString(req.Text) > maxCaptureTextChars {
		http.Error(w, "text length out of range", http.StatusBadRequest)
		return
	}

	// Per-device daily quota. Checked BEFORE Claude so an over-limit request never
	// reaches (or bills) the model; the counter is only incremented after success
	// so failures don't burn quota. Old clients send no device header → allowed,
	// uncounted (backward compatible).
	deviceID := strings.TrimSpace(r.Header.Get("X-NetWise-Device"))
	isPremium := r.Header.Get("X-NetWise-Premium") == "true"
	decision, allowed := evaluateQuota(r.Context(), deviceID, isPremium, req.Now)
	if !allowed {
		writeDailyLimit(w, decision, isPremium)
		return
	}

	result, err := defaultExtractor.extract(r.Context(), req)
	if err != nil {
		log.Printf("capture: extractor failed: %v", err)
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}

	decision.recordSuccess(r.Context())
	writeQuotaHeaders(w, decision)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(result)
}

// claudeExtractor is the real Claude-backed extractor (implemented in Task 2).
// For now it delegates to callClaude which is a placeholder.
type claudeExtractor struct{}

func (claudeExtractor) extract(ctx requestContext, req captureRequest) (captureResult, error) {
	return callClaude(ctx, req)
}

// secretMatches compares provided and expected secrets in constant time.
// Both are hashed to fixed length first to avoid leaking the expected secret's length.
func secretMatches(provided, expected string) bool {
	if expected == "" {
		return false
	}
	p := sha256.Sum256([]byte(provided))
	e := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(p[:], e[:]) == 1
}

// extractionToolName is the single forced tool Claude must call.
const extractionToolName = "record_transaction"

// claudeModel pins the extraction model. The spec's canonical id is
// "claude-haiku-4-5"; ModelClaudeHaiku4_5 resolves to exactly that wire value.
const claudeModel = anthropic.ModelClaudeHaiku4_5

// callClaude sends the OCR text to Claude Haiku and returns the structured
// extraction. Any failure (network, missing tool_use block, malformed JSON)
// returns an error so the handler maps it to 502.
func callClaude(ctx requestContext, req captureRequest) (captureResult, error) {
	client := anthropic.NewClient() // reads ANTHROPIC_API_KEY from env
	tool := extractionTool()

	resp, err := client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:      claudeModel,
		MaxTokens:  1024,
		System:     []anthropic.TextBlockParam{{Text: buildSystemPrompt(req)}},
		Messages:   []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(req.Text))},
		Tools:      []anthropic.ToolUnionParam{{OfTool: &tool}},
		ToolChoice: anthropic.ToolChoiceParamOfTool(extractionToolName),
	})
	if err != nil {
		return captureResult{}, err
	}

	for _, block := range resp.Content {
		if tu, ok := block.AsAny().(anthropic.ToolUseBlock); ok {
			var result captureResult
			if err := json.Unmarshal([]byte(tu.JSON.Input.Raw()), &result); err != nil {
				return captureResult{}, fmt.Errorf("claude: decode tool input: %w", err)
			}
			return result, nil
		}
	}

	return captureResult{}, fmt.Errorf("claude: no tool_use block in response")
}

// extractionTool defines the single strict tool whose input schema is the §5
// discriminated wallet/portfolio contract. Optional fields are absent from each
// object's "required" list; Claude omits them when a value is unreadable.
func extractionTool() anthropic.ToolParam {
	str := func(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }

	walletSchema := map[string]any{
		"type":                 "object",
		"description":          "Present only when kind == \"wallet\".",
		"additionalProperties": false,
		"properties": map[string]any{
			"targetWalletId": str("ID of the wallet this transaction belongs to. Must be one of the provided wallet IDs."),
			"direction": map[string]any{
				"type": "string", "enum": []any{"income", "expense"},
				"description": "\"expense\" for money leaving the wallet, \"income\" for money arriving.",
			},
			"amount":       str("Transaction amount as plain digits only, no thousands separators or currency symbol (e.g. \"45000\")."),
			"categoryName": str("REQUIRED. The best-matching category from the provided list, inferred from the merchant/description (e.g. a restaurant like KFC → \"Food\"). Copy the name EXACTLY from the list. Always pick the closest one; if nothing fits well, choose the most general expense/income category available."),
			"note":         str("Short description, usually the merchant or payee named in the text (e.g. \"KFC\"). Omit only if none is present."),
			"dateTime":     str("REQUIRED. Transaction date/time normalized to ISO-8601 (e.g. \"21 Jun 2026 20:18\" → \"2026-06-21T20:18:00\"). If the text contains no date/time, use the current date/time given in the prompt."),
		},
		"required": []any{"targetWalletId", "direction", "amount", "categoryName", "dateTime"},
	}

	portfolioSchema := map[string]any{
		"type":                 "object",
		"description":          "Present only when kind == \"portfolio\".",
		"additionalProperties": false,
		"properties": map[string]any{
			"targetPortfolioId": str("ID of the portfolio holding this symbol. Pick the portfolio whose holdings contains the traded ticker."),
			"type": map[string]any{
				"type": "string", "enum": []any{"buy", "sell", "dividend", "fee", "deposit", "withdrawal"},
				"description": "Transaction type.",
			},
			"symbol":        str("Bare ticker symbol, e.g. \"INTC\"."),
			"quantity":      str("Number of shares/units as plain digits."),
			"pricePerShare": str("Price per share/unit as plain digits."),
			"fee": str("The TOTAL of every trading cost on this trade, combined into ONE plain-digit number: broker " +
				"commission/brokerage, exchange & clearing fees, regulatory levies (IDX levy, US SEC fee, TAF), taxes " +
				"(VAT/PPN, GST, stamp duty), and for crypto the trading/maker/taker and network/withdrawal fees. Sum ALL such " +
				"lines — do not record only one. If the text shows only a net/total amount with no itemized costs, set fee to " +
				"(total − quantity × pricePerShare) ONLY when that difference is a small positive number. Never put the share " +
				"value or trade total in fee, and never let fee reach or exceed quantity × pricePerShare. Omit only when no fee " +
				"is shown and none can be inferred."),
			"note":     str("Short note, usually the merchant/broker named in the text. Omit only if none is present."),
			"dateTime": str("REQUIRED. Transaction date/time normalized to ISO-8601 (e.g. \"21 Jun 2026 20:18\" → \"2026-06-21T20:18:00\"). If the text contains no date/time, use the current date/time given in the prompt."),
		},
		"required": []any{"targetPortfolioId", "type", "symbol", "quantity", "pricePerShare", "dateTime"},
	}

	transferSchema := map[string]any{
		"type":                 "object",
		"description":          "Present only when kind == \"transfer\" — money moved between two of the user's OWN wallets.",
		"additionalProperties": false,
		"properties": map[string]any{
			"sourceWalletId":      str("ID of the wallet the money LEAVES — the sender / \"Account Source\" account. Must be one of the provided wallet IDs."),
			"destinationWalletId": str("ID of the wallet the money ARRIVES in — the recipient/destination account. Must be a DIFFERENT provided wallet ID from sourceWalletId."),
			"amount":              str("Transferred amount as plain digits only, no separators or currency symbol (e.g. \"2000000\")."),
			"note":                str("Short description if present in the text. Omit if none."),
			"dateTime":            str("REQUIRED. Transaction date/time normalized to ISO-8601 (e.g. \"26 Jun 2026 02:10\" → \"2026-06-26T02:10:00\"). If the text has no date/time, use the current date/time given in the prompt."),
		},
		"required": []any{"sourceWalletId", "destinationWalletId", "amount", "dateTime"},
	}

	return anthropic.ToolParam{
		Name:        extractionToolName,
		Description: anthropic.String("Record the single financial transaction found in the OCR text. Always call this exactly once."),
		Strict:      anthropic.Bool(true),
		InputSchema: anthropic.ToolInputSchemaParam{
			Properties: map[string]any{
				"isTransaction": map[string]any{
					"type":        "boolean",
					"description": "true only if the text clearly describes one concrete financial transaction.",
				},
				"kind": map[string]any{
					"type": "string", "enum": []any{"wallet", "portfolio", "transfer"},
					"description": "\"wallet\" for everyday spending/income; \"portfolio\" for buying/selling securities; \"transfer\" for money moved between two of the user's own wallets.",
				},
				"confidence": map[string]any{
					"type":        "number",
					"description": "Confidence in this extraction, from 0 to 1.",
				},
				"wallet":    walletSchema,
				"portfolio": portfolioSchema,
				"transfer":  transferSchema,
			},
			Required:    []string{"isTransaction", "confidence"},
			ExtraFields: map[string]any{"additionalProperties": false},
		},
	}
}

// buildSystemPrompt assembles the instruction prompt, embedding the user's
// wallet, category, and portfolio-holdings context so Claude can resolve
// targetWalletId/targetPortfolioId. Pure — no I/O — so it is unit-testable.
func buildSystemPrompt(req captureRequest) string {
	var b strings.Builder
	b.WriteString("You extract a single financial transaction from OCR text of a receipt, " +
		"bank notification, or brokerage confirmation, and record it via the record_transaction tool.\n\n")

	// Current date/time fallback for the now-required wallet dateTime. Prefer the
	// client's local clock (req.Now); fall back to server UTC if absent.
	now := strings.TrimSpace(req.Now)
	if now == "" {
		now = time.Now().UTC().Format("2006-01-02T15:04:05")
	}
	b.WriteString(fmt.Sprintf("Current date/time (user's local): %s\n\n", now))

	b.WriteString("Wallets (id — name — currency):\n")
	if len(req.Wallets) == 0 {
		b.WriteString("  (none)\n")
	}
	for _, w := range req.Wallets {
		b.WriteString(fmt.Sprintf("  - %s — %s — %s\n", w.ID, w.Name, w.Currency))
	}

	b.WriteString("\nCategories (name — income/expense):\n")
	if len(req.Categories) == 0 {
		b.WriteString("  (none)\n")
	}
	for _, c := range req.Categories {
		kind := "expense"
		if c.IsIncome {
			kind = "income"
		}
		b.WriteString(fmt.Sprintf("  - %s — %s\n", c.Name, kind))
	}

	b.WriteString("\nPortfolios (id — name — market — holdings):\n")
	if len(req.Portfolios) == 0 {
		b.WriteString("  (none)\n")
	}
	for _, p := range req.Portfolios {
		holdings := strings.Join(p.Holdings, ", ")
		if holdings == "" {
			holdings = "(no holdings)"
		}
		b.WriteString(fmt.Sprintf("  - %s — %s — %s — %s\n", p.ID, p.Name, p.Market, holdings))
	}

	b.WriteString("\nRules:\n")
	b.WriteString("- Choose targetWalletId/targetPortfolioId ONLY from the provided lists.\n")
	b.WriteString("- For a sold/bought ticker, pick the portfolio whose holdings contains it.\n")
	b.WriteString("- Extract every field whose information is present in the text. Normalizing it is expected, not guessing: " +
		"reformat any date/time into ISO-8601 and infer the best-fit category from the merchant (KFC → \"Food\").\n")
	b.WriteString("- dateTime is REQUIRED for every transaction (wallet and portfolio) — if the text has no " +
		"date/time, use the current date/time given above.\n")
	b.WriteString("- For a wallet transaction, categoryName is also REQUIRED — pick the closest category from the " +
		"list (copy the name EXACTLY; never invent a new one).\n")
	b.WriteString("- amount/quantity/pricePerShare/fee are plain-digit strings (no separators or symbols).\n")
	b.WriteString("- For a portfolio trade, fee is the COMBINED TOTAL of every trading cost — broker commission/brokerage, " +
		"exchange/clearing fees, regulatory levies (IDX levy, SEC fee, TAF), and taxes (VAT/PPN, GST, stamp duty); for crypto " +
		"include trading/maker/taker and network fees. Sum every such line into ONE number — never record just one of them. If " +
		"the text shows only a net total with no itemized costs, set fee to (total − quantity × pricePerShare) when that yields a " +
		"small positive amount; otherwise omit it. Never put the share value or trade total in fee, and never let fee reach or " +
		"exceed quantity × pricePerShare.\n")
	b.WriteString("- Only set isTransaction true for a clear, concrete financial transaction. For anything else — a " +
		"random photo, a menu, an article, a chat, or text too garbled to read — set isTransaction to false, give a " +
		"low confidence, and omit BOTH the wallet and portfolio objects. Never invent a transaction that isn't there.\n")

	return b.String()
}

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
