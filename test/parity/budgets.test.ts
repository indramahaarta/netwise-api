import { describe, expect, it } from 'vitest';
import { Decimal } from '../../lib/domain/decimal.js';
import {
  amountInMain,
  crossedThreshold,
  evaluateCrossings,
  fraction,
  periodStart,
  shouldNotify,
  spent,
  spentByBudget,
  type BudgetRow,
  type BudgetTx,
  type PeriodSettings,
} from '../../lib/domain/budgets.js';
import { customPeriodStart, customWeekStart, startOfDay, trailingPeriods } from '../../lib/domain/periods.js';
import { makeToMain, resolveRate } from '../../lib/domain/fx.js';

/**
 * Parity suite for BudgetService, CustomPeriod, CustomWeekPeriod and
 * ForexRateResolver.
 *
 * The BudgetService cases are transcribed from
 * NetWiseTests/BudgetServiceTests.swift, which pins behaviour against a UTC
 * calendar — so these use timeZone 'UTC' to compare like with like.
 *
 * The DST cases at the bottom have no Swift counterpart. They don't need one:
 * on iOS `Calendar.current` is the device's own zone and the app only ever asks
 * about "now" locally. On the server we compute other people's calendars from
 * UTC instants, so a DST boundary is a real failure mode that the iOS tests
 * could never have caught.
 */

const UTC: PeriodSettings = { weekStartDay: 1, monthStartDay: 1, timeZone: 'UTC' };
const identity = (amount: Decimal) => amount;

/** 2026-07-08T00:00:00Z etc — mirrors the Swift helper `utcDate(y, m, d)`. */
function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

const CAT = 'cat-dining';
const OTHER = 'cat-coffee';

// `date` is taken as a Date for readability and serialised here; Omit it from
// the Partial so it does not intersect with BudgetTx's string field.
function tx(p: Omit<Partial<BudgetTx>, 'date'> & { amount: string; date: Date }): BudgetTx {
  return {
    type: p.type ?? 'EXPENSE',
    amount: p.amount,
    date: p.date.toISOString(),
    categoryId: p.categoryId === undefined ? CAT : p.categoryId,
    deletedAt: p.deletedAt ?? null,
    walletCurrency: p.walletCurrency ?? 'USD',
  };
}

function budget(p: Partial<BudgetRow> = {}): BudgetRow {
  return {
    id: p.id ?? 'b1',
    categoryId: p.categoryId === undefined ? CAT : p.categoryId,
    period: p.period ?? 'DAILY',
    amount: p.amount ?? '100',
    currencyCode: p.currencyCode ?? 'USD',
    deletedAt: p.deletedAt ?? null,
    lastNotifiedThreshold: p.lastNotifiedThreshold ?? null,
    lastNotifiedPeriodStart: p.lastNotifiedPeriodStart ?? null,
  };
}

describe('BudgetService.periodStart parity', () => {
  it('daily period starts at the calendar day', () => {
    const d = utc(2026, 7, 8);
    expect(periodStart('DAILY', d, UTC).toISOString()).toBe(startOfDay(d, 'UTC').toISOString());
    expect(periodStart('DAILY', d, UTC).toISOString()).toBe('2026-07-08T00:00:00.000Z');
  });

  it('weekly period defers to CustomWeekPeriod', () => {
    // 2026-07-08 is a Wednesday; weekStartDay 2 = Monday -> preceding Monday.
    const start = periodStart('WEEKLY', utc(2026, 7, 8), { ...UTC, weekStartDay: 2 });
    expect(start.toISOString()).toBe(utc(2026, 7, 6).toISOString());
  });

  it('monthly period defers to CustomPeriod', () => {
    const start = periodStart('MONTHLY', utc(2026, 7, 26), { ...UTC, monthStartDay: 25 });
    expect(start.toISOString()).toBe(utc(2026, 7, 25).toISOString());
  });
});

