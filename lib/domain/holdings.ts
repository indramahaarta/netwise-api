import { Decimal, ZERO, dec, decOrNull } from './decimal.js';

/**
 * Port of NetWise/Services/HoldingsService.swift — weighted average cost
 * holdings from a portfolio's transaction ledger.
 *
 * Behaviour is pinned by NetWiseTests/PortfolioFeatureTests.swift; the parity
 * suite in test/parity/holdings.test.ts replays every one of those cases.
 *
 * Fidelity notes — each of these is a place where an "obvious improvement"
 * would change a live user's numbers:
 *
 *   * Only BUY, SELL and IMPORT_HOLDING affect holdings. DIVIDEND and FEE move
 *     cash, never position (see cash_effect in the schema).
 *   * IMPORT_HOLDING is treated exactly like a BUY for cost basis. It records a
 *     position the user already held, so it contributes qty and cost but no cash
 *     movement.
 *   * A BUY missing qty or price is SKIPPED ENTIRELY, leaving the symbol's
 *     running totals untouched — it does not contribute a zero.
 *   * Fees inflate cost basis: buyCost += qty * price + fee. So avgCost is
 *     above the execution price, and unrealized is correspondingly lower.
 *   * totalInvested = currentQty * avgCost, computed from the ALREADY-ROUNDED
 *     avgCost. Do not "simplify" this to buyCost * currentQty / buyQty: for a
 *     fractional-share buy those differ, and the Swift value is the one users
 *     have been looking at.
 *   * Sells reduce quantity only. avgCost is unchanged by a sell (WAC, not FIFO).
 *   * A holding whose net quantity is zero or negative disappears from results.
 */

export type PortfolioMarket =
  | { kind: 'stock'; currencyCode: string }
  | { kind: 'crypto' };

/** Only the fields holdings math reads. Decimals arrive as strings from Postgres. */
export interface HoldingsInputTx {
  type: string;
  symbol: string | null;
  qty: string | null;
  price: string | null;
  fee: string | null;
  deletedAt: string | null;
}

export interface HoldingRow {
  symbol: string;
  qty: Decimal;
  avgCost: Decimal;
  totalInvested: Decimal;
  currentPrice: Decimal | null;
  currency: string;
}

/** (p - avgCost) * qty, or null when the symbol has no resolved price. */
export function unrealized(h: HoldingRow): Decimal | null {
  if (h.currentPrice === null) return null;
  return h.currentPrice.minus(h.avgCost).times(h.qty);
}

/**
 * ((p - avgCost) / avgCost) * 100.
 * Null unless a price exists AND avgCost > 0 AND qty > 0 — the Swift guard is
 * `avgCost > 0, qty > 0`, which also avoids a divide by zero.
 */
export function returnPct(h: HoldingRow): Decimal | null {
  if (h.currentPrice === null) return null;
  if (!h.avgCost.gt(0) || !h.qty.gt(0)) return null;
  return h.currentPrice.minus(h.avgCost).div(h.avgCost).times(100);
}

/** True iff every holding has a resolved price — i.e. nothing is cost-basis blended. */
export function allPricesAvailable(holdings: HoldingRow[]): boolean {
  return holdings.every((h) => h.currentPrice !== null);
}

/**
 * Live equity, holding by holding: a priced holding contributes market value, an
 * unpriced one contributes its cost basis. One never-priced symbol must not
 * discard every other holding's real live value.
 */
export function resolvedEquity(holdings: HoldingRow[]): Decimal {
  return holdings.reduce(
    (sum, h) => sum.plus(h.currentPrice ? h.qty.times(h.currentPrice) : h.totalInvested),
    ZERO,
  );
}

interface Accum {
  buyQty: Decimal;
  buyCost: Decimal;
  sellQty: Decimal;
}

export function computeHoldings(
  transactions: HoldingsInputTx[],
  priceCache: Record<string, string | number> = {},
  market: PortfolioMarket = { kind: 'stock', currencyCode: 'USD' },
  portfolioCurrency = 'USD',
): HoldingRow[] {
  const active = transactions.filter((t) => t.deletedAt === null);
  const map = new Map<string, Accum>();

  for (const tx of active) {
    const sym = tx.symbol;
    if (!sym) continue;
    if (tx.type !== 'BUY' && tx.type !== 'SELL' && tx.type !== 'IMPORT_HOLDING') continue;

    const e: Accum = map.get(sym) ?? { buyQty: ZERO, buyCost: ZERO, sellQty: ZERO };

    if (tx.type === 'BUY' || tx.type === 'IMPORT_HOLDING') {
      const qty = decOrNull(tx.qty);
      const price = decOrNull(tx.price);
      // Skip entirely rather than contributing a zero — matches the Swift guard.
      if (qty === null || price === null) continue;
      e.buyQty = e.buyQty.plus(qty);
      e.buyCost = e.buyCost.plus(qty.times(price)).plus(dec(tx.fee));
    } else {
      const sellQty = decOrNull(tx.qty);
      if (sellQty === null) continue;
      e.sellQty = e.sellQty.plus(sellQty);
    }

    map.set(sym, e);
  }

  const rows: HoldingRow[] = [];

  for (const [symbol, e] of map) {
    const currentQty = e.buyQty.minus(e.sellQty);
    if (!currentQty.gt(0)) continue;

    const avgCost = e.buyQty.gt(0) ? e.buyCost.div(e.buyQty) : ZERO;
    // Deliberately multiplies the rounded avgCost — see the note above.
    const totalInvested = currentQty.times(avgCost);

    let currency: string;
    if (market.kind === 'stock') {
      currency = market.currencyCode;
    } else {
      // Crypto pairs are 'BASE-QUOTE'; the quote currency is what the holding is
      // denominated in. Fall back to the portfolio's currency if unsuffixed.
      const parts = symbol.split('-');
      currency = parts.length >= 2 ? (parts.at(-1) as string) : portfolioCurrency;
    }

    rows.push({
      symbol,
      qty: currentQty,
      avgCost,
      totalInvested,
      currentPrice: decOrNull(priceCache[symbol] ?? null),
      currency,
    });
  }

  // Swift sorts by `$0.symbol < $1.symbol`. Tickers are ASCII, where Swift's
  // Unicode ordering and JS's UTF-16 code-unit ordering agree.
  return rows.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}
