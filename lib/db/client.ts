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

/**
 * Run a callback with the connection scoped to one user's RLS context.
 *
 * READ THE TRANSACTION NOTE BEFORE CHANGING THIS.
 *
 * `SET role` and `SET request.jwt.claims` are SESSION-level. We connect through
 * Supabase's transaction-mode pooler, where consecutive statements can be served
 * by different backends — so a session-level SET is silently dropped and the
 * following query runs UNSCOPED.
 *
 * That failure mode is the dangerous kind: it fails OPEN. No error is raised;
 * the query simply returns every user's rows. It is also load-dependent, so it
 * looks fine in testing and breaks under concurrency. We hit exactly this — the
 * RLS suite passed in isolation and returned all users' wallets the moment a
 * second test file ran alongside it.
 *
 * An explicit transaction is pinned to a single backend for its lifetime, so
 * SET LOCAL holds for every statement inside it and is discarded on COMMIT.
 *
 * Note the v2 API normally reaches Postgres as service_role and scopes by an
 * explicit `where user_id = $1`, with RLS as defence in depth rather than the
 * primary control. Use this helper for anything that does rely on RLS.
 */
export async function withUserScope<T>(
  userId: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role authenticated');
    await client.query('set local request.jwt.claims = $1', [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
