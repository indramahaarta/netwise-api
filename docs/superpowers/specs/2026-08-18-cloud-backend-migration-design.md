# NetWise v2.0 — Cloud Backend Migration (design of record)

## Context

NetWise today is local-first: 13 SwiftData `@Model` types in an App Group SQLite store, all computation on-device, no accounts, no server-side data. The backend (`netwise-api`) is two stateless Go endpoints — remote config and AI receipt capture.

That architecture has hit three walls:

1. **Compute is on the main thread of a phone.** `SnapshotService.replay*Snapshots` fires on every transaction save and delete, looping day-by-day from an arbitrary past date to yesterday with a Yahoo Finance fetch per symbol per day. Editing an old transaction can trigger hundreds of days of replay plus N network calls. `DashboardView.rebuildAnalyticsCache()` runs 14 full-corpus scans synchronously.
2. **The compute is trapped in the view layer.** ~7,900 lines across 8 SwiftUI view files contain domain math (Modified Dietz, CAGR, bucketing, holdings, budget fractions), not layout. `DashboardView.swift` carries 16 `@State` cache fields and 3 hand-rolled invalidation tokens purely to stop it recomputing on every render.
3. **Every device does the same work independently.** 10,000 users holding AAPL means 10,000 separate Yahoo fetches. Nothing is shared.

**v2.0 makes the backend the source of truth.** The iOS app becomes a rendering client. All ledger data lives in Supabase Postgres; all computation runs in Vercel TypeScript functions; the app fetches screen-shaped payloads and draws them.

**Intended outcome:** dashboards that load in one round trip instead of 14 corpus scans, snapshot replay that happens in a background job instead of blocking a save, market data fetched once for all users, and a data model that can later support web and multi-device without another rewrite.

---

## Decisions locked (2026-08-18)

| # | Decision | Choice |
|---|---|---|
| 1 | Toggle scope | **Cloud-only in v2.0.** No local/cloud toggle in the end state. The on-device engine is deleted, not maintained. |
| 2 | Client shape | **Thin client.** No SwiftData. Server returns screen-shaped payloads; views render them. |
| 3 | Offline | **Stale-render + offline write queue.** Disk cache of server responses (server-shaped JSON, never a second model layer); writes queue with idempotency keys and replay on reconnect. |
| 4 | Identity | **Sign in with Apple, required.** Supabase Auth Apple provider → JWT → Postgres RLS. |
| 5 | Runtime | **All TypeScript on Vercel.** `/api/config` and `/api/capture` ported from Go; Go retired. |
| 6 | Widget | **App writes an App Group payload.** Widget decodes and renders; no networking, no auth in the extension. |
| 7 | Migration | **Blocking wizard on first v2.0 launch.** Sign in → upload `BackupService` v5 JSON → server ingests + replays → user verifies counts → local store frozen on disk 30 days, then purged. |
| 8 | Cost model | **Free tier stays free.** Control cost with a globally shared price/FX cache and per-user read-model caching; existing entity limits are the free ceiling. |

---

## Two risks that can kill this — resolve in Phase 0, before anything else

### Risk A — RESOLVED 2026-08-18: Yahoo tolerates Vercel egress. The variable was the User-Agent.

**Measured**, not assumed. Probe: `api/v2/spike/yahoo.ts`, deployed to a preview, egress `iad1`.

| User-Agent | Requests | OK | 429 |
|---|---|---|---|
| `Mozilla/5.0` — what `PriceService.swift:16` ships | 61 | **61 (100%)** | 0 |
| Full Chrome UA string | 61 | 5 (8.2%) | 56 |

122 concurrent requests in a single burst from one Vercel IP, p50 354ms, p95 477ms. No 403 at any point.

The counter-intuitive finding: **Yahoo challenges anything claiming to be a real browser** — it expects those to carry the cookie + crumb handshake — **and still serves the minimal UA cleanly.** An earlier probe run reported 0/20 and a NO-GO; that was the probe sending a full Chrome UA, not a signal about egress IPs. Reproduced from a residential IP in the same second: full Chrome UA 429 3/3, `Mozilla/5.0` 200 3/3.

**Consequences:**

