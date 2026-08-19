import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Verifies a Supabase-issued JWT and resolves the caller's user id.
 *
 * Every v2 endpoint runs through this. Two properties matter:
 *
 *   1. Signature is verified against Supabase's PUBLISHED JWKS, fetched over
 *      HTTPS and cached. We never trust the token's own claims until the
 *      signature checks out — a JWT is a signed assertion, and an unverified
 *      one is just a string the client made up.
 *
 *   2. `sub` becomes the row-level tenant key for the entire request. It is
 *      never taken from a header, a query param, or a body field. The whole
 *      reason v1.4's `X-NetWise-Premium: true` header was untenable is that a
 *      client-asserted identity is not an identity.
 *
 * Note this is deliberately NOT the anon key or service role key path. Those
 * are project-wide credentials; this is a per-user token.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL is not set');
}

// Supabase publishes its signing keys here. createRemoteJWKSet caches the key
// set and refetches on unknown `kid`, so key rotation needs no redeploy.
const JWKS = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

export interface AuthContext {
  userId: string;
  email: string | null;
  /** Apple's stable subject for this user, when signed in via Apple. */
  provider: string | null;
  claims: JWTPayload;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function bearerFrom(headerValue: string | string[] | undefined): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) throw new AuthError('missing Authorization header');
  const [scheme, token] = raw.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new AuthError('Authorization header must be "Bearer <token>"');
  }
  return token;
}

/**
 * Verify a request's bearer token. Throws AuthError on anything suspect —
 * callers map that to a 401 rather than leaking why.
 */
export async function verifyRequest(headers: {
  authorization?: string | string[] | undefined;
}): Promise<AuthContext> {
  const token = bearerFrom(headers.authorization);

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, JWKS, {
      issuer: `${SUPABASE_URL}/auth/v1`,
      // Supabase issues access tokens with aud "authenticated".
      audience: 'authenticated',
    });
    payload = result.payload;
  } catch (e) {
    throw new AuthError(`invalid token: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  if (!userId) throw new AuthError('token has no subject');

  // Reject anonymous sessions explicitly. The v2.0 decision was Sign in with
  // Apple required; an anonymous JWT would otherwise silently create an
  // unrecoverable account holding someone's financial ledger.
  if (payload.is_anonymous === true) {
    throw new AuthError('anonymous sessions are not permitted', 403);
  }

  return {
    userId,
    email: typeof payload.email === 'string' ? payload.email : null,
    provider:
      typeof payload.app_metadata === 'object' &&
      payload.app_metadata !== null &&
      'provider' in payload.app_metadata &&
      typeof (payload.app_metadata as Record<string, unknown>).provider === 'string'
        ? ((payload.app_metadata as Record<string, unknown>).provider as string)
        : null,
    claims: payload,
  };
}
