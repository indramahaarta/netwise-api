/**
 * Provider-agnostic market data interface.
 *
 * Every price and rate crosses this boundary as a DECIMAL STRING, never a
 * JS number. The Swift side already serialises every `Decimal` as a string
 * (see BackupService v5); a single float division here produces a wrong
 * balance in a live user's ledger.
 *
 * Phase 0 Risk A: Yahoo's unofficial endpoints throttle by IP pattern and
 * have had no official API since 2017. Today each user's phone fetches from
 * its own residential IP; server-side that collapses onto a handful of
 * Vercel egress IPs. This interface exists so swapping Yahoo for a paid
 * provider (Twelve Data / Finnhub / EOD Historical) is a config change,
 * not a rewrite.
 */

/** ISO-8601 calendar date, `YYYY-MM-DD`, in the exchange's local timezone. */
export type IsoDate = string;

/** A decimal number carried as a string to preserve precision. */
export type DecimalString = string;

export interface Quote {
  readonly symbol: string;
  readonly price: DecimalString;
  readonly currency: string;
  /** When the provider says this price was observed. */
  readonly asOf: Date;
}

export interface HistoricalClose {
  readonly date: IsoDate;
  readonly close: DecimalString;
}

export interface SymbolSearchResult {
  readonly symbol: string;
  readonly name: string;
  readonly exchange: string;
  readonly currency: string | null;
  /** NetWise market code: US, ID, SG, MY, TH, KR, JP, CRYPTO. */
  readonly market: string | null;
}

export interface FxRate {
  readonly from: string;
  readonly to: string;
  readonly rate: DecimalString;
  readonly asOf: Date;
}

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly kind: 'rate_limited' | 'blocked' | 'not_found' | 'upstream' | 'decode',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MarketDataError';
  }
}

export interface MarketDataProvider {
  readonly name: string;

  /** Latest price for one symbol. Throws MarketDataError. */
  quote(symbol: string): Promise<Quote>;

  /** Latest prices for many symbols. Missing symbols are simply absent. */
  quotes(symbols: readonly string[]): Promise<Map<string, Quote>>;

  /**
   * Daily closes over an inclusive date range, in the exchange's local
   * timezone. Gaps (weekends, holidays) are NOT filled here — that is
   * `carryForward`'s job, ported from PriceService.carryForward.
   */
  history(symbol: string, from: IsoDate, to: IsoDate): Promise<HistoricalClose[]>;

  search(query: string, market?: string): Promise<SymbolSearchResult[]>;
}

export interface FxProvider {
  readonly name: string;
  rate(from: string, to: string): Promise<FxRate>;
  rateOn(from: string, to: string, date: IsoDate): Promise<FxRate>;
}
