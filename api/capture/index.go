package handler

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
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
	Currency string   `json:"currency"`
	Market   string   `json:"market"`
	Holdings []string `json:"holdings"`
}

type captureRequest struct {
	Text       string         `json:"text"`
	Wallets    []walletRef    `json:"wallets"`
	Categories []categoryRef  `json:"categories"`
	Portfolios []portfolioRef `json:"portfolios"`
}

type walletExtraction struct {
	TargetWalletID string  `json:"targetWalletId"`
	Direction      string  `json:"direction"`
	Amount         string  `json:"amount"`
	CurrencyCode   *string `json:"currencyCode"`
	CategoryName   *string `json:"categoryName"`
	Note           *string `json:"note"`
	DateTime       *string `json:"dateTime"`
}

type portfolioExtraction struct {
	TargetPortfolioID string  `json:"targetPortfolioId"`
	Type              string  `json:"type"`
	Symbol            string  `json:"symbol"`
	Quantity          string  `json:"quantity"`
	PricePerShare     string  `json:"pricePerShare"`
	Fee               *string `json:"fee"`
	CurrencyCode      *string `json:"currencyCode"`
	Note              *string `json:"note"`
	DateTime          *string `json:"dateTime"`
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
	if captureSecret == "" || subtle.ConstantTimeCompare([]byte(key), []byte(captureSecret)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req captureRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if len(req.Text) == 0 || len(req.Text) > maxCaptureTextChars {
		http.Error(w, "text length out of range", http.StatusBadRequest)
		return
	}

	result, err := defaultExtractor.extract(r.Context(), req)
	if err != nil {
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

// callClaude is a placeholder — replaced by the real implementation in Task 2.
func callClaude(_ requestContext, _ captureRequest) (captureResult, error) {
	return captureResult{}, nil
}
