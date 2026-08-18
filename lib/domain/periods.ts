import { Temporal } from '@js-temporal/polyfill';

/**
 * Port of NetWise/Helpers/CustomPeriod.swift and CustomWeekPeriod.swift.
 *
 * The single biggest difference from the iOS original: Swift uses
 * `Calendar.current`, which is the *device's* timezone. On the server there is
 * no such thing — every one of these functions takes an explicit IANA timezone,
 * read from `user_settings.timezone`. Getting this wrong does not throw; it
 * silently shifts a user's month boundary by a day and quietly changes every
 * budget total and every daily snapshot. It is the highest-consequence,
 * lowest-visibility bug available in this migration.
 *
 * Temporal's `PlainDate` is used for the calendar arithmetic on purpose: a
 * "period start" is a calendar concept, and doing it in PlainDate space means
 * DST transitions cannot corrupt it. Only the final conversion back to an
 * instant is timezone-aware.
 */

/** JS Date (an instant) -> the calendar date it falls on in `timeZone`. */
function plainDateIn(date: Date, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
}

/** Calendar date -> the instant of local midnight that begins it. */
function startOfDayInstant(d: Temporal.PlainDate, timeZone: string): Date {
  return new Date(d.toZonedDateTime({ timeZone }).toInstant().epochMilliseconds);
}

/**
 * Swift's `Calendar` weekday convention: 1 = Sunday ... 7 = Saturday.
 * Temporal (ISO) uses 1 = Monday ... 7 = Sunday. `weekStartDay` in
 * user_settings is stored in the Swift convention, so convert rather than
 * reinterpret — an off-by-one here moves everyone's week by a day.
 */
function swiftWeekday(d: Temporal.PlainDate): number {
  return (d.dayOfWeek % 7) + 1;
}

/** Start of the local day containing `date`. Mirrors `calendar.startOfDay(for:)`. */
export function startOfDay(date: Date, timeZone: string): Date {
  return startOfDayInstant(plainDateIn(date, timeZone), timeZone);
}

/**
 * Start of the week containing `date`, given `weekStartDay` (1 = Sunday).
 *
 * Swift does this by setting `calendar.firstWeekday` and round-tripping through
 * `[.yearForWeekOfYear, .weekOfYear]`. The observable behaviour is simply:
 * walk back to the most recent day whose weekday equals `weekStartDay`.
 */
export function customWeekStart(date: Date, weekStartDay: number, timeZone: string): Date {
  const today = plainDateIn(date, timeZone);
  const daysBack = (swiftWeekday(today) - weekStartDay + 7) % 7;
  return startOfDayInstant(today.subtract({ days: daysBack }), timeZone);
}

/**
 * Start of the custom month-period containing `date`.
 *
 * If the day-of-month is >= `startDay` the period began on `startDay` of THIS
 * month; otherwise on `startDay` of the PREVIOUS month. `startDay` is
 * constrained to 1...28 in user_settings precisely so this can never land on a
 * day that some month lacks.
 */
export function customPeriodStart(date: Date, startDay: number, timeZone: string): Date {
  const today = plainDateIn(date, timeZone);
  const anchor = today.day >= startDay ? today : today.subtract({ months: 1 });
  // Only the anchor's year and month are used; its own day is discarded.
  const start = Temporal.PlainDate.from({ year: anchor.year, month: anchor.month, day: startDay });
  return startOfDayInstant(start, timeZone);
}

export interface PeriodInterval {
  start: Date;
  end: Date;
}

/**
 * `count` consecutive periods ending with the one containing `referenceDate`,
 * oldest first.
 *
 * The final interval's `end` is extended to the start of TOMORROW rather than
 * the nominal period end, so a half-open `date < end` filter still includes
 * today's transactions. Every earlier interval ends exactly where the next
 * begins. This mirrors the fix already carried in DashboardView.fixedWindows.
 */
export function trailingPeriods(
  count: number,
  startDay: number,
  referenceDate: Date,
  timeZone: string,
): PeriodInterval[] {
  if (count <= 0) return [];

  const firstStart = plainDateIn(customPeriodStart(referenceDate, startDay, timeZone), timeZone);

  const starts: Temporal.PlainDate[] = [firstStart];
  while (starts.length < count) {
    starts.unshift(starts[0]!.subtract({ months: 1 }));
  }

  const tomorrow = plainDateIn(referenceDate, timeZone).add({ days: 1 });

  return starts.map((periodStart, index) => {
    const nominalEnd = periodStart.add({ months: 1 });
    const end = index === starts.length - 1 ? tomorrow : nominalEnd;
    return {
      start: startOfDayInstant(periodStart, timeZone),
      end: startOfDayInstant(end, timeZone),
    };
  });
}
