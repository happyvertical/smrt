/**
 * Coverage-calendar math for Service Target clocks (FR-30/FR-31): pure,
 * deterministic business-time arithmetic over a Managed Support Plan's
 * coverage windows, holidays, and IANA timezone.
 *
 * Semantics:
 * - An empty `windows` array means 24×7 coverage; with no holidays either,
 *   covered time is plain wall-clock time (the fast path).
 * - Holidays (`YYYY-MM-DD` in the calendar's timezone) exclude whole days
 *   from coverage, including under 24×7 coverage.
 * - All functions take explicit instants — no `Date.now()` inside — so the
 *   engine and its tests stay deterministic.
 *
 * Timezone handling uses `Intl.DateTimeFormat#formatToParts` only (no date
 * library): {@link zonedParts} projects a UTC instant onto the calendar
 * timezone's wall clock, and an iterative inverse converts wall-clock day
 * positions back to UTC instants. DST transition days therefore keep exact
 * window boundaries; a window boundary falling inside a nonexistent
 * spring-forward hour lands on the later real instant so clocks never gain
 * time.
 */

import type { CoverageWindow } from '../types.js';

/** The coverage terms a Service Target clock runs against. */
export interface CoverageCalendar {
  /** Weekly coverage windows; empty means 24×7 coverage. */
  windows: CoverageWindow[];
  /** Holiday dates excluded from coverage (`YYYY-MM-DD`). */
  holidays: string[];
  /** IANA timezone the windows and holidays are expressed in. */
  timezone: string;
}

/** Wall-clock projection of a UTC instant in a target timezone. */
export interface ZonedParts {
  /** Calendar year in the target timezone. */
  year: number;
  /** Calendar month in the target timezone (1–12). */
  month: number;
  /** Calendar day of month in the target timezone (1–31). */
  day: number;
  /** 0 = Sunday … 6 = Saturday (matches {@link CoverageWindow} docs). */
  weekday: number;
  /** Minutes from local midnight (0–1439). */
  minuteOfDay: number;
  /** `YYYY-MM-DD` date key in the target timezone (holiday comparisons). */
  dateKey: string;
}

/**
 * Hard ceiling on how many calendar days {@link addCoveredMinutes} will walk
 * forward looking for coverage before failing loudly (a plan whose calendar
 * never covers anything would otherwise loop forever).
 */
export const MAX_COVERAGE_SCAN_DAYS = 400;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1_440;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** One `Intl.DateTimeFormat` per timezone — construction is expensive. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * Project a UTC instant onto a timezone's wall clock via
 * `Intl.DateTimeFormat#formatToParts`. Throws a `RangeError` for an invalid
 * IANA timezone name (surfacing plan misconfiguration immediately).
 */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(date);
  const byType: Record<string, string> = {};
  for (const part of parts) {
    byType[part.type] = part.value;
  }
  const year = Number(byType.year);
  const month = Number(byType.month);
  const day = Number(byType.day);
  const hour = Number(byType.hour) % 24;
  const minute = Number(byType.minute);
  return {
    year,
    month,
    day,
    weekday: WEEKDAY_INDEX[byType.weekday ?? ''] ?? 0,
    minuteOfDay: hour * 60 + minute,
    dateKey: `${byType.year}-${byType.month}-${byType.day}`,
  };
}

/** Wall-clock milliseconds since the UTC epoch, as if the zone were UTC. */
function wallClockMs(parts: ZonedParts): number {
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day) +
    parts.minuteOfDay * MINUTE_MS
  );
}

/**
 * Convert a wall-clock position (`year`/`month`/`day` + minutes from local
 * midnight) in `timeZone` to the UTC instant it names. Converges in one or
 * two steps for real wall times; a nonexistent spring-forward time lands on
 * the later real instant (clocks never gain covered time).
 */
function wallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string,
): number {
  const targetWallMs = Date.UTC(year, month - 1, day) + minuteOfDay * MINUTE_MS;
  let guessMs = targetWallMs;
  for (let i = 0; i < 4; i++) {
    const wallMs = wallClockMs(zonedParts(new Date(guessMs), timeZone));
    if (wallMs === targetWallMs) {
      return guessMs;
    }
    guessMs += targetWallMs - wallMs;
  }
  // Nonexistent wall time (DST gap): step onto the later real instant.
  const finalWallMs = wallClockMs(zonedParts(new Date(guessMs), timeZone));
  if (finalWallMs < targetWallMs) {
    guessMs += targetWallMs - finalWallMs;
  }
  return guessMs;
}

/** A covered span of real time within one calendar day, in UTC ms. */
interface CoveredSpan {
  startMs: number;
  endMs: number;
}

