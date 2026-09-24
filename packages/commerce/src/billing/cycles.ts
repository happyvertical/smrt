/**
 * Billing-cycle schedule and proration math (#3116).
 *
 * A payer's billing periods are a pure function of its account's
 * `billingAnchorAt`:
 *
 * - no anchor: UTC calendar months (the default, and the only schedule before
 *   #3116);
 * - an anchor `A`: monthly periods `[A + k months, A + (k + 1) months)` at
 *   `A`'s UTC time of day. A day past the end of a shorter month is clamped to
 *   its last day, always computed from `A` itself, so an anchor on the 31st
 *   runs Jan 31 → Feb 28 (29) → Mar 31 without drifting. Before `A` the
 *   schedule stays calendar months, and the month `A` falls in ends early at
 *   `A` (a *stub* period), so an account that moves from calendar months to an
 *   anchor has no gap and no overlap.
 *
 * Every period carries the full cycle it belongs to (`cycleStart`/`cycleEnd`);
 * that cycle's length is the proration denominator, so a stub is billed as the
 * fraction of its calendar month it covers.
 */
import type { BillingPeriod } from './period-close.js';

/** A period of a payer's schedule and the full cycle it prorates against. */
export interface ScheduledBillingPeriod extends BillingPeriod {
  /** Start of the full monthly cycle (equals `periodStart` except for a stub). */
  cycleStart: Date;
  /** End of the full monthly cycle (equals `periodEnd` except for a stub). */
  cycleEnd: Date;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * `anchor` plus `months` calendar months at the anchor's UTC time of day,
 * with the day clamped to the target month's last day.
 */
export function addBillingMonths(anchor: Date, months: number): Date {
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(anchor.getUTCDate(), daysInMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function calendarMonthContaining(at: Date): ScheduledBillingPeriod {
  const periodStart = monthStart(at);
  const periodEnd = new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1),
  );
  return {
    periodStart,
    periodEnd,
    cycleStart: periodStart,
    cycleEnd: periodEnd,
  };
}

function assertValidDate(date: Date, name: string): void {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error(`${name} must be a valid date.`);
  }
}

/**
 * The period of a schedule (calendar months when `anchor` is null) that
 * contains `at`.
 */
export function billingPeriodContaining(
  anchor: Date | null | undefined,
  at: Date,
): ScheduledBillingPeriod {
  assertValidDate(at, 'at');
  if (!anchor) return calendarMonthContaining(at);
  assertValidDate(anchor, 'billingAnchorAt');
  const time = at.getTime();
  if (time < anchor.getTime()) {
    const anchorMonth = monthStart(anchor);
    if (time >= anchorMonth.getTime()) {
      // The stub between the anchor's month start and the anchor itself.
      const cycle = calendarMonthContaining(anchorMonth);
      return {
        periodStart: anchorMonth,
        periodEnd: anchor,
        cycleStart: cycle.cycleStart,
        cycleEnd: cycle.cycleEnd,
      };
    }
    return calendarMonthContaining(at);
  }
  let k =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (at.getUTCMonth() - anchor.getUTCMonth());
  while (k > 0 && addBillingMonths(anchor, k).getTime() > time) k -= 1;
  while (addBillingMonths(anchor, k + 1).getTime() <= time) k += 1;
  const periodStart = addBillingMonths(anchor, k);
  const periodEnd = addBillingMonths(anchor, k + 1);
  return {
    periodStart,
    periodEnd,
    cycleStart: periodStart,
    cycleEnd: periodEnd,
  };
}

/**
 * The most recent period of a schedule that has ended by `now` — what a
 * period close with no explicit period bills. With no anchor this is the
 * previous calendar month.
 */
export function lastEndedBillingPeriod(
  anchor: Date | null | undefined,
  now: Date = new Date(),
): ScheduledBillingPeriod {
  const current = billingPeriodContaining(anchor, now);
  return billingPeriodContaining(
    anchor,
    new Date(current.periodStart.getTime() - 1),
  );
}

/**
 * `amount × coveredMs / cycleMs` in integer minor units, rounded half up
 * (exact integer arithmetic, no floating point). Coverage of the whole cycle
 * or more returns `amount` unchanged; no coverage returns 0.
 */
export function prorateMinorUnits(
  amount: number,
  coveredMs: number,
  cycleMs: number,
): number {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('A prorated amount must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(cycleMs) || cycleMs <= 0) {
    throw new Error('A billing cycle must have a positive length.');
  }
  if (!Number.isSafeInteger(coveredMs) || coveredMs <= 0) return 0;
  if (coveredMs >= cycleMs) return amount;
  const numerator = BigInt(amount) * BigInt(coveredMs) * 2n + BigInt(cycleMs);
  return Number(numerator / (BigInt(cycleMs) * 2n));
}
