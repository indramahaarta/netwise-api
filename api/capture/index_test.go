package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func init() { captureSecret = "test-secret" } // override env for tests

func postCapture(t *testing.T, body string, secret string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/capture", bytes.NewBufferString(body))
	if secret != "" {
		req.Header.Set("X-NetWise-Key", secret)
	}
	rec := httptest.NewRecorder()
	Handler(rec, req)
	return rec
}

func TestCaptureRejectsMissingSecret(t *testing.T) {
	rec := postCapture(t, `{"text":"KFC Rp45000"}`, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestCaptureRejectsWrongSecret(t *testing.T) {
	rec := postCapture(t, `{"text":"x"}`, "nope")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestCaptureRejectsOversizedText(t *testing.T) {
	big := strings.Repeat("a", 10001)
	rec := postCapture(t, `{"text":"`+big+`"}`, "test-secret")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for oversized text, got %d", rec.Code)
	}
}

func TestCaptureRejectsBadJSON(t *testing.T) {
	rec := postCapture(t, `{not json`, "test-secret")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestCaptureRejectsNonPost(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/capture", nil)
	req.Header.Set("X-NetWise-Key", "test-secret")
	rec := httptest.NewRecorder()
	Handler(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestCaptureReturnsExtractorResult(t *testing.T) {
	prev := defaultExtractor
	defaultExtractor = fakeExtractor{result: captureResult{IsTransaction: true, Kind: "wallet"}}
	defer func() { defaultExtractor = prev }()

	rec := postCapture(t, `{"text":"KFC Rp45000","wallets":[{"id":"w1","name":"Jago","currency":"IDR"}]}`, "test-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var got captureResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("bad response json: %v", err)
	}
	if !got.IsTransaction || got.Kind != "wallet" {
		t.Fatalf("unexpected result: %+v", got)
	}
}

type fakeExtractor struct {
	result captureResult
	err    error
}

func (f fakeExtractor) extract(_ requestContext, _ captureRequest) (captureResult, error) {
	return f.result, f.err
}

func TestCaptureReturns502OnExtractorError(t *testing.T) {
	prev := defaultExtractor
	defaultExtractor = fakeExtractor{err: errFakeExtractorFailed}
	defer func() { defaultExtractor = prev }()

	rec := postCapture(t, `{"text":"KFC Rp45000","wallets":[{"id":"w1","name":"Jago","currency":"IDR"}]}`, "test-secret")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 on extractor error, got %d", rec.Code)
	}
}

var errFakeExtractorFailed = &testError{msg: "fake extractor failed"}

type testError struct {
	msg string
}

func (e *testError) Error() string {
	return e.msg
}