/** Clamp, sort, and merge a day's window minutes into disjoint spans. */
function normalizeWindowMinutes(
  windows: Array<Pick<CoverageWindow, 'startMinute' | 'endMinute'>>,
): Array<{ startMinute: number; endMinute: number }> {
  const clamped = windows
    .map((window) => ({
      startMinute: Math.max(0, Math.min(window.startMinute, MINUTES_PER_DAY)),
      endMinute: Math.max(0, Math.min(window.endMinute, MINUTES_PER_DAY)),
    }))
    .filter((window) => window.endMinute > window.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute);

  const merged: Array<{ startMinute: number; endMinute: number }> = [];
  for (const window of clamped) {
    const last = merged[merged.length - 1];
    if (last && window.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, window.endMinute);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/**
 * The covered spans of one calendar day (identified by its wall-clock
 * year/month/day in the calendar timezone), as UTC instants.
 */
function coveredSpansForDay(
  calendar: CoverageCalendar,
  parts: ZonedParts,
): CoveredSpan[] {
  if (calendar.holidays.includes(parts.dateKey)) {
    return [];
  }
  // The civil weekday of a Y-M-D is timezone-independent.
  const weekday = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay();
  const dayWindows =
    calendar.windows.length === 0
      ? [{ startMinute: 0, endMinute: MINUTES_PER_DAY }]
      : calendar.windows.filter((window) => window.weekday === weekday);

  return normalizeWindowMinutes(dayWindows).map((window) => ({
    startMs: wallTimeToUtcMs(
      parts.year,
      parts.month,
      parts.day,
      window.startMinute,
      calendar.timezone,
    ),
    endMs: wallTimeToUtcMs(
      parts.year,
      parts.month,
      parts.day,
      window.endMinute,
      calendar.timezone,
    ),
  }));
}

/** UTC instant of the calendar timezone's next local midnight after `parts`. */
function nextZoneMidnightMs(
  calendar: CoverageCalendar,
  parts: ZonedParts,
): number {
  const nextDate = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day) + DAY_MS,
  );
  return wallTimeToUtcMs(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    0,
    calendar.timezone,
  );
}

function isAlwaysCovered(calendar: CoverageCalendar): boolean {
  return calendar.windows.length === 0 && calendar.holidays.length === 0;
}

/**
 * Covered minutes between two instants (fractional; `0` when `to <= from`).
 *
 * Walks forward day by day through the calendar timezone, summing the overlap
 * of `[from, to)` with each day's covered spans.
 */
export function coveredMinutesBetween(
  calendar: CoverageCalendar,
  from: Date,
  to: Date,
): number {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (toMs <= fromMs) {
    return 0;
  }
  if (isAlwaysCovered(calendar)) {
    return (toMs - fromMs) / MINUTE_MS;
  }

  let totalMs = 0;
  let cursorMs = fromMs;
  while (cursorMs < toMs) {
    const parts = zonedParts(new Date(cursorMs), calendar.timezone);
    for (const span of coveredSpansForDay(calendar, parts)) {
      const start = Math.max(span.startMs, cursorMs);
      const end = Math.min(span.endMs, toMs);
      if (end > start) {
        totalMs += end - start;
      }
    }
    const nextMidnightMs = nextZoneMidnightMs(calendar, parts);
    if (nextMidnightMs <= cursorMs) {
      throw new Error(
        `coveredMinutesBetween: calendar for timezone '${calendar.timezone}' ` +
          'failed to advance past ' +
          new Date(cursorMs).toISOString(),
      );
    }
    cursorMs = nextMidnightMs;
  }
  return totalMs / MINUTE_MS;
}

/**
 * The instant at which `minutes` of covered time have elapsed from `from` —
 * the Service Target due-time computation. Walks forward day by day through
 * coverage windows, skipping holidays; throws a descriptive error after
 * {@link MAX_COVERAGE_SCAN_DAYS} days without accumulating enough coverage
 * (an effectively-empty calendar).
 */
export function addCoveredMinutes(
  calendar: CoverageCalendar,
  from: Date,
  minutes: number,
): Date {
  if (minutes <= 0) {
    return new Date(from.getTime());
  }
  if (isAlwaysCovered(calendar)) {
    return new Date(from.getTime() + minutes * MINUTE_MS);
  }

  let remainingMs = minutes * MINUTE_MS;
  let cursorMs = from.getTime();
  for (let dayScan = 0; dayScan <= MAX_COVERAGE_SCAN_DAYS; dayScan++) {
    const parts = zonedParts(new Date(cursorMs), calendar.timezone);
    for (const span of coveredSpansForDay(calendar, parts)) {
      const start = Math.max(span.startMs, cursorMs);
      if (span.endMs <= start) {
        continue;
      }
      const spanMs = span.endMs - start;
      if (spanMs >= remainingMs) {
        return new Date(start + remainingMs);
      }
      remainingMs -= spanMs;
    }
    const nextMidnightMs = nextZoneMidnightMs(calendar, parts);
    if (nextMidnightMs <= cursorMs) {
      throw new Error(
        `addCoveredMinutes: calendar for timezone '${calendar.timezone}' ` +
          'failed to advance past ' +
          new Date(cursorMs).toISOString(),
      );
    }
    cursorMs = nextMidnightMs;
  }
  throw new Error(
    `addCoveredMinutes: no coverage found within ${MAX_COVERAGE_SCAN_DAYS} ` +
      `days after ${from.toISOString()} for ${minutes} covered minute(s) — ` +
      'the coverage calendar appears to never cover any time ' +
      `(windows: ${JSON.stringify(calendar.windows)}, ` +
      `holidays: ${calendar.holidays.length}, timezone: '${calendar.timezone}').`,
  );
}