1. **No paid market-data provider is needed for launch.** Keep Yahoo.
2. **The `Mozilla/5.0` UA is load-bearing.** Pin it in `lib/market/yahoo.ts` with a comment and a test. "Tidying" it into a realistic browser string silently breaks all pricing.
3. **`MarketDataProvider` / `FxProvider` stay** (`lib/market/types.ts`). Yahoo is unofficial and can change without notice; the interface keeps a provider swap a config change. Budget a paid provider as a contingency, not a line item.
4. Re-run the probe on a cron before launch to confirm the result holds over days, not minutes.

**Also resolved in the same deploy:** Go and TypeScript coexist in one Vercel project — the build produced `{"provided":2,"nodejs":1}` (2 Go functions + 1 Node function) in 7s. Phase 7's assumption holds, so the Go endpoints can be ported last rather than up front.

### Global market-data cache

Yahoo tolerating the load does not mean we should generate it. Today every device fetches independently; server-side, one fetch serves everyone. Four rules, in descending order of impact:

1. **Lazy read-through, never scheduled refresh.** Only fetch a symbol when someone actually asks for it. A symbol nobody is looking at costs nothing. With a small user base this dominates every other optimisation.
2. **Historical closes cache forever.** A closed day's close never changes, so `price_history(symbol, date) -> close` is written once and read for all time. This is the bigger win than quote caching, because snapshot replay walks day-by-day across every symbol — it is exactly the workload that made the on-device version slow.
3. **15-minute TTL on live quotes, market-hours aware.** 15 minutes matches `PriceStore`'s existing client TTL, so user-visible freshness does not change. Outside market hours the price cannot move, so extend the TTL to the next exchange open — a US symbol only needs 15-minute refresh during 32.5 of the week's 168 hours, roughly a 5× reduction. Crypto trades 24/7 and stays on a flat 15 minutes.
4. **Single-flight on cache miss.** When a TTL expires, 50 concurrent requests for AAPL must produce one upstream fetch, not 50. A Redis `SET NX` lock with a short expiry; losers wait briefly and read the filled cache.

FX gets the same treatment: 1-hour TTL on live rates (matching `ForexService` today), permanent cache for historical daily rates.

### Risk B: silently changing users' numbers

Live App Store users have years of transactions. If the TypeScript holdings or realized-P&L math differs from Swift by a rounding rule, their net worth changes after an update and they will not trust the app again.

**Mitigation is a golden-fixture parity harness, built in Phase 2 before any endpoint ships.** The existing 4,299 lines of Swift Testing tests are the behavioral spec — `BudgetServiceTests` (383), `TransactionValidatorTests` (373), `BackupServiceTests` (312), `PortfolioFeatureTests` (257) are the highest-value oracles. Export ledger fixtures + expected outputs from the Swift suite, run the same fixtures through the TS implementations, assert exact equality on decimal strings.

**Money is `NUMERIC(20,8)` in Postgres and a decimal string on the wire — never a JS `number`.** `BackupService` already serializes every `Decimal` as a string; keep that discipline end to end. Use `decimal.js` or `big.js` server-side; a single float division will produce a wrong balance.

---

## Target architecture

```
iOS app (thin client)
  ├─ AuthService        Sign in with Apple → Supabase JWT → Keychain
  ├─ APIClient          URLSession + bearer + ETag + retry
  ├─ ResponseCache      disk cache of server payloads (stale-render)
  ├─ WriteQueue         persisted, Idempotency-Key, replay on reconnect
  └─ ScreenStore/screen ObservableObject: .loading / .loaded(stale:) / .error
        │
        │  HTTPS, screen-shaped JSON (decimals as strings)
        ▼
Vercel Functions (TypeScript, Node runtime, Fluid Compute)
  ├─ api/v2/**          BFF endpoints — one round trip per screen
  ├─ lib/domain/**      ported pure compute (holdings, snapshots, budgets, perf)
  ├─ lib/market/**      provider-agnostic price + FX interface
  ├─ lib/db/**          Drizzle schema + queries, attachDatabasePool
  └─ lib/auth/**        Supabase JWT verification → user_id
        │                        │
        ▼                        ▼
Supabase Postgres          Upstash Redis
  per-user ledger (RLS)      shared price/FX cache
  global price history       read-model cache
  snapshot tables            capture quota (existing)
```

