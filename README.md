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
A malformed `appconfig.json` makes the endpoint return 500; the iOS app then keeps
its last-good cache or bundled defaults, so a bad deploy never breaks clients.

## Test
`cd api && go test ./...`

## Note on go:embed
`//go:embed appconfig.json` works in deployed/production Vercel builds. It only
fails under `vercel dev` locally (that dev server doesn't copy sibling files).
If you ever need `vercel dev`, inline the JSON as a Go raw-string constant
instead of embedding.