describe('BudgetService.spent parity', () => {
  it('sums only expense transactions in the budgeted category since period start', () => {
    const today = utc(2026, 7, 8);
    const txs: BudgetTx[] = [
      tx({ amount: '-10', date: today }),
      tx({ amount: '-15', date: today }),
      tx({ amount: '-100', date: today, categoryId: OTHER }),
      tx({ amount: '500', date: today, type: 'INCOME' }),
      tx({ amount: '-999', date: utc(2026, 7, 6) }), // before the daily period
    ];
    const result = spent(budget({ amount: '50' }), txs, today, UTC, identity);
    expect(result.toFixed()).toBe('25');
  });

  it('excludes soft-deleted transactions', () => {
    const today = utc(2026, 7, 8);
    const txs = [tx({ amount: '-30', date: today, deletedAt: today.toISOString() })];
    expect(spent(budget({ amount: '50' }), txs, today, UTC, identity).toFixed()).toBe('0');
  });

  it('converts non-main-currency wallets via toMain', () => {
    const today = utc(2026, 7, 8);
    const txs = [tx({ amount: '-158000', date: today, walletCurrency: 'IDR' })];
    const toMain = (a: Decimal, c: string) => (c === 'IDR' ? a.times('0.0000625') : a);
    // 158000 * 0.0000625 = 9.875, exactly.
    expect(spent(budget({ amount: '50' }), txs, today, UTC, toMain).toFixed()).toBe('9.875');
  });

  it('excludes future-dated transactions', () => {
    const today = utc(2026, 7, 8);
    const txs = [
      tx({ amount: '-10', date: today }),
      tx({ amount: '-999', date: utc(2026, 7, 13) }),
    ];
    const b = budget({ period: 'MONTHLY', amount: '500' });
    expect(spent(b, txs, today, UTC, identity).toFixed()).toBe('10');
  });
});

describe('BudgetService.evaluateCrossings parity', () => {
  const today = utc(2026, 7, 8);
  const dayStart = utc(2026, 7, 8).toISOString();

  it('returns a crossing when spend first passes 90%', () => {
    const c = evaluateCrossings([budget()], [tx({ amount: '-95', date: today })], today, UTC, identity);
    expect(c).toHaveLength(1);
    expect(c[0]!.threshold).toBe(90);
  });

  it('does not re-report a threshold already notified this period', () => {
    const b = budget({ lastNotifiedThreshold: 90, lastNotifiedPeriodStart: dayStart });
    const c = evaluateCrossings([b], [tx({ amount: '-95', date: today })], today, UTC, identity);
    expect(c).toHaveLength(0);
  });

  it('reports again when spend escalates 90% -> 100% in the same period', () => {
    const b = budget({ lastNotifiedThreshold: 90, lastNotifiedPeriodStart: dayStart });
    const c = evaluateCrossings([b], [tx({ amount: '-105', date: today })], today, UTC, identity);
    expect(c).toHaveLength(1);
    expect(c[0]!.threshold).toBe(100);
  });

  it('re-notifies once a new period starts', () => {
    const b = budget({
      lastNotifiedThreshold: 100,
      lastNotifiedPeriodStart: utc(2026, 7, 7).toISOString(),
    });
    const c = evaluateCrossings([b], [tx({ amount: '-95', date: today })], today, UTC, identity);
    expect(c).toHaveLength(1);
    expect(c[0]!.threshold).toBe(90);
  });

  it('skips budgets below 90% or with no category', () => {
    expect(
      evaluateCrossings([budget()], [tx({ amount: '-10', date: today })], today, UTC, identity),
    ).toHaveLength(0);
    expect(
      evaluateCrossings(
        [budget({ categoryId: null })],
        [tx({ amount: '-95', date: today })],
        today,
        UTC,
        identity,
      ),
    ).toHaveLength(0);
  });

  it('converts the budget currency to main before comparing', () => {
    // Limit stored as 158,000 IDR; main currency USD. At 0.0000625 that is
    // $9.875, so $9.50 of spend is 96.2% and must cross 90 — rather than
    // comparing $9.50 against a raw 158,000 and never tripping.
    const b = budget({ amount: '158000', currencyCode: 'IDR' });
    const toMain = (a: Decimal, c: string) => (c === 'IDR' ? a.times('0.0000625') : a);
    const c = evaluateCrossings([b], [tx({ amount: '-9.5', date: today })], today, UTC, toMain);
    expect(c).toHaveLength(1);
    expect(c[0]!.threshold).toBe(90);
  });

  it('skips soft-deleted budgets', () => {
    const b = budget({ deletedAt: today.toISOString() });
    expect(evaluateCrossings([b], [tx({ amount: '-95', date: today })], today, UTC, identity)).toHaveLength(0);
  });
});

describe('BudgetService.fraction parity', () => {
  it('returns 0 when the budget amount is not positive', () => {
    expect(fraction(budget({ amount: '0' }), [], utc(2026, 7, 8), UTC, identity)).toBe(0);
  });

  it('matches spent divided by amount', () => {
    const today = utc(2026, 7, 8);
    const f = fraction(budget({ amount: '50' }), [tx({ amount: '-25', date: today })], today, UTC, identity);
    expect(f).toBe(0.5);
  });
});

