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
    try {
      const ctx = await verifyRequest({ authorization: `Bearer ${token}` });

      // SET LOCAL inside a transaction — see the note in test/rls/isolation.ts.
      // Session-level SET is lost through the transaction pooler and the query
      // runs unscoped, which fails OPEN by returning every user's rows.
      await client.query('begin');
      await client.query('set local role authenticated');
      await client.query(
        `set local request.jwt.claims = '${JSON.stringify({ sub: ctx.userId, role: 'authenticated' })}'`,
      );
      const { rows } = await client.query<{ name: string }>('select name from public.wallets');
      await client.query('commit');

      // Two wallets exist in the table; the token must reach exactly one.
      expect(rows.map((r) => r.name)).toEqual(['Spike wallet']);
    } finally {
      await client.end();
    }
  });
});