**Deliberately rejected:** letting the iOS app talk to Supabase PostgREST directly with RLS. It would skip a lot of endpoint code, but server-enforced validation (insufficient cash, insufficient holdings, paired transfer creation, portfolio cash effects) has to run somewhere, and splitting the API surface between PostgREST and Vercel functions means two auth stories and two error contracts. Supabase stays pure Postgres + Auth.

---

## The eight pieces

Each phase ships something verifiable. Phases 3–4 and the start of Phase 5 can overlap once the API contract is frozen.

### Phase 0 — Spikes (~1 week)

Throwaway code, real answers. Do not start Phase 1 until all four are green.

1. **Yahoo from Vercel egress** — see Risk A. Deliverable: go/no-go plus a provider recommendation and price quote.
2. **Supabase + Fluid Compute connection handling** — deployed TS function, Drizzle over the Supavisor transaction-mode pooler (port 6543), `attachDatabasePool` from `@vercel/functions`, load-tested to confirm connections do not exhaust under concurrency and cold starts stay acceptable.
3. **Sign in with Apple → Supabase → RLS, end to end** — `ASAuthorizationAppleIDProvider` identity token → `signInWithIdToken` → JWT verified in a Vercel function → RLS-scoped query returns only that user's rows. Confirm token refresh works from a backgrounded app.
4. **Decimal parity smoke test** — port `HoldingsService.compute` alone to TS, run it against `PortfolioFeatureTests` fixtures, confirm exact decimal-string equality. This validates the whole Phase 2 approach cheaply.

Enable Fluid Compute in `netwise-api/vercel.json` (`{"fluid": true}`) — it is currently an empty schema stub.

### Phase 1 — Schema, auth, and identity (~3 weeks)

**Postgres schema** (Drizzle, in `lib/db/schema.ts`). Direct port of the 13 SwiftData models with four deliberate changes:

- **Drop `CapturedEmail`** — dead model, retained on-device only to avoid a SwiftData entity-drop migration. No reason to carry it.
- **Drop `PriceCache` / `ForexRateCache` as per-user tables** — they become global tables shared by all users.
- **Drop `Portfolio.cash`** — it is a denormalized running balance mutated in 8+ places and can drift from `sum(cashEffect)`. Derive it from the transaction ledger via a view. Do not inherit the drift.
- **Add `user_id`, `updated_at` everywhere** — the backup format has no per-record `updatedAt`, which is why it can never be a sync format. Add it now.

Tables: `user_settings`, `wallet_groups`, `wallets`, `wallet_categories`, `wallet_tags`, `wallet_transactions`, `wallet_transaction_tags`, `wallet_category_budgets`, `portfolios`, `portfolio_transactions`, `wallet_snapshots`, `portfolio_snapshots`, `user_entitlements`, `migration_jobs`, `snapshot_jobs`. Global: `price_quotes`, `price_history`, `fx_rates`, `fx_history`.

Every user table: `user_id uuid not null references auth.users(id) on delete cascade`, RLS policy `using (auth.uid() = user_id)` as defense in depth even though queries go through the service role.

**Enum raw values are frozen** — `INCOME`, `EXPENSE`, `TRANSFER_IN`, `TRANSFER_OUT`, `PORTFOLIO_DEPOSIT`, `PORTFOLIO_WITHDRAWAL`, `INITIAL_BALANCE`, `BUY`, `SELL`, `DIVIDEND`, `FEE`, `DEPOSIT`, `WITHDRAWAL`, `IMPORT_HOLDING`, `REALIZED_ADJUSTMENT`. They are persisted in every existing user's backup file. Store as text with a check constraint, not a Postgres enum (easier to extend).

**Timezone is a first-class field.** `periodStartDay`, `weekStartDay`, custom periods, and daily snapshots are all local-date concepts. Store `timezone` in `user_settings` and send `X-NetWise-TZ` on every request. The capture endpoint already proves the pattern — it takes a client-local `now`. Getting this wrong shifts every user's month boundary.

**Auth:** `lib/auth/verify.ts` — verify the Supabase JWT, resolve `user_id`, return a typed context. Required by Apple guideline 5.1.1(v): an in-app account deletion path → `DELETE /api/v2/account`, hard-deleting all rows.

