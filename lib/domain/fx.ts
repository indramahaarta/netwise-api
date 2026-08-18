import { Decimal, decOrNull } from './decimal.js';

/**
 * Port of NetWise/Services/ForexRateResolver.swift.
 *
 * Resolves a rate from cached pairs keyed "FROM_TO" (the ForexRateCache.pair
 * format, e.g. "IDR_USD"). Direct pair, then inverse, then cross via USD.
 *
 * Returns null when no path exists. The Swift doc comment is emphatic about
 * this and it is worth repeating: callers must NEVER substitute 1:1 on a miss.
 * A missing IDR->USD rate silently treated as 1.0 would report an Indonesian
 * user's net worth as roughly 16,000x its real value.
 */
export function resolveRate(
  from: string,
  to: string,
  pairs: Record<string, string | number>,
): Decimal | null {
  if (from === to) return new Decimal(1);

  const direct = decOrNull(pairs[`${from}_${to}`] ?? null);
  if (direct !== null && direct.gt(0)) return direct;

  const inverse = decOrNull(pairs[`${to}_${from}`] ?? null);
  if (inverse !== null && inverse.gt(0)) return new Decimal(1).div(inverse);

  // Cross only through USD, and only when neither side is already USD —
  // otherwise this recurses forever on a missing pair.
  if (from === 'USD' || to === 'USD') return null;

  const toUSD = resolveRate(from, 'USD', pairs);
  const fromUSD = resolveRate('USD', to, pairs);
  if (toUSD === null || fromUSD === null) return null;

  return toUSD.times(fromUSD);
}

/**
 * Builds the `toMain` conversion used throughout the budget and dashboard
 * math. Mirrors CurrencyContext.toMain(amount:currency:) on iOS.
 *
 * An unresolvable rate yields zero rather than the unconverted amount: showing
 * 158,000 (IDR) in a USD total is a worse lie than showing nothing, because it
 * looks plausible.
 */
export function makeToMain(
  mainCurrency: string,
  pairs: Record<string, string | number>,
): (amount: Decimal, currency: string) => Decimal {
  const cache = new Map<string, Decimal | null>();
  return (amount, currency) => {
    if (currency === mainCurrency) return amount;
    let rate = cache.get(currency);
    if (rate === undefined) {
      rate = resolveRate(currency, mainCurrency, pairs);
      cache.set(currency, rate);
    }
    return rate === null ? new Decimal(0) : amount.times(rate);
  };
}
