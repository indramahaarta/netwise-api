import { Decimal, ZERO, dec } from './decimal.js';
import { customPeriodStart, customWeekStart, startOfDay } from './periods.js';
import type { BudgetPeriod } from '../db/schema.js';

/**
 * Port of NetWise/Services/BudgetService.swift.
 * Pinned by NetWiseTests/BudgetServiceTests.swift.
 *
 * Shape difference from Swift, deliberate: Swift iterates `wallets` and reads
 * `wallet.transactions` / `wallet.currency`. Server-side the natural query
 * returns a flat, already-joined row set, so these take a flat transaction list
 * carrying `walletCurrency`. Same arithmetic, one fewer nested loop.
 */

export interface BudgetTx {
  type: string;
  /** Signed, as stored. Expenses are negative; the math takes abs(). */
  amount: string;
  /** ISO-8601 instant. */
  date: string;
  categoryId: string | null;
  deletedAt: string | null;
  /** Currency of the owning wallet, for conversion to main. */
  walletCurrency: string;
}

export interface BudgetRow {
  id: string;
  categoryId: string | null;
  period: BudgetPeriod;
  amount: string;
  currencyCode: string;
  deletedAt: string | null;
  lastNotifiedThreshold: number | null;
  lastNotifiedPeriodStart: string | null;
}

export interface PeriodSettings {
  weekStartDay: number;
  monthStartDay: number;
  timeZone: string;
}

export type ToMain = (amount: Decimal, currency: string) => Decimal;

export interface BudgetCrossing {
  budgetId: string;
  categoryId: string;
  threshold: number;
  periodStart: Date;
}

/** Start of the current period for a budget's cadence. */
export function periodStart(
  period: BudgetPeriod,
  referenceDate: Date,
  s: PeriodSettings,
): Date {
  switch (period) {
    case 'DAILY':
      return startOfDay(referenceDate, s.timeZone);
    case 'WEEKLY':
      return customWeekStart(referenceDate, s.weekStartDay, s.timeZone);
    case 'MONTHLY':
      return customPeriodStart(referenceDate, s.monthStartDay, s.timeZone);
  }
}

/**
 * Spend so far this period for one budget.
 *
 * Filters, all of which matter: not soft-deleted, type EXPENSE only, dated at
 * or after the period start, and at or before `referenceDate` — future-dated
 * transactions are excluded, so scheduling next month's rent does not
 * immediately trip this month's alert.
 */
export function spent(
  budget: BudgetRow,
  transactions: BudgetTx[],
  referenceDate: Date,
  s: PeriodSettings,
  toMain: ToMain,
): Decimal {
  if (!budget.categoryId) return ZERO;
  const start = periodStart(budget.period, referenceDate, s).getTime();
  const ref = referenceDate.getTime();

  let total = ZERO;
  for (const tx of transactions) {
    if (tx.deletedAt !== null) continue;
    if (tx.type !== 'EXPENSE') continue;
    if (tx.categoryId !== budget.categoryId) continue;
    const t = new Date(tx.date).getTime();
    if (t < start || t > ref) continue;
    total = total.plus(toMain(dec(tx.amount).abs(), tx.walletCurrency));
  }
  return total;
}

/**
 * Spend for many budgets in ONE pass over the transactions.
 *
 * The Swift version exists because calling `spent` per budget rescans every
 * wallet each time — noted in the source as "genuinely expensive… was
 * previously blocking the See Details tap-to-sheet transition". Server-side the
 * same reasoning applies to a dashboard payload that renders every budget row.
 */
