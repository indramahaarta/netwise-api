import Decimal from 'decimal.js';

/**
 * Decimal configuration chosen to match Swift's `Decimal`, which is what every
 * money value in NetWise v1.4 is computed with.
 *
 * This file is the single most important line of defence against Risk B —
 * silently changing users' numbers. Two settings matter:
 *
 *   precision: 38
 *     Swift's Decimal is a 38-significant-digit type. The app has a regression
 *     test built on exactly this: `100 / 3` produces
 *     33.333333333333333333333333333333333333 — "33" plus 36 threes, 38
 *     significant digits total (HoldingsRowDisplayFormattingTests). decimal.js
 *     defaults to 20, which would diverge on the first fractional-share buy.
 *
 *   rounding: ROUND_HALF_UP
 *     Swift's NSDecimalDivide defaults to NSRoundPlain: nearest neighbour, and
 *     when exactly halfway, away from zero. That is decimal.js's ROUND_HALF_UP.
 *     It is also decimal.js's default, but state it explicitly — a future
 *     `Decimal.set` elsewhere in the process would otherwise change results
 *     invisibly.
 *
 * Why this is not paranoia: HoldingsService divides to get avgCost and then
 * MULTIPLIES that rounded value back out for totalInvested. The rounding is
 * therefore observable in a headline figure, not swallowed internally.
 */
Decimal.set({
  precision: 38,
  rounding: Decimal.ROUND_HALF_UP,
  // Never fall back to exponential notation when serialising: these values go
  // out as JSON strings the iOS client parses with Decimal(string:), which does
  // not accept every exponential form.
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export { Decimal };

/** Money and quantities cross the wire as decimal strings, never as numbers. */
export type DecimalString = string;

export const ZERO = new Decimal(0);

/** Parse a value that may arrive as a decimal string, number, or null. */
export function dec(v: DecimalString | number | null | undefined): Decimal {
  if (v === null || v === undefined || v === '') return ZERO;
  return new Decimal(v);
}

/** Nullable parse — preserves "absent" rather than coercing it to zero. */
export function decOrNull(v: DecimalString | number | null | undefined): Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  return new Decimal(v);
}

/**
 * Serialise for the wire. `toFixed()` with no argument gives the full value in
 * normal notation, matching how Swift's "\(decimal)" interpolation renders and
 * how BackupService has always written numbers.
 */
export function ser(v: Decimal): DecimalString {
  return v.toFixed();
}

export function serOrNull(v: Decimal | null): DecimalString | null {
  return v === null ? null : v.toFixed();
}
