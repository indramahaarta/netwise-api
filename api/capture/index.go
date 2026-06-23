package handler

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
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

type captureResult struct {
	IsTransaction bool                 `json:"isTransaction"`
	Kind          string               `json:"kind"`
	Confidence    float64              `json:"confidence"`
	Wallet        *walletExtraction    `json:"wallet"`
	Portfolio     *portfolioExtraction `json:"portfolio"`
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

	result, err := defaultExtractor.extract(r.Context(), req)
	if err != nil {
		log.Printf("capture: extractor failed: %v", err)
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}

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
			"fee":           str("Fee as plain digits, or omit."),
			"note":          str("Short note, usually the merchant/broker named in the text. Omit only if none is present."),
			"dateTime":      str("REQUIRED. Transaction date/time normalized to ISO-8601 (e.g. \"21 Jun 2026 20:18\" → \"2026-06-21T20:18:00\"). If the text contains no date/time, use the current date/time given in the prompt."),
		},
		"required": []any{"targetPortfolioId", "type", "symbol", "quantity", "pricePerShare", "dateTime"},
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
					"type": "string", "enum": []any{"wallet", "portfolio"},
					"description": "\"wallet\" for everyday spending/income; \"portfolio\" for buying/selling securities.",
				},
				"confidence": map[string]any{
					"type":        "number",
					"description": "Confidence in this extraction, from 0 to 1.",
				},
				"wallet":    walletSchema,
				"portfolio": portfolioSchema,
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
	b.WriteString("- Only set isTransaction true for a clear, concrete financial transaction. For anything else — a " +
		"random photo, a menu, an article, a chat, or text too garbled to read — set isTransaction to false, give a " +
		"low confidence, and omit BOTH the wallet and portfolio objects. Never invent a transaction that isn't there.\n")

	return b.String()
}