export function spentByBudget(
  budgets: BudgetRow[],
  transactions: BudgetTx[],
  referenceDate: Date,
  s: PeriodSettings,
  toMain: ToMain,
): Map<string, Decimal> {
  const result = new Map<string, Decimal>();
  if (budgets.length === 0) return result;

  // One period-start computation per distinct cadence, not per budget.
  const starts = new Map<BudgetPeriod, number>();
  for (const b of budgets) {
    if (!starts.has(b.period)) {
      starts.set(b.period, periodStart(b.period, referenceDate, s).getTime());
    }
  }

  const byCategory = new Map<string, BudgetRow[]>();
  for (const b of budgets) {
    if (!b.categoryId) continue;
    const list = byCategory.get(b.categoryId);
    if (list) list.push(b);
    else byCategory.set(b.categoryId, [b]);
  }

  const ref = referenceDate.getTime();

  for (const tx of transactions) {
    if (tx.deletedAt !== null) continue;
    if (tx.type !== 'EXPENSE') continue;
    if (!tx.categoryId) continue;
    const candidates = byCategory.get(tx.categoryId);
    if (!candidates) continue;
    const t = new Date(tx.date).getTime();
    if (t > ref) continue;

    for (const budget of candidates) {
      const start = starts.get(budget.period);
      if (start === undefined || t < start) continue;
      const add = toMain(dec(tx.amount).abs(), tx.walletCurrency);
      result.set(budget.id, (result.get(budget.id) ?? ZERO).plus(add));
    }
  }

  return result;
}

/**
 * Threshold (90 or 100) reached, or null below 90%.
 *
 * NOTE: this deliberately goes through a float, because Swift does:
 * `NSDecimalNumber(decimal: spent / amount).doubleValue * 100`. Computing it in
 * exact decimal instead would be "better" and would disagree with the shipping
 * app at the boundary. Parity wins — and this only gates a notification, never
 * a money value.
 */
export function crossedThreshold(spentAmount: Decimal, amount: Decimal): number | null {
  if (!amount.gt(0)) return null;
  const pct = spentAmount.div(amount).toNumber() * 100;
  if (pct >= 100) return 100;
  if (pct >= 90) return 90;
  return null;
}

/**
 * The budget's configured limit converted to main currency.
 *
 * Always use this rather than `budget.amount` directly: amount/currencyCode can
 * fall out of sync with the user's current main currency when a currency-change
 * conversion failed to resolve a rate, and comparing a raw 158,000 IDR limit
 * against $9.50 of spend would never trip.
 */
export function amountInMain(budget: BudgetRow, toMain: ToMain): Decimal {
  return toMain(dec(budget.amount), budget.currencyCode);
}

/** Progress-bar fraction. Float, matching Swift's `.doubleValue`. */
export function fraction(
  budget: BudgetRow,
  transactions: BudgetTx[],
  referenceDate: Date,
  s: PeriodSettings,
  toMain: ToMain,
): number {
  const amount = amountInMain(budget, toMain);
  if (!amount.gt(0)) return 0;
  const spentAmount = spent(budget, transactions, referenceDate, s, toMain);
  return Math.max(0, spentAmount.div(amount).toNumber());
}

/**
 * Is this crossing new — either a new period, or a higher threshold than the
 * one already notified within the current period?
 */
export function shouldNotify(
  threshold: number,
  periodStartDate: Date,
  lastNotifiedThreshold: number | null,
  lastNotifiedPeriodStart: string | null,
): boolean {
  const last = lastNotifiedPeriodStart === null ? null : new Date(lastNotifiedPeriodStart).getTime();
  if (last !== periodStartDate.getTime()) return true;
  return threshold > (lastNotifiedThreshold ?? 0);
}

/** Budgets that have newly crossed 90% or 100% and warrant a notification. */
export function evaluateCrossings(
  budgets: BudgetRow[],
  transactions: BudgetTx[],
  referenceDate: Date,
  s: PeriodSettings,
  toMain: ToMain,
): BudgetCrossing[] {
  const out: BudgetCrossing[] = [];

  for (const budget of budgets) {
    if (budget.deletedAt !== null) continue;
    if (!budget.categoryId) continue;

    const start = periodStart(budget.period, referenceDate, s);
    const spentAmount = spent(budget, transactions, referenceDate, s, toMain);
    const limit = amountInMain(budget, toMain);

    const threshold = crossedThreshold(spentAmount, limit);
    if (threshold === null) continue;
    if (!shouldNotify(threshold, start, budget.lastNotifiedThreshold, budget.lastNotifiedPeriodStart)) {
      continue;
    }

    out.push({
      budgetId: budget.id,
      categoryId: budget.categoryId,
      threshold,
      periodStart: start,
    });
  }

  return out;
}
