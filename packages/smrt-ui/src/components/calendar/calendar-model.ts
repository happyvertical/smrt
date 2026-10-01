/**
 * Pure, Svelte-free date model for `CalendarView`.
 *
 * Every calendar day is a `YYYY-MM-DD` key in the view's IANA time zone.
 * Instants are projected into that zone through `Intl` exactly once; all
 * further math (grids, spans, lanes) runs on keys, so the browser's own zone
 * never leaks into what a day contains.
 */

/** Color tone of a calendar item, mapped to the theme's color roles. */
export type CalendarTone =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'success'
  | 'warning'
  | 'error'
  | 'neutral';

/** A generic item on the calendar (an event, a meeting, a game, a deadline). */
export interface CalendarItem {
  /** Stable identity, used as the render key. */
  id: string;
  /** Visible title. */
  title: string;
  /**
   * Start: a `Date`, an ISO date-time string, or a `YYYY-MM-DD` date (which
   * makes the item all-day unless `allDay` says otherwise).
   */
  start: Date | string;
  /**
   * End. Timed items: the exclusive end instant. All-day items: a
   * `YYYY-MM-DD` date is the inclusive last day; an instant at local
   * midnight is the exclusive end (the day after the last day).
   */
  end?: Date | string | null;
  /** Occupies whole days; rendered as a band in the month grid. */
  allDay?: boolean;
  /** Color role. Defaults to one derived from `group`, else `primary`. */
  tone?: CalendarTone;
  /** Explicit CSS color; overrides `tone`. */
  color?: string;
  /** Short category text shown next to the title in lists (e.g. "Council"). */
  label?: string;
  /** Stable grouping key (e.g. a content type); picks a tone when none is set. */
  group?: string;
  /** Link target. Without it the item is a button that calls `onItemSelect`. */
  href?: string;
}

/** A visible month; `month` is 1-12 (calendar numbering, not `Date#getMonth`). */
export interface CalendarMonth {
  year: number;
  month: number;
}

/** Month grid, agenda list, or month grid above 48rem and agenda below. */
export type CalendarMode = 'auto' | 'month' | 'agenda';

/** An item projected onto calendar day keys. */
export interface CalendarEntry {
  item: CalendarItem;
  /** First day (inclusive). */
  startKey: string;
  /** Last day (inclusive). */
  endKey: string;
  allDay: boolean;
  /** Rendered as a band: all-day, or spans more than one day. */
  band: boolean;
  /** Start instant for timed items; start-of-day ordering for all-day. */
  startMs: number;
}

/** A band segment inside one week row. */
export interface CalendarBandSegment {
  entry: CalendarEntry;
  /** 0-6 column in the week. */
  column: number;
  /** Number of columns covered. */
  span: number;
  /** 0-based lane (row) inside the week's band area. */
  lane: number;
  /** The item started before this week. */
  continuesBefore: boolean;
  /** The item ends after this week. */
  continuesAfter: boolean;
}

/** A single day cell in a laid-out week. */
export interface CalendarDayCell {
  key: string;
  day: number;
  inMonth: boolean;
  /** Timed single-day items shown in the cell. */
  visible: CalendarEntry[];
  /** Items (bands and timed) on this day that did not fit. */
  hiddenCount: number;
  /** Every item on this day (bands first, then by start). */
  all: CalendarEntry[];
}

/** One week row of the month grid. */
export interface CalendarWeek {
  days: CalendarDayCell[];
  bands: CalendarBandSegment[];
  /** Number of band lanes rendered in this week. */
  lanes: number;
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const TONES: CalendarTone[] = [
  'primary',
  'tertiary',
  'secondary',
  'success',
  'warning',
  'error',
];

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(instant: Date, timeZone: string) {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return {
    key: `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`,
    midnight:
      Number(get('hour')) % 24 === 0 &&
      get('minute') === '00' &&
      get('second') === '00',
  };
}

/** The browser's resolved IANA zone (`UTC` when unavailable). */
export function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Whether `timeZone` is an IANA zone this runtime's `Intl` accepts. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * `timeZone` when valid, otherwise the runtime default. `onInvalid` hears
 * about a rejected non-empty zone (a typo, a zone this runtime lacks), so a
 * view can warn instead of throwing from its render.
 */
export function resolveTimeZone(
  timeZone: string | undefined,
  onInvalid?: (timeZone: string) => void,
): string {
  if (!timeZone) return defaultTimeZone();
  if (isValidTimeZone(timeZone)) return timeZone;
  onInvalid?.(timeZone);
  return defaultTimeZone();
}

/**
 * The calendar day of an instant in a time zone.
 *
 * @param instant - Instant to project
 * @param timeZone - IANA time zone
 * @returns `YYYY-MM-DD`
 */
export function dateKeyInZone(instant: Date, timeZone: string): string {
  return zonedParts(instant, timeZone).key;
}

/** Today's `YYYY-MM-DD` in a time zone. */
export function todayKey(timeZone: string, now: Date = new Date()): string {
  return dateKeyInZone(now, timeZone);
}

/** Whether a string is a `YYYY-MM-DD` date key. */
export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && DATE_KEY.test(value);
}

