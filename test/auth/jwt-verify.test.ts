import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * Phase 0 spike 3: the full auth chain, end to end.
 *
 *   real Supabase JWT -> JWKS signature verification -> resolved subject
 *                     -> RLS-scoped query returning only that subject's rows
 *
 * The token is minted by a password grant rather than Sign in with Apple. That
 * is deliberate and does not weaken the proof: Supabase issues the SAME access
 * token regardless of which provider authenticated the user — same issuer, same
 * audience, same ES256 signing key, same `sub` semantics. What differs is only
 * the identity-token exchange that happens BEFORE the session exists, which is
 * Apple's well-trodden path and is verified on-device.
 *
 * Skips when no token is present so CI stays green.
 */

const tokenPath = '/tmp/spike3_token';
const token = process.env.SPIKE3_TOKEN
  ?? (existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : null);

const conn = process.env.DATABASE_URL
  ?? (existsSync('supabase/.temp/pooler-url')
        ? readFileSync('supabase/.temp/pooler-url', 'utf8').trim()
        : null);

const suite = token && conn ? describe : describe.skip;

suite('spike 3 — JWT verification and RLS scoping', () => {
  let verifyRequest: typeof import('../../lib/auth/verify.js').verifyRequest;
  let AuthError: typeof import('../../lib/auth/verify.js').AuthError;
  let userId: string;

  beforeAll(async () => {
    process.env.SUPABASE_URL ??= 'https://itkyospywqydgtahohhq.supabase.co';
    const mod = await import('../../lib/auth/verify.js');
    verifyRequest = mod.verifyRequest;
    AuthError = mod.AuthError;
  });

  it('verifies a real token against the published JWKS', async () => {
    const ctx = await verifyRequest({ authorization: `Bearer ${token}` });
    expect(ctx.userId).toMatch(/^[0-9a-f-]{36}$/);
    userId = ctx.userId;
  });

  it('rejects a token with a tampered payload', async () => {
    // Flip one character in the payload segment. The signature no longer covers
    // it, so verification must fail — this is the whole point of verifying
    // rather than merely decoding.
    const [h, p, s] = token!.split('.') as [string, string, string];
    const tampered = `${h}.${p.slice(0, -2)}${p.slice(-2) === 'AA' ? 'BB' : 'AA'}.${s}`;
    await expect(verifyRequest({ authorization: `Bearer ${tampered}` })).rejects.toThrow(AuthError);
  });

  it('rejects a syntactically valid but unsigned token', async () => {
    const [, p] = token!.split('.') as [string, string, string];
    const alg = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    await expect(verifyRequest({ authorization: `Bearer ${alg}.${p}.` })).rejects.toThrow(AuthError);
  });

  it('rejects a missing or malformed Authorization header', async () => {
    await expect(verifyRequest({})).rejects.toThrow(AuthError);
    await expect(verifyRequest({ authorization: token! })).rejects.toThrow(AuthError);
  });

  it('the verified subject sees only its own rows under RLS', async () => {
    const client = new pg.Client({ connectionString: conn!, ssl: { rejectUnauthorized: false } });
    await client.connect();

    // Self-provisioning rather than relying on a fixture, so this runs against
    // ANY valid token — including a real Sign in with Apple session lifted from
    // the running app.
    const DECOY_USER = 'ffffffff-0000-4000-8000-00000000000f';
    const MINE = 'ffffffff-1111-4000-8000-000000000011';
    const THEIRS = 'ffffffff-2222-4000-8000-000000000022';

    try {
      const ctx = await verifyRequest({ authorization: `Bearer ${token}` });

      await client.query(`delete from public.wallets where id = any($1::uuid[])`, [[MINE, THEIRS]]);
      await client.query(`delete from auth.users where id = $1`, [DECOY_USER]);
      await client.query(
        `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                 email_confirmed_at, created_at, updated_at,
                                 raw_app_meta_data, raw_user_meta_data)
         values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
                 'rls-decoy@netwise.local','',now(),now(),now(),'{}'::jsonb,'{}'::jsonb)`,
        [DECOY_USER],
      );
      await client.query(
        `insert into public.wallets (id, user_id, name, currency)
         values ($1,$2,'Mine','IDR'), ($3,$4,'Not mine','USD')`,
        [MINE, ctx.userId, THEIRS, DECOY_USER],
      );

      // SET LOCAL inside a transaction — see the note in test/rls/isolation.ts.
      // Session-level SET is lost through the transaction pooler and the query
      // runs unscoped, which fails OPEN by returning every user's rows.
      await client.query('begin');
      await client.query('set local role authenticated');
      await client.query(
        `set local request.jwt.claims = '${JSON.stringify({ sub: ctx.userId, role: 'authenticated' })}'`,
      );
      const { rows } = await client.query<{ name: string }>(
        `select name from public.wallets where id = any($1::uuid[]) order by name`,
        [[MINE, THEIRS]],
      );
      await client.query('commit');

      // Both rows exist and the query does not filter by user — only RLS does.
      expect(rows.map((r) => r.name)).toEqual(['Mine']);
    } finally {
      await client.query(`delete from public.wallets where id = any($1::uuid[])`, [[MINE, THEIRS]]).catch(() => {});
      await client.query(`delete from auth.users where id = $1`, [DECOY_USER]).catch(() => {});
      await client.end();
    }
  });
});