**Entitlements stop being client-asserted.** Today the server trusts `X-NetWise-Premium: true` from the client. Once premium gates server compute that is untenable. Build App Store Server Notifications V2 → webhook → `user_entitlements` table, with `Transaction.currentEntitlements` on-device as the fast path and the server table as the authority.

### Phase 2 — Domain engine in TypeScript + parity harness (~4 weeks)

The highest-risk phase. Nothing here touches HTTP.

Port these, all of which are already pure functions with no SwiftData dependency:

| Swift source | TypeScript target |
|---|---|
| `Services/HoldingsService.swift` | `lib/domain/holdings.ts` |
| `Services/SnapshotService.swift` (`computeRealized`, replay) | `lib/domain/snapshots.ts` |
| `Services/BudgetService.swift` | `lib/domain/budgets.ts` |
| `Services/ForexRateResolver.swift` | `lib/domain/fx.ts` |
| `Helpers/CustomPeriod.swift`, `CustomWeekPeriod.swift` | `lib/domain/periods.ts` |
| `Views/Dashboard/DashboardBuckets.swift` | `lib/domain/buckets.ts` |
| `DashboardView.modifiedDietz` / `cagrFrom` / `externalFlows` | `lib/domain/performance.ts` |
| `Validators/TransactionValidator.swift` + `Helpers/BalanceHelpers.swift` | `lib/domain/validation.ts` |
| `Services/LinkedTransactionService.swift` | `lib/domain/linked.ts` |
| `Models/FeatureLimits.swift`, `Models/AppConfig.swift` | `lib/domain/entitlements.ts` |
| `Services/PriceService.carryForward` | `lib/market/carryForward.ts` |
| `Services/CapturePrefill.swift` | `lib/capture/prefill.ts` |

Also extract from views (they exist only inside `DashboardView.swift` today): `spendingByCategory`, `spendingByTag`, `savingsPoints`, `pnlPoints`, `flowPoints`, `dividendPoints`, `computeMonthlySummary`, `computeWealthAllocationSegments`, `computeLargestExpenses`, `computeNWSeries`.

**Three write paths must be unified server-side.** Today the same logic exists in four places: `TransactionFormSheet.save()` (lines 1148–1345), `PortfolioTransactionFormSheet.saveNew`/`saveEdit`, `LinkedTransactionService`, and three inline duplicates of the pair-cascade in views. On the server there is exactly one implementation of each.

**Deliverable:** `lib/domain/**` at parity, plus `test/parity/` with fixtures exported from the Swift suite and a runner asserting decimal-exact equality.

### Phase 3 — Read API + snapshot jobs + shared market cache (~4 weeks)

**BFF endpoints — screen-shaped, one round trip each:**

```
GET /api/v2/bootstrap              user, settings, entitlement, config, wallet+portfolio summaries
GET /api/v2/dashboard?period=1M    every insight card in one payload
GET /api/v2/wallets                list + balances + group rollups
GET /api/v2/wallets/:id/transactions?period=&cursor=
GET /api/v2/portfolios             list + combined chart series
GET /api/v2/portfolios/:id         holdings, chart, activity
GET /api/v2/budgets                budgets + spent + fractions
GET /api/v2/widget                 net worth, breakdown, 7-day sparkline
```

Every response carries an `ETag`; the client sends `If-None-Match` and renders its cache on 304. `/api/config` already does exactly this — copy the pattern from `api/config.go:114`.

**Snapshots become a background job, not request-path work.** Writes enqueue a row in `snapshot_jobs`; a Vercel Cron drains it, and a second daily cron snapshots all active users. Historical prices come from the global `price_history` table, so one Yahoo (or provider) fetch per `(symbol, date)` serves every user forever. This is the single largest performance win in the project and it eliminates the app's worst liability.

**Read-model caching:** per-user dashboard payloads cached in Redis, invalidated by tag on write. Combined with the shared price cache, this is what keeps the free tier free.

### Phase 4 — Write API (~3 weeks)