function keyToDayNumber(key: string): number {
  const match = DATE_KEY.exec(key);
  if (!match) throw new RangeError(`Invalid date key: ${key}`);
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS,
  );
}

function dayNumberToKey(dayNumber: number): string {
  const date = new Date(dayNumber * DAY_MS);
  return formatKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

/** Build a `YYYY-MM-DD` key (month 1-12). */
export function formatKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Split a key into numbers (month 1-12). */
export function parseKey(key: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = DATE_KEY.exec(key);
  if (!match) throw new RangeError(`Invalid date key: ${key}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/** Add days to a key. */
export function addDays(key: string, days: number): string {
  return dayNumberToKey(keyToDayNumber(key) + days);
}

/** Day of week of a key (0 = Sunday). */
export function weekdayOfKey(key: string): number {
  return (((keyToDayNumber(key) + 4) % 7) + 7) % 7;
}

/** The month a key falls in. */
export function monthOfKey(key: string): CalendarMonth {
  const { year, month } = parseKey(key);
  return { year, month };
}

/** Shift a month by `delta` months. */
export function shiftMonth(value: CalendarMonth, delta: number): CalendarMonth {
  const index = value.year * 12 + (value.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Days in a month. */
export function daysInMonth(value: CalendarMonth): number {
  return new Date(Date.UTC(value.year, value.month, 0)).getUTCDate();
}

/** Move a key by whole months, clamping the day (Jan 31 + 1 month = Feb 28). */
export function addMonthsToKey(key: string, delta: number): string {
  const { day } = parseKey(key);
  const target = shiftMonth(monthOfKey(key), delta);
  return formatKey(
    target.year,
    target.month,
    Math.min(day, daysInMonth(target)),
  );
}

/** Every key of a month, in order. */
export function monthKeys(value: CalendarMonth): string[] {
  const length = daysInMonth(value);
  return Array.from({ length }, (_, index) =>
    formatKey(value.year, value.month, index + 1),
  );
}

/**
 * Full weeks covering a month.
 *
 * @param value - Month to cover
 * @param weekStartsOn - First column (0 = Sunday, 1 = Monday, …)
 * @returns Week rows of seven keys each
 */
export function monthWeeks(
  value: CalendarMonth,
  weekStartsOn: number,
): string[][] {
  const first = formatKey(value.year, value.month, 1);
  const last = formatKey(value.year, value.month, daysInMonth(value));
  let cursor = addDays(first, -((weekdayOfKey(first) - weekStartsOn + 7) % 7));
  const weeks: string[][] = [];
  while (cursor <= last) {
    const week: string[] = [];
    for (let index = 0; index < 7; index++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * First day of the week for a locale (0 = Sunday), from `Intl.Locale` week
 * info where the runtime provides it; Sunday otherwise.
 */
export function defaultWeekStart(locale: string | undefined): number {
  try {
    const intlLocale = new Intl.Locale(locale || 'en-US') as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = intlLocale.getWeekInfo?.() ?? intlLocale.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    // An invalid locale tag falls through to the Sunday default below.
  }
  return 0;
}

/** Tone for an item: explicit tone, else a stable tone for its group. */
export function toneFor(item: CalendarItem): CalendarTone {
  if (item.tone) return item.tone;
  if (!item.group) return 'primary';
  let hash = 0;
  for (const char of item.group) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

function toInstant(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Project items onto day keys. Items with unparseable dates are dropped and
 * reported through `onInvalid`.
 *
 * @param items - Calendar items
 * @param timeZone - IANA zone the calendar shows
 * @param onInvalid - Called for each dropped item
 * @returns Entries sorted by start
 */
export function toEntries(
  items: readonly CalendarItem[],
  timeZone: string,
  onInvalid?: (item: CalendarItem) => void,
): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  for (const item of items) {
    const dateOnlyStart = isDateKey(item.start);
    const allDay = item.allDay ?? dateOnlyStart;
    let startKey: string;
    let startMs: number;

    if (dateOnlyStart) {
      startKey = item.start as string;
      startMs = keyToDayNumber(startKey) * DAY_MS;
    } else {
      const start = toInstant(item.start);
      if (Number.isNaN(start.getTime())) {
        onInvalid?.(item);
        continue;
      }
      startKey = dateKeyInZone(start, timeZone);
      startMs = allDay ? keyToDayNumber(startKey) * DAY_MS : start.getTime();
    }

    let endKey = startKey;
    if (item.end !== undefined && item.end !== null && item.end !== '') {
      if (isDateKey(item.end)) {
        endKey = item.end;
      } else {
        const end = toInstant(item.end);
        if (Number.isNaN(end.getTime())) {
          onInvalid?.(item);
          continue;
        }
        if (allDay) {
          const parts = zonedParts(end, timeZone);
          endKey =
            parts.midnight && parts.key > startKey
              ? addDays(parts.key, -1)
              : parts.key;
        } else if (end.getTime() > startMs) {
          endKey = dateKeyInZone(new Date(end.getTime() - 1), timeZone);
        }
      }
    }
    if (endKey < startKey) endKey = startKey;

    entries.push({
      item,
      startKey,
      endKey,
      allDay,
      band: allDay || endKey !== startKey,
      startMs,
    });
  }
  return entries.sort(compareEntries);
}

function compareEntries(a: CalendarEntry, b: CalendarEntry): number {
  if (a.band !== b.band) return a.band ? -1 : 1;
  if (a.startKey !== b.startKey) return a.startKey < b.startKey ? -1 : 1;
  if (a.band && a.endKey !== b.endKey) return a.endKey > b.endKey ? -1 : 1;
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  return a.item.title.localeCompare(b.item.title);
}

/** Every entry on a day: bands covering it first, then timed items by start. */
export function entriesOnDay(
  entries: readonly CalendarEntry[],
  key: string,
): CalendarEntry[] {
  return entries.filter((entry) =>
    entry.band
      ? entry.startKey <= key && entry.endKey >= key
      : entry.startKey === key,
  );
}

/**
 * Lay out a month grid: bands get lanes per week, each day shows what fits in
 * `maxPerDay` rows, and the rest is counted for a "+N more" control.
 *
 * @param value - Visible month
 * @param entries - Entries from {@link toEntries}
 * @param options - First weekday and per-day row budget
 * @returns Week rows
 */
export function layoutMonth(
  value: CalendarMonth,
  entries: readonly CalendarEntry[],
  options: { weekStartsOn: number; maxPerDay: number },
): CalendarWeek[] {
  const maxPerDay = Math.max(1, Math.floor(options.maxPerDay));
  const bands = entries.filter((entry) => entry.band);
  const timed = entries.filter((entry) => !entry.band);

  return monthWeeks(value, options.weekStartsOn).map((keys) => {
    const weekStart = keys[0];
    const weekEnd = keys[6];
    const hidden = new Map<string, number>();
    const laneEnds: number[] = [];
    const segments: CalendarBandSegment[] = [];

    const inWeek = bands
      .filter((entry) => entry.startKey <= weekEnd && entry.endKey >= weekStart)
      .map((entry) => {
        const from = entry.startKey < weekStart ? weekStart : entry.startKey;
        const to = entry.endKey > weekEnd ? weekEnd : entry.endKey;
        const column = keys.indexOf(from);
        return { entry, column, span: keys.indexOf(to) - column + 1 };
      })
      .sort(
        (a, b) =>
          a.column - b.column ||
          b.span - a.span ||
          compareEntries(a.entry, b.entry),
      );

    const assigned = inWeek.map((segment) => {
      let lane = laneEnds.findIndex((end) => end < segment.column);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(-1);
      }
      laneEnds[lane] = segment.column + segment.span - 1;
      return { ...segment, lane };
    });

    // When bands overflow, keep the last row free for "+N more".
    const lanes = laneEnds.length > maxPerDay ? maxPerDay - 1 : laneEnds.length;
    for (const segment of assigned) {
      if (segment.lane < lanes) {
        segments.push({
          ...segment,
          continuesBefore: segment.entry.startKey < weekStart,
          continuesAfter: segment.entry.endKey > weekEnd,
        });
      } else {
        for (let offset = 0; offset < segment.span; offset++) {
          const key = keys[segment.column + offset];
          hidden.set(key, (hidden.get(key) ?? 0) + 1);
        }
      }
    }

    const rows = maxPerDay - lanes;
    const days = keys.map((key) => {
      const dayTimed = timed.filter((entry) => entry.startKey === key);
      const hiddenBands = hidden.get(key) ?? 0;
      const fits = hiddenBands === 0 && dayTimed.length <= rows;
      const visible = fits
        ? dayTimed
        : dayTimed.slice(0, Math.max(0, rows - 1));
      const parts = parseKey(key);
      return {
        key,
        day: parts.day,
        inMonth: parts.month === value.month && parts.year === value.year,
        visible,
        hiddenCount: hiddenBands + dayTimed.length - visible.length,
        all: entriesOnDay(entries, key),
      };
    });

    return { days, bands: segments, lanes };
  });
}
