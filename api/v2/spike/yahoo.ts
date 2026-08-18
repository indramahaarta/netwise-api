/**
 * PHASE 0 SPIKE 1 — THROWAWAY. Delete before Phase 1 ships.
 *
 * Answers Risk A: does Yahoo Finance tolerate server-side traffic from
 * Vercel egress IPs at NetWise's realistic volume?
 *
 * Today every user's phone fetches query1.finance.yahoo.com from its own
 * residential IP. Server-side, all of that collapses onto a handful of
 * Vercel egress IPs. Yahoo has had no official API since 2017 and throttles
 * by IP pattern. If this fails, the price + snapshot pipeline fails — and it
 * would fail at scale, after the client rewrite is already done.
 *
 * Usage:
 *   GET /api/v2/spike/yahoo?burst=25   with header  X-NetWise-Key: <secret>
 *
 * Drive it from a cron every 15 min for 48h, then read the rollup:
 *   GET /api/v2/spike/yahoo?rollup=1   with the same header
 *
 * Verdict thresholds (decide go/no-go on these, not on vibes):
 *   ok  >= 99%  → Yahoo viable server-side, keep it behind MarketDataProvider
 *   ok  95-99%  → viable only with aggressive caching + retry; revisit at scale
 *   ok  <  95%  → buy a provider (Twelve Data / Finnhub / EOD Historical)
 *   any sustained 403 → hard block, buy a provider immediately
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

/** Realistic mix across the markets NetWise supports. */
const SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'VOO', 'SPY',          // US
  'BBCA.JK', 'BBRI.JK', 'TLKM.JK', 'ASII.JK',    // ID
  'D05.SI', 'O39.SI',                             // SG
  '1155.KL',                                      // MY
  'PTT.BK',                                       // TH
  '005930.KS',                                    // KR
  '7203.T',                                       // JP
  'BTC-USD', 'ETH-USD', 'SOL-USD',                // crypto
] as const;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
const SECRET = process.env.CAPTURE_SHARED_SECRET ?? '';
const KEY = 'spike:yahoo:v1';

type Attempt = {
  symbol: string;
  kind: 'chart' | 'search';
  status: number | null;
  ms: number;
  parsed: boolean;
  error?: string;
};

async function redis(...path: string[]): Promise<string | null> {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(`${REDIS_URL}/${path.map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { result?: unknown };
    return body.result == null ? null : String(body.result);
  } catch {
    return null;
  }
}

async function probeChart(symbol: string): Promise<Attempt> {
  const started = Date.now();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const ms = Date.now() - started;
    let parsed = false;
    if (res.ok) {
      const body = (await res.json()) as { chart?: { result?: unknown[] } };
      parsed = Array.isArray(body.chart?.result) && body.chart.result.length > 0;
    } else {
      await res.text().catch(() => '');
    }
    return { symbol, kind: 'chart', status: res.status, ms, parsed };
  } catch (e) {
    return {
      symbol, kind: 'chart', status: null, ms: Date.now() - started, parsed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function probeSearch(query: string): Promise<Attempt> {
  const started = Date.now();
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const ms = Date.now() - started;
    let parsed = false;
    if (res.ok) {
      const body = (await res.json()) as { quotes?: unknown[] };
      parsed = Array.isArray(body.quotes);
    } else {
      await res.text().catch(() => '');
    }
    return { symbol: query, kind: 'search', status: res.status, ms, parsed };
  } catch (e) {
    return {
      symbol: query, kind: 'search', status: null, ms: Date.now() - started, parsed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function verdict(okPct: number, forbidden: number): string {
  if (forbidden > 0) return 'NO-GO: hard 403 seen — buy a market data provider';
  if (okPct >= 99) return 'GO: Yahoo viable server-side behind MarketDataProvider';
  if (okPct >= 95) return 'CAUTION: viable only with aggressive caching + retry';
  return 'NO-GO: buy a provider (Twelve Data / Finnhub / EOD Historical)';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Never runs in production. This is a preview-only throwaway; previews are
  // already behind Vercel deployment protection, which is the real gate.
  if (process.env.VERCEL_ENV === 'production') {
    res.status(404).send('not found');
    return;
  }
  // If a secret IS configured for this environment, still require it.
  if (SECRET && req.headers['x-netwise-key'] !== SECRET) {
    res.status(401).send('unauthorized');
    return;
  }

  if (req.query.rollup) {
    const [total, ok, rateLimited, forbidden, failed] = await Promise.all([
      redis('get', `${KEY}:total`), redis('get', `${KEY}:ok`),
      redis('get', `${KEY}:429`), redis('get', `${KEY}:403`), redis('get', `${KEY}:fail`),
    ]);
    const t = Number(total ?? 0);
    const o = Number(ok ?? 0);
    const okPct = t > 0 ? (o / t) * 100 : 0;
    res.status(200).json({
      total: t, ok: o, rateLimited: Number(rateLimited ?? 0),
      forbidden: Number(forbidden ?? 0), failed: Number(failed ?? 0),
      okPct: Number(okPct.toFixed(2)),
      verdict: verdict(okPct, Number(forbidden ?? 0)),
      redisConnected: REDIS_URL !== '',
    });
    return;
  }

  const burst = Math.min(Math.max(Number(req.query.burst ?? 18), 1), 60);
  const picks = Array.from({ length: burst }, (_, i) => SYMBOLS[i % SYMBOLS.length]!);

  const attempts = await Promise.all([
    ...picks.map(probeChart),
    probeSearch('bank'),
    probeSearch('BTC'),
  ]);

  const ok = attempts.filter((a) => a.status === 200 && a.parsed).length;
  const rateLimited = attempts.filter((a) => a.status === 429).length;
  const forbidden = attempts.filter((a) => a.status === 403).length;
  const failed = attempts.length - ok;
  const latencies = attempts.map((a) => a.ms).sort((x, y) => x - y);

  await Promise.all([
    redis('incrby', `${KEY}:total`, String(attempts.length)),
    redis('incrby', `${KEY}:ok`, String(ok)),
    redis('incrby', `${KEY}:429`, String(rateLimited)),
    redis('incrby', `${KEY}:403`, String(forbidden)),
    redis('incrby', `${KEY}:fail`, String(failed)),
  ]);

  const okPct = (ok / attempts.length) * 100;
  res.status(200).json({
    requests: attempts.length,
    ok, rateLimited, forbidden, failed,
    okPct: Number(okPct.toFixed(2)),
    latencyMs: {
      p50: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
      p95: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
      max: latencies[latencies.length - 1] ?? 0,
    },
    verdict: verdict(okPct, forbidden),
    failures: attempts.filter((a) => !(a.status === 200 && a.parsed)).slice(0, 10),
  });
}
