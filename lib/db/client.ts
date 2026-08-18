import { Pool, types } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { drizzle } from 'drizzle-orm/node-postgres';

/**
 * Postgres access for Vercel Functions.
 *
 * Three things here are load-bearing and easy to get wrong.
 *
 * 1. DATABASE_URL must point at Supabase's TRANSACTION pooler, port 6543
 *    (`aws-<region>.pooler.supabase.com:6543`). Supabase's own docs assign
 *    transaction mode to "serverless and edge functions" and session mode
 *    (5432) to persistent backends. The CLI's `link` step caches the 5432 URL,
 *    so this is a real trap. The direct connection is also IPv6-only on the
 *    free tier, which Vercel Functions cannot reliably reach — the pooler is
 *    not optional.
 *
 * 2. The pool lives at module scope so it is reused across invocations of a
 *    warm Fluid Compute instance, and `attachDatabasePool` lets the runtime
 *    release idle clients before an instance suspends. Without that call,
 *    suspended instances hold pooler slots they are not using and the project
 *    runs out of client connections while appearing idle.
 *
 * 3. NUMERIC comes back as a string, deliberately. node-postgres would happily
 *    hand us a JS number and silently destroy precision on a balance. Every
 *    money value stays a string end to end — through the domain layer as
 *    Decimal, and out to the client as a string, matching BackupService's
 *    existing "\(decimal)" wire discipline.
 */

// OID 1700 = numeric/decimal. Keep it textual.
types.setTypeParser(1700, (v) => v);
// OID 20 = int8/bigint. Also string, to avoid the 2^53 cliff.
types.setTypeParser(20, (v) => v);

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

if (!/:6543\//.test(connectionString)) {
  // Loud rather than subtly slow. Session mode works right up until enough
  // instances exist to exhaust the connection limit, which is exactly when you
  // least want to be debugging it.
  console.warn(
    '[db] DATABASE_URL is not on port 6543. Serverless needs the transaction pooler; ' +
      'session mode (5432) will exhaust connections under scale-out.',
  );
}

export const pool = new Pool({
  connectionString,
  // Deliberately small. Under Fluid Compute one instance serves many concurrent
  // requests, so a handful of connections is plenty — and the real constraint is
  // instances x max, measured against Supavisor's client limit. Raising this is
  // usually the wrong fix; adding a queue or caching is the right one.
  max: 3,
  // Return a client to the pooler quickly when traffic drops.
  idleTimeoutMillis: 10_000,
  // Fail fast instead of piling up waiters behind an exhausted pooler.
  connectionTimeoutMillis: 5_000,
  // A runaway query must not hold a pooler slot for the whole function timeout.
  statement_timeout: 15_000,
  query_timeout: 15_000,
  // Supavisor terminates TLS with a certificate that does not validate against
  // the system roots. The connection is still encrypted; we are pinned to a
  // hostname supplied by our own env var, not user input.
  ssl: { rejectUnauthorized: false },
});

// Must be called immediately after the pool is created.
attachDatabasePool(pool);

pool.on('error', (err) => {
  // An idle client erroring out is normal when the pooler recycles; log rather
  // than let it become an unhandled rejection that kills the instance.
  console.error('[db] idle client error:', err.message);
});

export const db = drizzle(pool);

/** Pool gauge for the connection-exhaustion spike and for later observability. */
export function poolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}
