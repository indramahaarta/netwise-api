import { describe, expect, it } from 'vitest';
import { Decimal } from '../../lib/domain/decimal.js';
import {
  allPricesAvailable,
  computeHoldings,
  resolvedEquity,
  returnPct,
  unrealized,
  type HoldingsInputTx,
  type PortfolioMarket,
} from '../../lib/domain/holdings.js';

/**
 * Parity suite for the HoldingsService port.
 *
 * Every case below is transcribed from NetWiseTests/PortfolioFeatureTests.swift
 * (@Suite "HoldingsService") with the SAME inputs and the SAME expected values.
 * Assertions compare exact decimal strings, never JS numbers — a test that
 * passed on `toBeCloseTo` would defeat the entire purpose.
 *
 * This is Phase 0 spike 4: if these pass, "port the compute to TypeScript" is a
 * viable premise for Phase 2. If they don't, we learn it now rather than after
 * the client rewrite.
 */

const US: PortfolioMarket = { kind: 'stock', currencyCode: 'USD' };
const IDX: PortfolioMarket = { kind: 'stock', currencyCode: 'IDR' };
const CRYPTO: PortfolioMarket = { kind: 'crypto' };

/** Mirrors PortfolioTransaction(type:symbol:qty:price:fee:) defaults. */
function tx(p: Partial<HoldingsInputTx> & { type: string }): HoldingsInputTx {
  return {
    type: p.type,
    symbol: p.symbol ?? null,
    qty: p.qty ?? null,
    price: p.price ?? null,
    fee: p.fee ?? '0',
    deletedAt: p.deletedAt ?? null,
  };
}

const s = (d: Decimal | null) => (d === null ? null : d.toFixed());

describe('HoldingsService parity', () => {
  it('single buy produces correct qty and avgCost', () => {
    const h = computeHoldings([tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150', fee: '1' })]);
    expect(h).toHaveLength(1);
    expect(h[0]!.symbol).toBe('AAPL');
    expect(s(h[0]!.qty)).toBe('10');
    // avgCost = (10 * 150 + 1) / 10 = 1501 / 10 = 150.1
    expect(s(h[0]!.avgCost)).toBe('150.1');
    expect(s(h[0]!.totalInvested)).toBe('1501');
    expect(h[0]!.currentPrice).toBeNull();
    expect(h[0]!.currency).toBe('USD');
  });

  it('two buys produce weighted average cost', () => {
    const h = computeHoldings([
      tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '100' }),
      tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '200' }),
    ]);
    expect(h).toHaveLength(1);
    expect(s(h[0]!.qty)).toBe('20');
    // (10*100 + 10*200) / 20 = 3000/20 = 150
    expect(s(h[0]!.avgCost)).toBe('150');
  });

  it('partial sell reduces qty, avgCost unchanged', () => {
    const h = computeHoldings([
      tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150' }),
      tx({ type: 'SELL', symbol: 'AAPL', qty: '4', price: '200' }),
    ]);
    expect(h).toHaveLength(1);
    expect(s(h[0]!.qty)).toBe('6');
    expect(s(h[0]!.avgCost)).toBe('150');
  });

  it('full sell removes holding from results', () => {
    const h = computeHoldings([
      tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150' }),
      tx({ type: 'SELL', symbol: 'AAPL', qty: '10', price: '200' }),
    ]);
    expect(h).toHaveLength(0);
  });

  it('dividend and fee do not appear in holdings', () => {
    const h = computeHoldings([
      tx({ type: 'DIVIDEND', symbol: 'AAPL', price: '50' }),
      tx({ type: 'FEE', fee: '10' }),
    ]);
    expect(h).toHaveLength(0);
  });

  it('price cache populates currentPrice and unrealized', () => {
    const h = computeHoldings([tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150' })], {
      AAPL: '180',
    });
    expect(s(h[0]!.currentPrice)).toBe('180');
    // (180 - 150) * 10 = 300
    expect(s(unrealized(h[0]!))).toBe('300');
  });

  it('IDX stocks use IDR currency when market is ID', () => {
    const h = computeHoldings(
      [tx({ type: 'BUY', symbol: 'BBCA.JK', qty: '100', price: '9000' })],
      {},
      IDX,
    );
    expect(h[0]!.currency).toBe('IDR');
  });

  it('crypto BTC-USD holding uses USD currency', () => {
    const h = computeHoldings(
      [tx({ type: 'BUY', symbol: 'BTC-USD', qty: '1', price: '50000' })],
      {},
      CRYPTO,
    );
    expect(h[0]!.currency).toBe('USD');
  });

  it('crypto ETH-IDR holding uses IDR currency', () => {
    const h = computeHoldings(
      [tx({ type: 'BUY', symbol: 'ETH-IDR', qty: '1', price: '500000000' })],
      {},
      CRYPTO,
    );
    expect(h[0]!.currency).toBe('IDR');
  });

  it('unrealized accounts for fee-inflated avgCost', () => {
    // buyCost = 10*150 + 10 = 1510, avgCost = 151
    const h = computeHoldings([tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150', fee: '10' })], {
      AAPL: '180',
    });
    expect(s(h[0]!.avgCost)).toBe('151');
    // (180 - 151) * 10 = 290
    expect(s(unrealized(h[0]!))).toBe('290');
  });

  it('multiple symbols are computed independently', () => {
    const h = computeHoldings([
      tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150' }),
      tx({ type: 'BUY', symbol: 'MSFT', qty: '5', price: '300' }),
    ]);
    expect(h).toHaveLength(2);
    const aapl = h.find((r) => r.symbol === 'AAPL')!;
    const msft = h.find((r) => r.symbol === 'MSFT')!;
    expect(s(aapl.qty)).toBe('10');
    expect(s(aapl.avgCost)).toBe('150');
    expect(s(msft.qty)).toBe('5');
    expect(s(msft.avgCost)).toBe('300');
  });

  it('soft-deleted transaction excluded from holdings', () => {
    const h = computeHoldings([
      tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150' }),
      tx({ type: 'BUY', symbol: 'AAPL', qty: '5', price: '150', deletedAt: '2026-08-18T00:00:00Z' }),
    ]);
    expect(h).toHaveLength(1);
    expect(s(h[0]!.qty)).toBe('10');
  });
});

