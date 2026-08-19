import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';

/**
 * Live RLS isolation proof, run against the real database.
 *
 * This exists because RLS regressions are silent. Nothing crashes when a policy
 * is subtly wrong — one user simply starts seeing another user's financial
 * ledger, and the first sign is a support email. A schema change that widens a
 * policy, a table added without RLS, or a re-granted privilege all pass every
 * other test in this repo.
 *
 * Skipped automatically when no database URL is available, so CI without
 * credentials stays green rather than red-for-the-wrong-reason.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const UNKNOWN = 'cccccccc-0000-4000-8000-000000000003';

function connectionString(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const cached = 'supabase/.temp/pooler-url';
  if (existsSync(cached)) return readFileSync(cached, 'utf8').trim();
  return null;
}

const conn = connectionString();
const suite = conn ? describe : describe.skip;

suite('RLS isolation (live database)', () => {
  let client: pg.Client;

  /**
   * Run a query as `authenticated` with the given subject's JWT claims.
   *
   * MUST be an explicit transaction with SET LOCAL, not session-level SET.
   * We connect through Supabase's TRANSACTION pooler, where each statement can
   * be handed to a different backend — a session-level `set role` is therefore
   * silently dropped before the next statement runs, and the query executes
   * unscoped. That is a total RLS bypass, and it fails open: you get MORE rows,
   * not an error. A transaction is pinned to one backend for its duration, so
   * SET LOCAL holds. This bit us for real: these tests passed in isolation and
   * returned every user's wallets the moment two files ran concurrently.
   */
  async function asUser<T extends pg.QueryResultRow>(sub: string, sql: string): Promise<T[]> {
    await client.query('begin');
    try {
      await client.query('set local role authenticated');
      await client.query(
        `set local request.jwt.claims = '${JSON.stringify({ sub, role: 'authenticated' })}'`,
      );
      const r = await client.query<T>(sql);
      await client.query('commit');
      return r.rows;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    }
  }

  async function seed() {
    await cleanup();
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                               email_confirmed_at, created_at, updated_at,
                               raw_app_meta_data, raw_user_meta_data)
       values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
               'rls-a@test.local','',now(),now(),now(),'{"provider":"apple"}'::jsonb,'{}'::jsonb),
              ($2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
               'rls-b@test.local','',now(),now(),now(),'{"provider":"apple"}'::jsonb,'{}'::jsonb)`,
      [A, B],
    );
    await client.query(
      `insert into public.wallets (id, user_id, name, currency)
       values ('11111111-0000-4000-8000-000000000001',$1,'A wallet','IDR'),
              ('22222222-0000-4000-8000-000000000002',$2,'B wallet','USD')`,
      [A, B],
    );
  }

  async function cleanup() {
    await client.query('reset role').catch(() => {});
    await client.query(`delete from public.wallets where user_id = any($1::uuid[])`, [[A, B]]);
    await client.query(`delete from auth.users where id = any($1::uuid[])`, [[A, B]]);
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: conn!, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await seed();
  }, 30_000);

  afterAll(async () => {
    if (client) {
      await cleanup();
      await client.end();
    }
  });

  it('a user sees exactly their own wallet', async () => {
    const rows = await asUser<{ name: string }>(A, 'select name from public.wallets');
    expect(rows.map((r) => r.name)).toEqual(['A wallet']);
  });

  it('a user cannot see another user’s wallet', async () => {
    const rows = await asUser<{ n: string }>(
      A,
      `select count(*)::text as n from public.wallets where user_id = '${B}'`,
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('the other user sees only their own, proving it is not a fixed filter', async () => {
    const rows = await asUser<{ name: string }>(B, 'select name from public.wallets');
    expect(rows.map((r) => r.name)).toEqual(['B wallet']);
  });

  it('an unknown subject sees nothing', async () => {
    const rows = await asUser<{ n: string }>(UNKNOWN, 'select count(*)::text as n from public.wallets');
    expect(rows[0]!.n).toBe('0');
  });

  it('clients hold no write privilege on any user table', async () => {
    const { rows } = await client.query<{ tablename: string; priv: string }>(
      `select table_name as tablename, privilege_type as priv
         from information_schema.role_table_grants
        where grantee in ('authenticated','anon')
          and table_schema = 'public'
          and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`,
    );
    // Writes go through Vercel functions as service_role, because the ledger's
    // invariants live in application code, not constraints.
    expect(rows).toEqual([]);
  });

  it('global market-data tables are unreadable by clients', async () => {
    for (const t of ['price_quotes', 'price_history', 'fx_rates', 'fx_history']) {
      const { rows } = await client.query<{ ok: boolean }>(
        `select has_table_privilege('authenticated', 'public.${t}', 'SELECT') as ok`,
      );
      expect(rows[0]!.ok, `${t} should not be client-readable`).toBe(false);
    }
  });

  it('every public table has RLS enabled', async () => {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_tables
        where schemaname = 'public' and not rowsecurity`,
    );
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });
});