describe('crossedThreshold and shouldNotify', () => {
  it('is null under 90%, 90 at 90%, 100 at 100%', () => {
    expect(crossedThreshold(new Decimal(89), new Decimal(100))).toBeNull();
    expect(crossedThreshold(new Decimal(90), new Decimal(100))).toBe(90);
    expect(crossedThreshold(new Decimal(99), new Decimal(100))).toBe(90);
    expect(crossedThreshold(new Decimal(100), new Decimal(100))).toBe(100);
    expect(crossedThreshold(new Decimal(250), new Decimal(100))).toBe(100);
  });

  it('is null for a non-positive limit, never a divide by zero', () => {
    expect(crossedThreshold(new Decimal(50), new Decimal(0))).toBeNull();
    expect(crossedThreshold(new Decimal(50), new Decimal(-10))).toBeNull();
  });

  it('treats a never-notified budget as notifiable', () => {
    expect(shouldNotify(90, utc(2026, 7, 8), null, null)).toBe(true);
  });

  it('suppresses an equal or lower threshold within the same period', () => {
    const p = utc(2026, 7, 8);
    expect(shouldNotify(90, p, 90, p.toISOString())).toBe(false);
    expect(shouldNotify(100, p, 90, p.toISOString())).toBe(true);
  });
});

describe('spentByBudget matches spent, one pass vs many', () => {
  it('agrees with per-budget spent across mixed cadences', () => {
    const today = utc(2026, 7, 8);
    const s: PeriodSettings = { weekStartDay: 1, monthStartDay: 1, timeZone: 'UTC' };
    const budgets = [
      budget({ id: 'daily', period: 'DAILY', amount: '100' }),
      budget({ id: 'weekly', period: 'WEEKLY', amount: '500' }),
      budget({ id: 'monthly', period: 'MONTHLY', amount: '2000' }),
    ];
    const txs = [
      tx({ amount: '-10', date: today }),
      tx({ amount: '-20', date: utc(2026, 7, 7) }),
      tx({ amount: '-40', date: utc(2026, 7, 2) }),
      tx({ amount: '-80', date: utc(2026, 6, 20) }),
      tx({ amount: '-999', date: utc(2026, 7, 20) }), // future
    ];

    const batch = spentByBudget(budgets, txs, today, s, identity);
    for (const b of budgets) {
      const one = spent(b, txs, today, s, identity);
      expect((batch.get(b.id) ?? new Decimal(0)).toFixed()).toBe(one.toFixed());
    }
    // daily = today only; weekly (Sun start, 2026-07-05) = 10 + 20; monthly = 10+20+40
    expect(batch.get('daily')!.toFixed()).toBe('10');
    expect(batch.get('weekly')!.toFixed()).toBe('30');
    expect(batch.get('monthly')!.toFixed()).toBe('70');
  });
});

describe('ForexRateResolver parity', () => {
  it('returns 1 for an identical pair', () => {
    expect(resolveRate('USD', 'USD', {})!.toFixed()).toBe('1');
  });

  it('prefers the direct pair', () => {
    expect(resolveRate('IDR', 'USD', { IDR_USD: '0.0000625' })!.toFixed()).toBe('0.0000625');
  });

  it('falls back to the inverse', () => {
    expect(resolveRate('USD', 'IDR', { IDR_USD: '0.0000625' })!.toFixed()).toBe('16000');
  });

  it('crosses via USD when no direct or inverse pair exists', () => {
    // IDR->SGD = (IDR->USD) * (USD->SGD) = 0.0000625 * 1.35
    const r = resolveRate('IDR', 'SGD', { IDR_USD: '0.0000625', USD_SGD: '1.35' });
    expect(r!.toFixed()).toBe('0.000084375');
  });

  it('returns null rather than 1:1 when no path exists', () => {
    // The critical one. Substituting 1.0 here would report an Indonesian
    // user's net worth as roughly 16,000x its real value.
    expect(resolveRate('IDR', 'SGD', {})).toBeNull();
    expect(resolveRate('IDR', 'USD', {})).toBeNull();
  });

  it('ignores non-positive cached rates', () => {
    expect(resolveRate('IDR', 'USD', { IDR_USD: '0' })).toBeNull();
  });

  it('makeToMain yields zero for an unresolvable currency, not the raw amount', () => {
    const toMain = makeToMain('USD', {});
    expect(toMain(new Decimal('158000'), 'IDR').toFixed()).toBe('0');
    expect(toMain(new Decimal('12.5'), 'USD').toFixed()).toBe('12.5');
  });
});