```
POST   /api/v2/transactions          wallet tx: income/expense/transfer/portfolio deposit-withdrawal
PATCH  /api/v2/transactions/:id
DELETE /api/v2/transactions/:id      soft delete + pair cascade
POST   /api/v2/portfolio-transactions   buy/sell/dividend/fee/deposit/withdrawal
PATCH/DELETE equivalents
POST/PATCH/DELETE  /api/v2/{wallets,portfolios,categories,tags,groups,budgets}
PATCH  /api/v2/settings
```

Three rules that make the thin client feel fast and stay correct:

1. **Every write response returns the affected read-models** — updated wallet balances, invalidated dashboard slices. The client never needs a second round trip after a save.
2. **`Idempotency-Key` header required on every mutation**, stored and deduped server-side. This is what makes the offline write queue safe to replay.
3. **Validation runs server-side only.** `TransactionValidator`'s insufficient-cash and insufficient-holdings checks become 422 responses with typed error codes the client maps to inline field errors.

### Phase 5 — iOS client rewrite (~8 weeks, the biggest piece)

**Delete:** all 13 `@Model` classes, `App/ModelContainerSetup.swift`, `SnapshotService`, `HoldingsService`, `BudgetService`, `PriceService`, `PriceStore`, `ForexService`, `ForexRateResolver`, `CurrencyMigrationService`, `LinkedTransactionService`, `WalletMainService`, `CategorySeedService`, `StartupLoader`, `BudgetNotificationService`, all 28 `@Query` declarations, all 44 `FetchDescriptor` call sites, all 36 `context.save()` calls, and `NetWiseProvider`'s duplicated `liveEquity` math.

**Build in `NetWise/Services/`:**

- `AuthService.swift` — Sign in with Apple, Supabase session, Keychain persistence, refresh
- `APIClient.swift` — single `URLSession` wrapper: bearer auth, `X-NetWise-TZ`, ETag, typed errors, retry with backoff. The app has no shared networking layer today — six services each do raw `URLSession` with `try?`. This replaces all of them.
- `ResponseCache.swift` — disk cache keyed by endpoint+params, stores raw server JSON with its ETag and fetch timestamp
- `WriteQueue.swift` — persisted queue, idempotency keys, replay on reconnect, conflict surfacing
- `ScreenStore` per screen — `ObservableObject` exposing `.loading` / `.loaded(payload, stale: Bool)` / `.error(retry:)`

**Views keep their layout and lose their math.** `DashboardView.swift` (1147 lines) drops to a few hundred: the 16 `@State` caches, 3 invalidation tokens, and every `compute*`/`rebuild*` method delete, because the payload arrives pre-computed. Same for `WalletListView.swift` (1545), `PortfolioListView.swift` (666), `PortfolioDetailView.swift` (619), `BudgetsView.swift` (326).

**Every screen gets loading, stale, and error states.** This is the real cost of the thin client and it is spread across ~60 view files — build one reusable `ScreenStateView` wrapper early and apply it uniformly.

`NetWise/Views/Shared/NetWiseLineChart.swift` and the downsampling helper stay client-side — they are rendering, not domain logic.

### Phase 6 — Migration wizard, widget, capture rewire (~3 weeks)

**Migration wizard** (`Views/Migration/`), blocking on first v2.0 launch when a legacy store is detected:

1. Detect `<appgroup>/netwise.store` exists → explain what is changing
2. Sign in with Apple
3. `BackupService.exportJSON()` (unchanged, already tested) → `POST /api/v2/migrate`
4. Server stores the raw upload, enqueues a `migration_jobs` row, returns a job id — **do not do this in the request.** A 5,000-transaction ledger with three years of snapshot replay will exceed function `maxDuration`. Process in chunks; the client polls.
5. Verification screen: entity counts and net worth, side by side, local vs server. User confirms they match.
6. Local store is left on disk untouched, marked frozen, and purged after 30 days. `BackupService.exportJSON` stays reachable from Settings during that window as an escape hatch.

Keep `BackupService.swift` for export only. Its `importJSON` path (destructive full replace) is retired.

**Widget:** `NetWiseProvider.swift` drops from 162 lines of duplicated net-worth math to a JSON decode. The app fetches `/api/v2/widget` on foreground and after each successful write, writes the payload into the App Group, and calls `WidgetCenter.shared.reloadAllTimelines()`. The widget target's manually-listed 18-file source list in `project.pbxproj` shrinks to the payload struct plus the chart and color files.

