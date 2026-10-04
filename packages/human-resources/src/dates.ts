/**
 * Calendar-date helpers. HR dates are `YYYY-MM-DD` text, so they compare
 * correctly as strings and carry no timezone; the application converts an
 * instant to its own local date before asking.
 *
 * @packageDocumentation
 */

import { HrError, type IsoDate } from './types.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Throw unless `value` is a real calendar date written `YYYY-MM-DD`. */
export function assertIsoDate(fieldName: string, value: unknown): IsoDate {
  if (!isIsoDate(value))
    throw new HrError(
      'HR_INVALID',
      `${fieldName} must be a calendar date written YYYY-MM-DD, got '${String(value)}'.`,
    );
  return value;
}

/** The calendar date `days` after `date` (negative moves back). */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [year, month, day] = assertIsoDate('date', date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * The calendar date `months` after `date`, clamped to the end of the target
 * month (31 January + 1 month is the last day of February).
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [year, month, day] = assertIsoDate('date', date).split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return first.toISOString().slice(0, 10);
}

/**
 * Whether `on` falls inside the inclusive range `[start, end]`. A null `end`
 * is open-ended.
 */
export function dateWithin(
  on: IsoDate,
  start: IsoDate,
  end: IsoDate | null,
): boolean {
  return start <= on && (end === null || on <= end);
}