describe('custom period math', () => {
  it('startDay 1 reproduces exact calendar months', () => {
    expect(customPeriodStart(utc(2026, 7, 8), 1, 'UTC').toISOString()).toBe(utc(2026, 7, 1).toISOString());
  });

  it('rolls back to the previous month before the start day', () => {
    expect(customPeriodStart(utc(2026, 7, 10), 25, 'UTC').toISOString()).toBe(utc(2026, 6, 25).toISOString());
  });

  it('handles a February anchor at the 28-day cap', () => {
    expect(customPeriodStart(utc(2026, 3, 10), 28, 'UTC').toISOString()).toBe(utc(2026, 2, 28).toISOString());
  });

  it('week start walks back to the configured weekday', () => {
    // 2026-07-08 is a Wednesday. Swift convention: 1=Sun ... 7=Sat.
    expect(customWeekStart(utc(2026, 7, 8), 1, 'UTC').toISOString()).toBe(utc(2026, 7, 5).toISOString());
    expect(customWeekStart(utc(2026, 7, 8), 2, 'UTC').toISOString()).toBe(utc(2026, 7, 6).toISOString());
    expect(customWeekStart(utc(2026, 7, 8), 4, 'UTC').toISOString()).toBe(utc(2026, 7, 8).toISOString());
    expect(customWeekStart(utc(2026, 7, 8), 5, 'UTC').toISOString()).toBe(utc(2026, 7, 2).toISOString());
  });

  it('trailing periods are contiguous and the last one includes today', () => {
    const periods = trailingPeriods(3, 1, utc(2026, 7, 8), 'UTC');
    expect(periods).toHaveLength(3);
    expect(periods[0]!.start.toISOString()).toBe(utc(2026, 5, 1).toISOString());
    expect(periods[1]!.start.toISOString()).toBe(utc(2026, 6, 1).toISOString());
    expect(periods[2]!.start.toISOString()).toBe(utc(2026, 7, 1).toISOString());
    // Earlier intervals abut the next start exactly.
    expect(periods[0]!.end.toISOString()).toBe(periods[1]!.start.toISOString());
    // The final interval extends to tomorrow so today is not filtered out.
    expect(periods[2]!.end.toISOString()).toBe(utc(2026, 7, 9).toISOString());
  });
});

describe('timezone correctness (no Swift counterpart — server-only risk)', () => {
  it('resolves the local day, not the UTC day, for a Jakarta user', () => {
    // 2026-07-08T18:30Z is already 2026-07-09 01:30 in Jakarta (UTC+7).
    const instant = new Date('2026-07-08T18:30:00Z');
    expect(startOfDay(instant, 'Asia/Jakarta').toISOString()).toBe('2026-07-08T17:00:00.000Z');
    expect(startOfDay(instant, 'UTC').toISOString()).toBe('2026-07-08T00:00:00.000Z');
  });

  it('a month boundary lands on local midnight, not UTC midnight', () => {
    const instant = new Date('2026-07-08T18:30:00Z');
    // 1 July 00:00 Jakarta == 30 June 17:00Z.
    expect(customPeriodStart(instant, 1, 'Asia/Jakarta').toISOString()).toBe('2026-06-30T17:00:00.000Z');
  });

  it('survives a spring-forward DST transition', () => {
    // US DST began 2026-03-08. A period starting 2026-03-01 must still be
    // local midnight on both sides of the shift, not 23:00 or 01:00.
    const before = customPeriodStart(new Date('2026-03-05T12:00:00Z'), 1, 'America/New_York');
    const after = customPeriodStart(new Date('2026-03-20T12:00:00Z'), 1, 'America/New_York');
    expect(before.toISOString()).toBe('2026-03-01T05:00:00.000Z'); // EST, UTC-5
    expect(after.toISOString()).toBe('2026-03-01T05:00:00.000Z'); // same period
  });

  it('survives a fall-back DST transition', () => {
    // US DST ended 2026-11-01. A week starting Sunday 2026-11-01 is the
    // ambiguous day itself; local midnight is still unambiguous (EDT, UTC-4).
    const start = customWeekStart(new Date('2026-11-04T12:00:00Z'), 1, 'America/New_York');
    expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });
});
