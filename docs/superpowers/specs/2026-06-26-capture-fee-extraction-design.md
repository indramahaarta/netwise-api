# Capture: reliable stock fee extraction — design

Date: 2026-06-26
Repo: netwise-api (Go capture function)
Branch: feat/capture-fee-extraction

## Problem

In AI auto-capture, portfolio (stock) transactions carry a `fee`, but it is
frequently mis-populated or missed. The root cause is on the extraction side:
the `fee` field in the Claude tool schema is described only as
`"Fee as plain digits, or omit."`, and the system prompt says nothing about
fees at all. Brokerage confirmations list trading costs under many different
names (commission, brokerage, levy, VAT/PPN, stamp duty, SEC fee, TAF,
clearing/exchange fee, GST, crypto maker/taker & network fees), so a one-line
hint gives Claude little to anchor on — it records one line, the wrong line, or
nothing.

The iOS client (`CapturePrefill.swift`, `CaptureBackendClient.swift`) passes the
returned `fee` straight through to the confirm form. No client change is needed
or wanted — the fix is entirely in the backend prompt/schema.

## Decisions (from brainstorming)

- **Fee = sum of ALL cost lines.** Combine every fee/tax/commission/levy into one
  number (NetWise stores a single fee per trade, reflecting true cost basis).
- **Markets:** IDX, US, crypto, and other global — enumerate fee names from all of
  them so Claude recognizes them.
- **Net-only fallback:** when a confirmation shows only a net/total amount and no
  itemized cost lines, infer `fee = total − (quantity × pricePerShare)` — but only
  when that difference is a **small positive** amount, with explicit guards so a
  misread total can't masquerade as a fee.

## Scope

Backend-only. Two edits in `api/capture/index.go`:

1. **`fee` field description** in `portfolioSchema` (currently `index.go:244`).
2. **New fee rule** in `buildSystemPrompt`'s Rules section.

No change to the tool schema *shape*: `fee` stays an optional plain-digit string,
absent from the portfolio object's `required` list. Fully backward compatible —
no client update, no API contract change.

## Changes

### 1. `fee` field description (schema)

Replace:

```
"fee": str("Fee as plain digits, or omit."),
```

with a description that:
- defines fee as the **total** of every trading cost,
- enumerates the names across markets (broker commission/brokerage, exchange &
  clearing fees, regulatory levies — IDX levy, SEC fee, TAF — taxes — VAT/PPN, GST,
  stamp duty — crypto maker/taker & network fees),
- instructs Claude to **sum them into one number**,
- describes the net-total fallback with its positive-and-small guard,
- says to omit only when no fee is present and none can be inferred.

### 2. System prompt rule

Add one rule line to the Rules section of `buildSystemPrompt` reinforcing the same:
fee is the combined total of every cost line, never just one; crypto trades include
trading/maker/taker and network fees; if only a net total is shown set fee to
`total − quantity × pricePerShare` when that yields a small positive amount,
otherwise omit; **never put the share value or trade total in fee, and never let
fee equal or exceed the trade value.**

## Guards (anti-footgun)

The back-calculation is the riskiest part. Wording must enforce:
- infer only when the difference is **positive** and **small relative to trade value**,
- **never** let `fee >= quantity × pricePerShare` (a misread total would otherwise
  produce a fee equal to the whole trade),
- prefer explicitly labeled cost lines; only fall back to inference when none exist.

## Testing

- `buildSystemPrompt` is pure and unit-tested in `api/capture/index_test.go`.
  Add an assertion that the new fee-rule text is present in the built prompt.
- Run `go test ./...` to confirm existing tests still pass.
- No deploy in scope unless explicitly requested. (Vercel Go one-file rule still
  applies — `api/capture/` keeps a single non-test `.go` file with `func Handler`.)

## Out of scope

- Client-side changes (none needed).
- Changing how `amount` / `pricePerShare` are extracted.
- Any schema-shape change to the tool contract.
