import type { VercelRequest, VercelResponse } from '@vercel/node';
import { pool, poolStats } from '../../../lib/db/client.js';

/**
 * Phase 0 spike 2: does Postgres access from Vercel survive concurrency, and
 * does decimal precision survive the driver?
 *
 * Two independent questions, because they fail differently:
 *
 *   connections — Serverless multiplies clients by instances. The classic
 *   failure is not a slow query but "remaining connection slots are reserved",
 *   at which point every request fails at once. We fire a burst well past
 *   pool.max to confirm requests QUEUE (waitingCount rises, latency rises)
 *   rather than ERROR.
 *
 *   precision — node-postgres will hand back NUMERIC as a JS number unless told
 *   otherwise, which silently corrupts money. A ledger that is quietly wrong is
 *   worse than one that is loudly broken, so this is asserted, not assumed.
 *
 * Preview-only, like the Yahoo probe.
 */

const SECRET = process.env.CAPTURE_SHARED_SECRET;

type Attempt = { ok: boolean; ms: number; error?: string };

async function oneQuery(): Promise<Attempt> {
  const started = Date.now();
  try {
    // Touches a real table and the derived-cash view, so this also proves the
    // migrations are visible to the pooler connection and not just to the
    // dashboard's session.
    await pool.query(
      'select (select count(*) from public.wallets) as w, (select count(*) from public.portfolio_cash) as pc',
    );
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (process.env.VERCEL_ENV === 'production') {
    res.status(404).send('not found');
    return;
  }
  if (SECRET && req.headers['x-netwise-key'] !== SECRET) {
    res.status(401).send('unauthorized');
    return;
  }

  const burst = Math.min(200, Math.max(1, Number(req.query.burst ?? 50)));

  // --- precision guard -----------------------------------------------------
  // 0.1 + 0.2 in float64 is 0.30000000000000004. In NUMERIC it is exactly 0.3.
  // If the driver hands back a number, this test catches it here rather than in
  // a user's balance six months from now.
  let precision: Record<string, unknown>;
  try {
    const r = await pool.query(
      "select (0.1::numeric + 0.2::numeric) as sum, 21234.75::numeric * 0.5::numeric as mul",
    );
    const row = r.rows[0] as { sum: unknown; mul: unknown };
    precision = {
      sumValue: row.sum,
      sumType: typeof row.sum,
      mulValue: row.mul,
      staysString: typeof row.sum === 'string' && typeof row.mul === 'string',
      exact: row.sum === '0.3' && row.mul === '10617.375',
    };
  } catch (e) {
    precision = { error: e instanceof Error ? e.message : String(e) };
  }

  // --- concurrency ---------------------------------------------------------
  const before = poolStats();
  const settled = await Promise.all(Array.from({ length: burst }, () => oneQuery()));
  const after = poolStats();

  const ok = settled.filter((a) => a.ok);
  const failed = settled.filter((a) => !a.ok);
  const sorted = ok.map((a) => a.ms).sort((a, b) => a - b);

  // Distinct failure modes, because they mean different things: exhaustion means
  // back off or cache; timeout means the query or the pooler is the problem.
  const exhaustion = failed.filter((f) =>
    /too many clients|remaining connection slots|max client connections/i.test(f.error ?? ''),
  ).length;
  const timeouts = failed.filter((f) => /timeout/i.test(f.error ?? '')).length;

  const verdict =
    failed.length === 0
      ? 'GO: pool queues under load, no connection errors'
      : exhaustion > 0
        ? 'NO-GO: connection exhaustion — lower pool.max or add caching'
        : `PARTIAL: ${failed.length}/${burst} failed without exhaustion`;

  res.status(200).json({
    region: process.env.VERCEL_REGION ?? 'unknown',
    poolMax: 3,
    burst,
    ok: ok.length,
    failed: failed.length,
    exhaustion,
    timeouts,
    latencyMs: { p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted.at(-1) ?? 0 },
    poolBefore: before,
    poolAfter: after,
    precision,
    verdict,
    // Only distinct messages — 50 copies of the same error is not 50 findings.
    errors: [...new Set(failed.map((f) => f.error))].slice(0, 5),
  });
}
