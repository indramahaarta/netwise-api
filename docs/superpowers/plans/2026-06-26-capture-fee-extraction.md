# Capture Fee Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI auto-capture reliably populate the portfolio `fee` field by teaching Claude that fee is the combined total of every trading cost.

**Architecture:** Backend-only prompt/schema change in the Go capture function. Two edits in `api/capture/index.go` — the `fee` field description in `portfolioSchema` and a new fee rule in `buildSystemPrompt` — plus a unit test. No tool-schema shape change, so the API contract and iOS client are untouched.

**Tech Stack:** Go, Anthropic SDK (Claude Haiku), Vercel Go function, `go test`.

## Global Constraints

- `api/capture/` keeps exactly ONE non-test `.go` file containing `func Handler` (Vercel Go one-file rule). This change edits the existing `index.go` only — do not add new `.go` files there.
- `fee` stays an OPTIONAL plain-digit string, absent from the portfolio object's `required` list. No schema-shape change.
- Fully backward compatible: no client change, no API contract change.

---

### Task 1: Enrich fee prompting and add a fee rule

**Files:**
- Modify: `api/capture/index.go` (the `fee` line in `portfolioSchema`, currently line 244; and the Rules section of `buildSystemPrompt`, currently around line 335)
- Test: `api/capture/index_test.go` (add one test function)

**Interfaces:**
- Consumes: existing `buildSystemPrompt(req captureRequest) string` (pure) and `extractionTool() anthropic.ToolParam`.
- Produces: no new exported symbols. The built system prompt now contains the literal substrings `"COMBINED TOTAL of every trading cost"`, `"VAT/PPN"`, and `"net total"` (asserted by the new test).

- [ ] **Step 1: Write the failing test**

Add to `api/capture/index_test.go` (after `TestSystemPromptIncludesHoldings`):

```go
func TestSystemPromptIncludesFeeRule(t *testing.T) {
	p := buildSystemPrompt(captureRequest{})
	for _, s := range []string{"COMBINED TOTAL of every trading cost", "VAT/PPN", "net total"} {
		if !strings.Contains(p, s) {
			t.Fatalf("prompt missing fee-rule substring %q", s)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Documents/netwise-api && go test ./api/capture/ -run TestSystemPromptIncludesFeeRule -v`
Expected: FAIL — prompt missing fee-rule substring "COMBINED TOTAL of every trading cost"

- [ ] **Step 3: Add the fee rule to `buildSystemPrompt`**

In `api/capture/index.go`, find the existing line in the Rules section:

```go
	b.WriteString("- amount/quantity/pricePerShare/fee are plain-digit strings (no separators or symbols).\n")
```

Insert immediately AFTER it:

```go
	b.WriteString("- For a portfolio trade, fee is the COMBINED TOTAL of every trading cost — broker commission/brokerage, " +
		"exchange/clearing fees, regulatory levies (IDX levy, SEC fee, TAF), and taxes (VAT/PPN, GST, stamp duty); for crypto " +
		"include trading/maker/taker and network fees. Sum every such line into ONE number — never record just one of them. If " +
		"the text shows only a net total with no itemized costs, set fee to (total − quantity × pricePerShare) when that yields a " +
		"small positive amount; otherwise omit it. Never put the share value or trade total in fee, and never let fee reach or " +
		"exceed quantity × pricePerShare.\n")
```

- [ ] **Step 4: Enrich the `fee` field description in `portfolioSchema`**

In `api/capture/index.go`, replace:

```go
			"fee":           str("Fee as plain digits, or omit."),
```

with:

```go
			"fee": str("The TOTAL of every trading cost on this trade, combined into ONE plain-digit number: broker " +
				"commission/brokerage, exchange & clearing fees, regulatory levies (IDX levy, US SEC fee, TAF), taxes " +
				"(VAT/PPN, GST, stamp duty), and for crypto the trading/maker/taker and network/withdrawal fees. Sum ALL such " +
				"lines — do not record only one. If the text shows only a net/total amount with no itemized costs, set fee to " +
				"(total − quantity × pricePerShare) ONLY when that difference is a small positive number. Never put the share " +
				"value or trade total in fee, and never let fee reach or exceed quantity × pricePerShare. Omit only when no fee " +
				"is shown and none can be inferred."),
```

(Alignment of the `"fee":` key in the map literal does not affect Go behavior; `gofmt` in Step 5 will normalize it.)

- [ ] **Step 5: Format, run the new test, run the full suite**

Run:
```bash
cd ~/Documents/netwise-api && gofmt -w api/capture/index.go api/capture/index_test.go && go test ./...
```
Expected: `ok  ...` for all packages, including `TestSystemPromptIncludesFeeRule` PASS. No build errors.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/netwise-api && git add api/capture/index.go api/capture/index_test.go && git commit -m "feat: extract combined stock fee total in capture

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NXNFKs87XpKMKzAVzcR1r3"
```

---

## Self-Review

- **Spec coverage:** fee-as-sum (Steps 3–4), market name enumeration IDX/US/crypto/global (Steps 3–4), net-total back-calc with small-positive guard (Steps 3–4), anti-footgun "never reach/exceed qty×price" (Steps 3–4), pure-prompt unit test + `go test ./...` (Steps 1–2, 5), backward-compatible optional string (unchanged `required` list — verified by not touching `portfolioSchema`'s `"required"`). No deploy (out of scope). All covered.
- **Placeholder scan:** none — every step has exact code/commands.
- **Type consistency:** no new symbols; test asserts literal substrings that appear verbatim in the Step 3 prompt text (`"COMBINED TOTAL of every trading cost"`, `"VAT/PPN"`, `"net total"`). Confirmed present.
