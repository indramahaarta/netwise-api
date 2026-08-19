/**
 * Port of NetWise/Models/FeatureLimits.swift and Models/AppConfig.swift.
 *
 * These values must stay in step with three other places, which is a known
 * wart carried over from v1.4: the bundled Swift constants, AppConfig.default,
 * and netwise-api/api/appconfig.json. The server is becoming the authority, so
 * new limits should be added here first and mirrored outward.
 */

export interface Limits {
  wallets: number;
  portfolios: number;
  categories: number;
  tags: number;
}

/** Matches FeatureLimits.swift exactly. */
export const DEFAULT_LIMITS: Limits = {
  wallets: 6,
  portfolios: 3,
  categories: 8,
  tags: 3,
};

export type FeatureState = 'all' | 'premium' | 'off';

/** Mirrors api/appconfig.json's `features`. */
export const DEFAULT_FEATURES: Record<string, FeatureState> = {
  dashboardPerformanceMatrix: 'premium',
  dashboardTopHoldings: 'premium',
  dashboardBestWorst: 'premium',
  dashboardDividendIncome: 'premium',
  dashboardSpendingByCategory: 'off',
  dashboardSpendingByTag: 'premium',
  dashboardSavingsRate: 'premium',
  dashboardLargestExpenses: 'premium',
  emailAutoCapture: 'off',
  aiCapture: 'all',
};

export function isFeatureEnabled(state: FeatureState | undefined, isPremium: boolean): boolean {
  switch (state) {
    case 'all':     return true;
    case 'premium': return isPremium;
    default:        return false;
  }
}

/** Resolve every feature for one user, so the client does no gating logic. */
export function resolveFeatures(
  isPremium: boolean,
  overrides: Record<string, FeatureState> = {},
): Record<string, boolean> {
  const merged = { ...DEFAULT_FEATURES, ...overrides };
  return Object.fromEntries(
    Object.entries(merged).map(([key, state]) => [key, isFeatureEnabled(state, isPremium)]),
  );
}

export function canCreate(currentCount: number, limit: number, isPremium: boolean): boolean {
  return isPremium || currentCount < limit;
}
