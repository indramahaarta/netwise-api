import type { VercelRequest, VercelResponse } from '@vercel/node';
import { pool } from '../../lib/db/client.js';
import { ensureProvisioned } from '../../lib/db/provision.js';
import { json, resolveTimeZone, withAuth } from '../../lib/http/respond.js';
import { DEFAULT_LIMITS, canCreate, resolveFeatures } from '../../lib/domain/entitlements.js';

/**
 * GET /api/v2/bootstrap — everything the app needs at launch, in one round trip.
 *
 * This endpoint sets the pattern for the whole v2 read API:
 *
 *   * ONE round trip. The client is thin, so every extra request is latency the
 *     user watches. v1.4's launch did a dozen local queries; this replaces them.
 *
 *   * Gating is RESOLVED, not delegated. The client receives `features` as
 *     booleans and `canCreate` as booleans — it never re-implements the premium
 *     rules. v1.4 had those rules in three places that had to be kept in sync
 *     by hand; there is now one.
 *
 *   * Money is a decimal STRING, never a JSON number. NUMERIC comes back from
 *     the driver as text (see lib/db/client.ts) and stays that way to the app,
 *     matching BackupService's existing discipline.
 *
 *   * Provisioning happens here, idempotently, so a brand-new account and a
 *     returning one take the same path.
 */

interface WalletSummary {
  id: string;
  name: string;
  currency: string;
  balance: string;
  isMain: boolean;
  isFavorite: boolean;
  groupId: string | null;
}

interface PortfolioSummary {
  id: string;
  name: string;
  currency: string;
  market: string | null;
  cash: string;
}

export default withAuth(['GET'], async (req: VercelRequest, res: VercelResponse, auth) => {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const existing = await client.query<{ timezone: string }>(
      `select timezone from public.user_settings where user_id = $1`,
      [auth.userId],
    );
    const timeZone = resolveTimeZone(req, existing.rows[0]?.timezone);

    const provision = await ensureProvisioned(client, auth.userId, timeZone);

    const [settings, entitlement, wallets, portfolios, counts] = await Promise.all([
      client.query<{
        main_currency: string;
        timezone: string;
        period_start_day: number;
        week_start_day: number;
        hide_sensitive_data: boolean;
        net_worth_target_amount: string | null;
        net_worth_target_currency: string | null;
        ai_capture_consent_at: string | null;
      }>(
        `select main_currency, timezone, period_start_day, week_start_day,
                hide_sensitive_data, net_worth_target_amount,
                net_worth_target_currency, ai_capture_consent_at
           from public.user_settings where user_id = $1`,
        [auth.userId],
      ),

      client.query<{ is_premium: boolean; expires_at: string | null; product_id: string | null }>(
        `select is_premium, expires_at, product_id
           from public.user_entitlements where user_id = $1`,
        [auth.userId],
      ),

      // Balance is a plain SUM over the signed amount column — v1.4 encodes
      // direction in the sign, so this is the whole calculation. Computing it
      // in SQL rather than shipping every transaction is the point of the
      // migration: v1.4's Wallet.balance was an O(all transactions) scan
      // re-run on every access.
      client.query<WalletSummary & { balance: string | null }>(
        `select w.id,
                w.name,
                w.currency,
                coalesce(sum(t.amount) filter (where t.deleted_at is null), 0)::text as balance,
                w.is_main     as "isMain",
                w.is_favorite as "isFavorite",
                w.group_id    as "groupId"
           from public.wallets w
           left join public.wallet_transactions t on t.wallet_id = w.id
          where w.user_id = $1 and w.deleted_at is null
          group by w.id
          order by w.is_main desc, w.favorited_at desc nulls last, w.created_at nulls first, w.name`,
        [auth.userId],
      ),

      // Cash comes from the derived view, not a stored column — see
      // migration 003 for why Portfolio.cash was dropped.
      client.query<PortfolioSummary>(
        `select p.id, p.name, p.currency, p.market,
                coalesce(c.cash, 0)::text as cash
           from public.portfolios p
           left join public.portfolio_cash c on c.portfolio_id = p.id
          where p.user_id = $1 and p.deleted_at is null
          order by p.created_at nulls first, p.name`,
        [auth.userId],
      ),

      client.query<{ wallets: string; portfolios: string; categories: string; tags: string }>(
        `select
           (select count(*)::text from public.wallets           where user_id = $1 and deleted_at is null) as wallets,
           (select count(*)::text from public.portfolios        where user_id = $1 and deleted_at is null) as portfolios,
           (select count(*)::text from public.wallet_categories where user_id = $1) as categories,
           (select count(*)::text from public.wallet_tags       where user_id = $1) as tags`,
        [auth.userId],
      ),
    ]);

    await client.query('commit');

    const s = settings.rows[0];
    const isPremium = entitlement.rows[0]?.is_premium ?? false;
    const c = counts.rows[0]!;

    json(req, res, {
      user: {
        id: auth.userId,
        email: auth.email,
        provider: auth.provider,
      },
      settings: {
        mainCurrency: s?.main_currency ?? 'IDR',
        timezone: s?.timezone ?? timeZone,
        periodStartDay: s?.period_start_day ?? 1,
        weekStartDay: s?.week_start_day ?? 1,
        hideSensitiveData: s?.hide_sensitive_data ?? false,
        netWorthTarget: s?.net_worth_target_amount
          ? { amount: s.net_worth_target_amount, currency: s.net_worth_target_currency }
          : null,
        aiCaptureConsentAt: s?.ai_capture_consent_at ?? null,
      },
      entitlement: {
        isPremium,
        productId: entitlement.rows[0]?.product_id ?? null,
        expiresAt: entitlement.rows[0]?.expires_at ?? null,
      },
      limits: DEFAULT_LIMITS,
      features: resolveFeatures(isPremium),
      // Resolved server-side so the client never re-implements the gate.
      canCreate: {
        wallet:    canCreate(Number(c.wallets),    DEFAULT_LIMITS.wallets,    isPremium),
        portfolio: canCreate(Number(c.portfolios), DEFAULT_LIMITS.portfolios, isPremium),
        category:  canCreate(Number(c.categories), DEFAULT_LIMITS.categories, isPremium),
        tag:       canCreate(Number(c.tags),       DEFAULT_LIMITS.tags,       isPremium),
      },
      counts: {
        wallets: Number(c.wallets),
        portfolios: Number(c.portfolios),
        categories: Number(c.categories),
        tags: Number(c.tags),
      },
      wallets: wallets.rows.map((w) => ({
        id: w.id,
        name: w.name,
        currency: w.currency,
        balance: w.balance ?? '0',
        isMain: w.isMain,
        isFavorite: w.isFavorite,
        groupId: w.groupId,
      })),
      portfolios: portfolios.rows,
      isNewAccount: provision.created,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});
