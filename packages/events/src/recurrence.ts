/**
 * Time-zone-aware recurrence expansion for {@link RecurrencePattern}.
 *
 * Implements the RFC 5545 RRULE subset that EventSeries patterns use:
 * `FREQ` daily / weekly / monthly / yearly, `INTERVAL`, `BYDAY` (weekly day
 * lists and monthly ordinals such as `2TU` / `-1FR`), `BYMONTHDAY` (negative
 * values count from the month end), `BYMONTH` (yearly), `BYSETPOS`
 * (monthly), `UNTIL`, and `COUNT`.
 *
 * Occurrences keep the wall-clock time of the first occurrence in the given
 * IANA time zone, so a 19:00 weekly meeting stays at 19:00 local across a
 * daylight-saving change. All arithmetic runs on calendar dates; instants are
 * produced only at the end through `Intl`, so the host time zone never leaks
 * into the result.
 */

import type { RecurrencePattern } from './types';

/** Options for {@link expandRecurrence}. */
export interface ExpandRecurrenceOptions {
  /** First occurrence (RRULE `DTSTART`); its local time is reused for every occurrence. */
  start: Date;
  /** Inclusive lower bound of the window to return occurrences for. */
  rangeStart: Date;
  /** Inclusive upper bound of the window to return occurrences for. */
  rangeEnd: Date;
  /** IANA time zone the pattern repeats in. Defaults to `pattern.timeZone`, then `UTC`. */
  timeZone?: string;
  /** Safety cap on returned occurrences. Defaults to 1000. */
  limit?: number;
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const DAY_MS = 86_400_000;
/** Hard ceiling on generated periods so a pattern that never matches still terminates. */
const MAX_PERIODS = 50_000;

/** A calendar date with no time zone. */
export interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/** A local date and time with no time zone. */
export interface ZonedWallTime extends CivilDate {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    // Throws RangeError for an unknown zone — callers get a real error.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Check whether a string is an IANA time zone this runtime recognizes.
 *
 * @param timeZone - Candidate zone name (e.g. `America/Edmonton`)
 * @returns True when `Intl` accepts the zone
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wall-clock fields of an instant in a time zone.
 *
 * @param instant - Instant to project
 * @param timeZone - IANA time zone
 * @returns Local year/month/day/hour/minute/second/millisecond
 */
export function toZonedWallTime(
  instant: Date,
  timeZone: string,
): ZonedWallTime {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
    millisecond: ((instant.getTime() % 1000) + 1000) % 1000,
  };
}

function offsetAt(epochMs: number, timeZone: string): number {
  const wall = toZonedWallTime(new Date(epochMs), timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  );
  return asUtc - epochMs;
}

/**
 * Instant for a wall-clock time in a time zone.
 *
 * - A time skipped by a daylight-saving jump (spring forward) resolves
 *   FORWARD by the size of the gap: 02:30 on a 02:00 -> 03:00 day is 03:30.
 * - A time that occurs twice (fall back) resolves to its FIRST occurrence.
 *
 * These are the RFC 5545 / Temporal `compatible` rules, independent of the
 * zone's sign or the host time zone.
 *
 * @param wall - Local date and time
 * @param timeZone - IANA time zone
 * @returns The matching instant
 */
export function fromZonedWallTime(wall: ZonedWallTime, timeZone: string): Date {
  const guess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  );
  // Zone offsets in force a day either side bracket any single transition
  // near this wall time; together with the offsets at the naive guess they
  // are every offset the wall time can resolve under.
  const before = offsetAt(guess - DAY_MS, timeZone);
  const offsets = new Set([
    before,
    offsetAt(guess, timeZone),
    offsetAt(guess + DAY_MS, timeZone),
  ]);
  const matches = [...offsets]
    .map((offset) => guess - offset)
    .filter((epoch) => offsetAt(epoch, timeZone) === guess - epoch)
    .sort((a, b) => a - b);
  if (matches.length > 0) return new Date(matches[0]);
  // No offset reproduces the wall time: it falls in a gap. Read it with the
  // offset in force before the jump, which lands after the jump by exactly
  // the gap's size.
  return new Date(guess - before);
}

function civilToDayNumber(date: CivilDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
}

