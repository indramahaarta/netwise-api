# netwise-api

Serves NetWise's remote premium config at `GET /api/config`.

## Change limits / feature gating
1. Edit `api/appconfig.json`.
2. `git push` — Vercel auto-redeploys in seconds.

The served JSON file is named `appconfig.json` (not `config.json`) because Vercel
treats files in `/api` as routes by filename-without-extension: `config.go` already
owns the `/api/config` route, so an `api/config.json` beside it is rejected as a
conflicting path. `appconfig.json` is embedded into the function via `go:embed`.

Feature states: `all` (everyone), `premium` (premium only), `off` (hidden for all).

`onOpenPaywallEnabled` (bool) controls the launch paywall shown to non-premium
users: `false` disables it, `true` re-enables it (premium users never see it).
A malformed `appconfig.json` makes the endpoint return 500; the iOS app then keeps
its last-good cache or bundled defaults, so a bad deploy never breaks clients.

## AI Capture daily quota

The capture function (`api/capture`) enforces a per-device daily cap, counted by
`X-NetWise-Device` (IDFV) per device-local day. The day is derived from the
request's `now` field; the counter lives in Upstash Redis (`INCR` + 48h `EXPIRE`).

Two sources of truth, **kept in sync manually**:

- **Enforcement** (what actually blocks): env vars on the capture function —
  `AI_CAPTURE_DAILY_LIMIT_FREE`, `AI_CAPTURE_DAILY_LIMIT_PREMIUM`. Unset / `0` /
  negative = unlimited.
- **Display** (what the app shows: "N of M left today"): `aiCaptureDailyLimitFree`
  and `aiCaptureDailyLimitPremium` in `appconfig.json` (or an override block).

These must match. They are separate because `api/capture` is its own Go package
and cannot embed `../appconfig.json`. Both default to unlimited.

Required Upstash env vars (capture function): `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`. If either is unset, quota checks **fail open** (every
request allowed, uncounted) — so the cap is inert until Redis is configured.
`CAPTURE_SHARED_SECRET` (`X-NetWise-Key`) and `ANTHROPIC_API_KEY` are also required
for the capture function.

Behavior: the cap is checked **before** calling Claude (over-limit never bills the
model) and incremented **only after** a successful extraction (failures don't burn
quota). Old app builds send no device header → allowed and uncounted (backward
compatible). Responses carry `X-NetWise-Quota-{Limit,Remaining,Reset}` headers;
a 429 returns `{"error":"daily_limit",...}`.

## Test
`cd api && go test ./...`

## Note on go:embed
`//go:embed appconfig.json` works in deployed/production Vercel builds. It only
fails under `vercel dev` locally (that dev server doesn't copy sibling files).
If you ever need `vercel dev`, inline the JSON as a Go raw-string constant
instead of embedding.
