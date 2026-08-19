import { createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { AuthError, verifyRequest, type AuthContext } from '../auth/verify.js';

/**
 * Shared plumbing for every /api/v2 endpoint.
 *
 * Deliberately small. The one thing it enforces is that a handler cannot run
 * without an authenticated context — `withAuth` resolves the user before the
 * handler body exists, so there is no code path where a handler forgets to
 * check and quietly serves another user's data.
 */

export interface ApiError {
  error: string;
  message: string;
}

export function fail(res: VercelResponse, status: number, error: string, message: string) {
  res.status(status).json({ error, message } satisfies ApiError);
}

/**
 * JSON response with a strong ETag, so an unchanged payload costs the client a
 * 304 and no parsing. /api/config already proves the pattern against the
 * shipping app.
 *
 * `private` because every payload here is one user's financial data — it must
 * never be held by a shared cache.
 */
export function json(req: VercelRequest, res: VercelResponse, body: unknown, maxAge = 0) {
  const payload = JSON.stringify(body);
  const etag = `"${createHash('sha256').update(payload).digest('hex').slice(0, 32)}"`;

  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `private, max-age=${maxAge}`);

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).send(payload);
}

type Handler = (
  req: VercelRequest,
  res: VercelResponse,
  auth: AuthContext,
) => Promise<void> | void;

/**
 * Wraps a handler with method checking and authentication.
 *
 * Auth failures return a generic message rather than the underlying reason.
 * "invalid token: signature verification failed" tells an attacker which of
 * their guesses got further; "unauthorized" does not.
 */
export function withAuth(methods: string[], handler: Handler) {
  return async (req: VercelRequest, res: VercelResponse) => {
    if (!methods.includes(req.method ?? '')) {
      res.setHeader('Allow', methods.join(', '));
      fail(res, 405, 'method_not_allowed', `Use ${methods.join(' or ')}.`);
      return;
    }

    let auth: AuthContext;
    try {
      auth = await verifyRequest(req.headers);
    } catch (e) {
      if (e instanceof AuthError) {
        console.warn('[auth] rejected:', e.message);
        fail(res, e.status, 'unauthorized', 'Sign in again to continue.');
      } else {
        console.error('[auth] unexpected:', e);
        fail(res, 401, 'unauthorized', 'Sign in again to continue.');
      }
      return;
    }

    try {
      await handler(req, res, auth);
    } catch (e) {
      // Never leak an internal error to the client; log it and return a shape
      // the app can render.
      console.error('[handler] error:', e);
      if (!res.headersSent) {
        fail(res, 500, 'server_error', 'Something went wrong. Please try again.');
      }
    }
  };
}

/**
 * The user's IANA timezone for this request.
 *
 * Every period boundary, budget window and daily snapshot is a local-calendar
 * concept, so a wrong zone silently shifts a month boundary and changes totals.
 * The stored setting wins; the header is a fallback for a client whose settings
 * row does not exist yet.
 */
export function resolveTimeZone(req: VercelRequest, stored: string | null | undefined): string {
  const header = req.headers['x-netwise-tz'];
  const candidate = stored ?? (Array.isArray(header) ? header[0] : header) ?? 'Asia/Jakarta';
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate });
    return candidate;
  } catch {
    return 'Asia/Jakarta';
  }
}