> Note the existing gotcha (saved from prior work): new shared files needed by the widget must be added to that legacy explicit `pbxproj` source list by hand — the synced folder does not cover the widget target.

**Capture:** `CaptureCoordinator.buildPayload` currently fetches all wallets/portfolios/categories from the local `ModelContext` and runs `HoldingsService.compute` per portfolio just to build the request. With no local store, the server builds that context from the user's own account — the client sends only the OCR text. OCR stays on-device (Vision); the image still never leaves the phone.

**Share extension** is nearly unaffected — it writes a PNG to the App Group and opens `netwise://capture`. It only needs the entitlement read swapped to the new source.

### Phase 7 — Retire Go (~1 week)

Port `api/config.go` (277 lines) and `api/capture/index.go` (584 lines) to TypeScript, reimplementing their 37 tests. Do this **last**, when the TS stack is proven — these two endpoints serve live 1.4 users, and the capture flow's Anthropic strict-tool contract is load-bearing.

Two constraints disappear on the way out: the "one non-test `.go` file per function dir" rule that forced `quota.go` to be merged into `index.go`, and the split between quota *enforcement* (env vars) and quota *display* (`appconfig.json`) that has to be synced by hand. In TypeScript both read one shared module.

`/api/config` must keep serving 1.4 clients unchanged throughout — same route, same schema, same ETag semantics. Version the new surface under `/api/v2/`.

### Phase 8 — Beta, compliance, launch (~4 weeks)

- **Shadow-parity beta:** a TestFlight build that runs the local engine *and* fetches the server payload, then reports mismatches. This catches Risk B against real ledgers instead of fixtures. Run it for at least two weeks before the migration path is enabled for anyone.
- **Privacy copy changes in four places:** `Views/Settings/SettingsView.swift:419-428` ("Data Storage: On-Device", "All financial data is stored locally on this device using SwiftData. No account required."), `PrivacyPolicyView.swift`, `AICaptureSettingsView.swift` ("Your ledger stays on your iPhone"), and the `netwise-landing` privacy policy.
- **App Store privacy nutrition label:** financial info is now collected and linked to identity. This is a material change and needs to be right.
- **App Store review notes** explaining why an account is required (cloud sync of user-generated financial data — permitted under 5.1.1(v)) and confirming in-app account deletion exists.

---

## Verification

**Per phase:**

```bash
cd netwise-api && npm test          # unit + parity suites
cd netwise-api && npm run test:parity   # golden fixtures, decimal-exact
```

```bash
cd NetWise && xcodebuild -project NetWise.xcodeproj -scheme NetWise \
  -destination 'generic/platform=iOS' -configuration Release build 2>&1 | grep -E "error:|BUILD"
```

Never run `xcodebuild test` or a simulator-targeted build — it wipes the on-device SwiftData store, which matters until the migration path is proven.

**End to end, before launch:**

1. Fresh install → Sign in with Apple → create wallet, transaction, portfolio, buy → verify rows in Supabase and correct dashboard payload.
2. Restore a real v1.4 backup onto a device → run the migration wizard → assert entity counts and net worth match the pre-migration values exactly.
3. Airplane mode → open every screen (stale render) → add three transactions (queued) → reconnect → assert all three land exactly once and no duplicates appear on a second replay.
4. Widget: add a transaction → foreground → confirm the widget updates within one timeline refresh.
5. Capture: share a receipt screenshot → confirm the extraction still prefills correctly with server-built context.
6. Deploy verification — confirm the deploy actually went live, not just that the push succeeded.

---

## Estimate

| Phase | Work | Calendar |
|---|---|---|
| 0 | Spikes | 1 week |
| 1 | Schema, auth, entitlements | 3 weeks |
| 2 | Domain engine + parity harness | 4 weeks |
| 3 | Read API + jobs + market cache | 4 weeks |
| 4 | Write API | 3 weeks |
| 5 | iOS client rewrite | 8 weeks |
| 6 | Migration, widget, capture | 3 weeks |
| 7 | Retire Go | 1 week |
| 8 | Beta + compliance + launch | 4 weeks |

