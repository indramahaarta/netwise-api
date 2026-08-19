import type { PoolClient } from 'pg';

/**
 * First-sign-in provisioning: a settings row and the default categories.
 *
 * Runs inside the caller's transaction and is idempotent, so a client that
 * retries bootstrap (or fires two in parallel on launch) cannot end up with two
 * settings rows or twenty categories.
 */

/**
 * Transcribed from CategorySeedService.swift. Order matters only for stable
 * display; the flags do not — `isSystem` marks the two catch-alls that absorb
 * transactions when a user deletes a category, and they must never be deletable.
 */
const DEFAULT_CATEGORIES: Array<{ name: string; isSystem: boolean; isIncome: boolean; icon: string }> = [
  { name: 'Salary',        isSystem: false, isIncome: true,  icon: '💼' },
  { name: 'Freelance',     isSystem: false, isIncome: true,  icon: '💻' },
  { name: 'Investment',    isSystem: false, isIncome: true,  icon: '📈' },
  { name: 'Other Income',  isSystem: true,  isIncome: true,  icon: '💰' },
  { name: 'Food',          isSystem: false, isIncome: false, icon: '🍔' },
  { name: 'Transport',     isSystem: false, isIncome: false, icon: '🚗' },
  { name: 'Shopping',      isSystem: false, isIncome: false, icon: '🛍️' },
  { name: 'Bills',         isSystem: false, isIncome: false, icon: '🧾' },
  { name: 'Health',        isSystem: false, isIncome: false, icon: '❤️' },
  { name: 'Other Expense', isSystem: true,  isIncome: false, icon: '📦' },
];

/**
 * Swift's `Date.distantPast`. v1.4 stamps seeded categories with it as a
 * sentinel meaning "never premium-locked" — LimitChecker.lockedCategories
 * excludes them from the free-tier ranking. Seeding with `now()` instead would
 * make a brand-new user's own default categories count against their limit.
 */
const DISTANT_PAST = '0001-01-01T00:00:00.000Z';

export interface ProvisionResult {
  created: boolean;
  seededCategories: number;
}

export async function ensureProvisioned(
  client: PoolClient,
  userId: string,
  timeZone: string,
): Promise<ProvisionResult> {
  const settings = await client.query(
    `insert into public.user_settings (user_id, timezone)
     values ($1, $2)
     on conflict (user_id) do nothing
     returning user_id`,
    [userId, timeZone],
  );
  const created = (settings.rowCount ?? 0) > 0;

  // Seed only when the user has no categories at all, mirroring
  // CategorySeedService.seedIfNeeded. A user who deliberately deleted every
  // category should not have them silently reappear on next launch.
  const existing = await client.query<{ n: string }>(
    `select count(*)::text as n from public.wallet_categories where user_id = $1`,
    [userId],
  );
  if (Number(existing.rows[0]?.n ?? '0') > 0) {
    return { created, seededCategories: 0 };
  }

  const values: unknown[] = [userId, DISTANT_PAST];
  const tuples = DEFAULT_CATEGORIES.map((c, i) => {
    const base = i * 4 + 3;
    values.push(c.name, c.isSystem, c.isIncome, c.icon);
    return `(gen_random_uuid(), $1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $2)`;
  });

  await client.query(
    `insert into public.wallet_categories
       (id, user_id, name, is_system, is_income, icon, created_at)
     values ${tuples.join(', ')}`,
    values,
  );

  return { created, seededCategories: DEFAULT_CATEGORIES.length };
}