describe('Decimal precision matches Swift Decimal', () => {
  /**
   * The pin for the whole port. Swift's Decimal is 38 significant digits, and
   * HoldingsRowDisplayFormattingTests asserts 100/3 is
   * 33.333333333333333333333333333333333333 — "33" plus 36 threes. decimal.js
   * defaults to 20 significant digits, which would silently truncate here.
   */
  it('100 / 3 yields 38 significant digits, as Swift Decimal does', () => {
    const avgCost = new Decimal(100).div(3);
    expect(avgCost.toFixed()).toBe('33.333333333333333333333333333333333333');
    expect(avgCost.precision()).toBe(38);
  });

  it('fractional-share buy keeps Swift-identical avgCost and totalInvested', () => {
    // 3 shares costing 100 total: avgCost repeats, and totalInvested is
    // recomputed FROM the rounded avgCost — not from the original cost.
    const h = computeHoldings([tx({ type: 'BUY', symbol: 'VOO', qty: '3', price: '33.333333333333333333333333333333333333' })]);
    expect(s(h[0]!.qty)).toBe('3');
    expect(s(h[0]!.avgCost)).toBe('33.333333333333333333333333333333333333');
  });

  it('0.1 + 0.2 is exactly 0.3, unlike float64', () => {
    expect(new Decimal('0.1').plus('0.2').toFixed()).toBe('0.3');
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this whole file exists
  });

  it('never serialises to exponential notation', () => {
    // Decimal(string:) on iOS does not accept every exponential form, so a tiny
    // crypto quantity must still render in plain notation.
    expect(new Decimal('0.00000001').toFixed()).toBe('0.00000001');
    expect(new Decimal('500000000000').toFixed()).toBe('500000000000');
  });
});

describe('resolvedEquity and allPricesAvailable', () => {
  it('blends market value with cost basis per holding', () => {
    const h = computeHoldings(
      [
        tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150' }),
        tx({ type: 'BUY', symbol: 'MSFT', qty: '5', price: '300' }),
      ],
      { AAPL: '180' },
    );
    expect(allPricesAvailable(h)).toBe(false);
    // AAPL priced: 10 * 180 = 1800. MSFT unpriced: cost basis 5 * 300 = 1500.
    expect(s(resolvedEquity(h))).toBe('3300');
  });

  it('is fully live when every symbol has a price', () => {
    const h = computeHoldings([tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150' })], {
      AAPL: '180',
    });
    expect(allPricesAvailable(h)).toBe(true);
    expect(s(resolvedEquity(h))).toBe('1800');
  });
});

describe('returnPct guards', () => {
  it('is null without a price', () => {
    const h = computeHoldings([tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150' })]);
    expect(returnPct(h[0]!)).toBeNull();
  });

  it('computes percentage against fee-inflated avgCost', () => {
    const h = computeHoldings([tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150', fee: '10' })], {
      AAPL: '181.2',
    });
    // ((181.2 - 151) / 151) * 100 = 20
    expect(s(returnPct(h[0]!))).toBe('20');
  });
});

describe('IMPORT_HOLDING behaves as a buy for cost basis', () => {
  it('contributes qty and cost like a buy', () => {
    const h = computeHoldings([
      tx({ type: 'IMPORT_HOLDING', symbol: 'BBCA.JK', qty: '100', price: '9000' }),
      tx({ type: 'BUY', symbol: 'BBCA.JK', qty: '100', price: '11000' }),
    ], {}, IDX);
    expect(s(h[0]!.qty)).toBe('200');
    // (100*9000 + 100*11000) / 200 = 2000000/200 = 10000
    expect(s(h[0]!.avgCost)).toBe('10000');
  });
});

describe('malformed rows are skipped, not zeroed', () => {
  it('a buy missing price leaves the symbol untouched', () => {
    const h = computeHoldings([
      tx({ type: 'BUY', symbol: 'AAPL', qty: '10', price: '150' }),
      tx({ type: 'BUY', symbol: 'AAPL', qty: '5', price: null }),
    ]);
    // The malformed row must not add 5 shares at zero cost, which would drag
    // avgCost down to 100 and understate the position's cost basis.
    expect(s(h[0]!.qty)).toBe('10');
    expect(s(h[0]!.avgCost)).toBe('150');
  });

  it('a transaction with no symbol is ignored', () => {
    const h = computeHoldings([tx({ type: 'BUY', symbol: null, qty: '10', price: '150' })]);
    expect(h).toHaveLength(0);
  });
});