**~31 weeks sequential, ~26 with Phases 4/5 overlapped** once the API contract freezes. Roughly six months solo. Phases 2 and 5 carry the risk; Phase 0 decides whether the market-data assumption holds at all.

**First concrete action:** Phase 0 spike 1 — deploy a throwaway Vercel TS function that polls Yahoo at realistic volume and log the 429/403 rate over 48 hours. Everything downstream depends on that answer.

---

## Phase 1 progress — schema applied 2026-08-18

Supabase project **`netwise-v2`** (`itkyospywqydgtahohhq`), region **`ap-southeast-1` (Singapore)**, Postgres 17.6.

Region was a deliberate correction: the first project defaulted to `ap-southeast-2` (Sydney). In a thin client every screen is a round trip, so a Jakarta user against a Sydney stack pays roughly 200ms per screen versus 50–60ms via Singapore, and Supabase cannot move a project after creation. Vercel functions must be pinned to `sin1` to match — they currently run in `iad1`.

Six migrations applied: `001_foundation`, `002_wallet_domain`, `003_portfolio_domain`, `004_snapshots_and_jobs`, `005_global_market_data`, `006_rls_policies`.

Result: 19 tables, 1 view, 15 policies, 19 RLS-enabled tables, 54 indexes. Supabase advisors report zero WARN/ERROR.

### Decisions made while porting the 13 SwiftData models

- **`Portfolio.cash` is gone.** Replaced by a `cash_effect` generated column on `portfolio_transactions` plus the `portfolio_cash` view. The expression is transcribed from `PortfolioModels.swift:54-65` and verified against all eight transaction types plus null-operand and fractional cases — 10/10 exact, including `0.5 × 21234.75 + 2.25 = -10619.625` with no float drift.
- **`created_at` stays nullable** on wallets, categories, tags and transactions. v1.4 uses `Date.distantPast` and nil as sentinels meaning "seeded default, exempt from premium locking", and `LimitChecker` ranks rows by it. Defaulting to `now()` would silently re-rank every migrated user's data and lock rows that are free today.
- **`wallet_transactions.amount` stays signed.** v1.4 encodes direction in the sign; every balance is a plain sum. Normalising would change results.
- **`portfolios.market` is unconstrained.** An old build stamped every portfolio `'US'` regardless of currency, so real data contains codes that contradict the currency. `PortfolioMarket.resolve` repairs this at read time; a check constraint would reject those rows at import.
- **One live main wallet is now a database guarantee** (partial unique index), replacing `WalletMainService`'s launch-time drift repair.
- **`snapshot_jobs` coalesces per target while pending**, so a burst of edits to one wallet collapses into a single replay instead of hundreds of overlapping ones.
- **`migration_jobs.payload` is revoked from `authenticated`** — it holds a user's entire ledger as raw JSON and never needs to travel back over the wire.

### RLS posture: `authenticated` is SELECT-only, everywhere

Not merely least privilege — required for correctness. Every invariant that keeps the ledger sound lives in application code, not constraints: `TransactionValidator`'s insufficient-cash and insufficient-holdings checks, creating both halves of a transfer pair, the portfolio-deposit counterpart, the pair-cascade soft delete. A client able to INSERT directly would bypass all of them and could sell shares it does not hold.

All writes go through Vercel functions using `service_role`. The policies are the backstop that makes a leaked anon key a read-only incident scoped to one user.

The four global market tables (`price_quotes`, `price_history`, `fx_rates`, `fx_history`) have RLS enabled with **no** policies — deny-all to anon and authenticated, `service_role` bypasses. Supabase's linter flags these as INFO `rls_enabled_no_policy`; that is the intended design, not a gap.

### Open items before Phase 1 closes

1. Pin Vercel functions to `sin1` and enable Fluid Compute in `vercel.json`.
2. Link the Supabase CLI so migrations live in `supabase/migrations/` under git, not only in Supabase's migration history. Needs the database password.
3. Drizzle schema mirroring these tables, plus `attachDatabasePool` over the Supavisor transaction pooler (port 6543) — Phase 0 spike 2, still open.
4. Configure the Apple auth provider (needs an Apple Services ID and key from the developer account).
5. Free-tier projects pause after 7 days idle; move to the paid plan before any real user data lands.