function dayNumberToCivil(dayNumber: number): CivilDate {
  const date = new Date(dayNumber * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function weekdayOf(dayNumber: number): number {
  // Day 0 (1970-01-01) was a Thursday.
  return (((dayNumber + 4) % 7) + 7) % 7;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface ParsedByDay {
  weekday: number;
  ordinal: number | null;
}

function parseByDay(values: string[] | undefined): ParsedByDay[] {
  if (!values) return [];
  const parsed: ParsedByDay[] = [];
  for (const raw of values) {
    const match = /^([+-]?\d{1,2})?([A-Za-z]{2})$/.exec(raw.trim());
    if (!match) {
      throw new RangeError(`Invalid recurrence byDay value: ${raw}`);
    }
    const weekday = WEEKDAY_CODES.indexOf(
      match[2].toUpperCase() as (typeof WEEKDAY_CODES)[number],
    );
    if (weekday < 0) {
      throw new RangeError(`Invalid recurrence byDay value: ${raw}`);
    }
    parsed.push({
      weekday,
      ordinal: match[1] ? Number(match[1]) : null,
    });
  }
  return parsed;
}

function toDate(value: Date | string | undefined): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid recurrence until date: ${String(value)}`);
  }
  return date;
}

function monthDays(
  year: number,
  month: number,
  pattern: RecurrencePattern,
  byDay: ParsedByDay[],
  startDay: number,
): number[] {
  const length = daysInMonth(year, month);
  const firstDayNumber = civilToDayNumber({ year, month, day: 1 });
  let days: number[];

  if (pattern.byMonthDay?.length) {
    days = pattern.byMonthDay
      .map((value) => (value < 0 ? length + 1 + value : value))
      .filter((value) => value >= 1 && value <= length);
  } else if (byDay.length) {
    days = [];
    for (const { weekday, ordinal } of byDay) {
      const matches: number[] = [];
      for (let day = 1; day <= length; day++) {
        if (weekdayOf(firstDayNumber + day - 1) === weekday) matches.push(day);
      }
      if (ordinal === null) {
        days.push(...matches);
      } else {
        const index = ordinal > 0 ? ordinal - 1 : matches.length + ordinal;
        if (index >= 0 && index < matches.length) days.push(matches[index]);
      }
    }
  } else {
    // RFC 5545: a month without the start's day (e.g. the 31st) is skipped.
    days = startDay <= length ? [startDay] : [];
  }

  days = [...new Set(days)].sort((a, b) => a - b);

  if (pattern.bySetPos?.length) {
    const picked = pattern.bySetPos
      .map((pos) => (pos > 0 ? days[pos - 1] : days[days.length + pos]))
      .filter((day): day is number => day !== undefined);
    days = [...new Set(picked)].sort((a, b) => a - b);
  }

  return days;
}

/**
 * Candidate local dates (as day numbers) for one period of the pattern.
 */
function periodDates(
  pattern: RecurrencePattern,
  period: number,
  first: CivilDate,
  firstDayNumber: number,
  byDay: ParsedByDay[],
): number[] {
  const interval = Math.max(1, Math.floor(pattern.interval ?? 1));

  switch (pattern.frequency) {
    case 'daily':
      return [firstDayNumber + period * interval];
    case 'weekly': {
      // Weeks start on Monday (RRULE WKST default).
      const weekStart =
        firstDayNumber -
        ((weekdayOf(firstDayNumber) + 6) % 7) +
        period * interval * 7;
      const weekdays = byDay.length
        ? [...new Set(byDay.map((entry) => entry.weekday))]
        : [weekdayOf(firstDayNumber)];
      return weekdays
        .map((weekday) => weekStart + ((weekday + 6) % 7))
        .sort((a, b) => a - b);
    }
    case 'monthly': {
      const monthIndex = first.month - 1 + period * interval;
      const year = first.year + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      const base = civilToDayNumber({ year, month, day: 1 }) - 1;
      return monthDays(year, month, pattern, byDay, first.day).map(
        (day) => base + day,
      );
    }
    case 'yearly': {
      const year = first.year + period * interval;
      const months = pattern.byMonth?.length
        ? [...new Set(pattern.byMonth)].sort((a, b) => a - b)
        : [first.month];
      const dates: number[] = [];
      for (const month of months) {
        if (month < 1 || month > 12) continue;
        if (pattern.byMonthDay?.length || byDay.length) {
          const base = civilToDayNumber({ year, month, day: 1 }) - 1;
          dates.push(
            ...monthDays(year, month, pattern, byDay, first.day).map(
              (day) => base + day,
            ),
          );
        } else if (first.day <= daysInMonth(year, month)) {
          dates.push(civilToDayNumber({ year, month, day: first.day }));
        }
      }
      return dates.sort((a, b) => a - b);
    }
    default:
      throw new RangeError(
        `Unsupported recurrence frequency: ${String(pattern.frequency)}`,
      );
  }
}

/**
 * Expand a recurrence pattern into occurrence start instants inside a window.
 *
 * `count` counts from the first occurrence (`start`), including occurrences
 * that fall before `rangeStart`; `until` is inclusive. Occurrences before
 * `start` are never produced, and a `start` that does not itself match the
 * pattern is not an occurrence (as in rrule.js, unlike a bare RFC 5545
 * `DTSTART`). Invalid zones or `byDay` codes throw
 * `RangeError`.
 *
 * @param pattern - Recurrence pattern (object or stored JSON string)
 * @param options - First occurrence, window, and time zone
 * @returns Occurrence start instants in ascending order
 *
 * @example
 * ```ts
 * // Every second Tuesday at 19:00 Edmonton time, for October 2026
 * expandRecurrence(
 *   { frequency: 'monthly', byDay: ['2TU'] },
 *   {
 *     start: new Date('2026-01-14T02:00:00Z'),
 *     rangeStart: new Date('2026-10-01T00:00:00Z'),
 *     rangeEnd: new Date('2026-10-31T23:59:59Z'),
 *     timeZone: 'America/Edmonton',
 *   },
 * );
 * ```
 */
export function expandRecurrence(
  pattern: RecurrencePattern | string | null | undefined,
  options: ExpandRecurrenceOptions,
): Date[] {
  const parsed: RecurrencePattern | null =
    typeof pattern === 'string'
      ? pattern
        ? (JSON.parse(pattern) as RecurrencePattern)
        : null
      : (pattern ?? null);
  if (!parsed) return [];

  const timeZone = options.timeZone || parsed.timeZone || 'UTC';
  const limit = options.limit ?? 1000;
  const startMs = options.start.getTime();
  const rangeStartMs = options.rangeStart.getTime();
  const rangeEndMs = options.rangeEnd.getTime();
  if (Number.isNaN(startMs) || Number.isNaN(rangeStartMs)) {
    throw new RangeError('expandRecurrence needs valid start and range dates');
  }
  if (rangeEndMs < rangeStartMs) return [];

  const until = toDate(parsed.until as Date | string | undefined);
  const untilMs = until ? until.getTime() : Number.POSITIVE_INFINITY;
  const count = parsed.count ?? Number.POSITIVE_INFINITY;
  const byDay = parseByDay(parsed.byDay);

  const wall = toZonedWallTime(options.start, timeZone);
  const first: CivilDate = {
    year: wall.year,
    month: wall.month,
    day: wall.day,
  };
  const firstDayNumber = civilToDayNumber(first);

  const results: Date[] = [];
  let produced = 0;

  for (let period = 0; period < MAX_PERIODS; period++) {
    const dates = periodDates(parsed, period, first, firstDayNumber, byDay);
    for (const dayNumber of dates) {
      if (dayNumber < firstDayNumber) continue;
      const civil = dayNumberToCivil(dayNumber);
      const occurrence = fromZonedWallTime(
        {
          ...civil,
          hour: wall.hour,
          minute: wall.minute,
          second: wall.second,
          millisecond: wall.millisecond,
        },
        timeZone,
      );
      const occurrenceMs = occurrence.getTime();
      if (occurrenceMs < startMs) continue;
      if (occurrenceMs > untilMs || produced >= count) return results;
      if (occurrenceMs > rangeEndMs) return results;
      produced++;
      if (occurrenceMs >= rangeStartMs) {
        results.push(occurrence);
        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}
