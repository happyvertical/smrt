/**
 * Time language for runtime reports (#4100): "by month", "weekly", "over
 * time", "last month", "this year", "last 90 days", "Q3".
 *
 * A person asks for reports in words; a spec needs a bucket and a `[from, to)`
 * date range. These pure functions turn the words into those values against a
 * caller-supplied `now`, so an assistant (smrt-chat, the planner) resolves
 * time with code rather than asking a model to do date arithmetic. All dates
 * are UTC, like the runners' buckets. Browser-safe.
 */

import type { RuntimeReportBucket } from './runtime-spec.js';

/** A resolved period: `[from, to)` as `YYYY-MM-DD`, and how to name it. */
export interface RuntimeReportTimeRange {
  from: string;
  to: string;
  /** Lower-case words for a title: "last month", "Q3 2025", "last 90 days". */
  label: string;
}

export interface RuntimeReportTimeIntent {
  /** A time grouping the words ask for ("by month", "weekly", "over time"). */
  bucket?: RuntimeReportBucket;
  /** A period the words name ("last quarter", "Q3", "last 90 days"). */
  range?: RuntimeReportTimeRange;
  /** The words mention time at all (a grouping, a period or a trend). */
  mentionsTime: boolean;
}

const DAY = 86_400_000;
const ymd = (time: number) => new Date(time).toISOString().slice(0, 10);
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const ORDINAL_QUARTERS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
};

const BUCKET_WORDS: [RuntimeReportBucket, RegExp][] = [
  [
    'minute',
    /\b(?:minutely|(?:per|by|each|every|a) minute|minute by minute)\b/,
  ],
  ['hour', /\b(?:hourly|(?:per|by|each|every|an?) hour|hour by hour)\b/],
  ['day', /\b(?:daily|(?:per|by|each|every|a) day|day by day)\b/],
  [
    'week',
    /\b(?:weekly|(?:per|by|each|every|a) week|week by week|week over week)\b/,
  ],
  [
    'month',
    /\b(?:monthly|(?:per|by|each|every|a) month|month by month|month over month)\b/,
  ],
  [
    'quarter',
    /\b(?:quarterly|(?:per|by|each|every|a) quarter|quarter by quarter|quarter over quarter)\b/,
  ],
  [
    'year',
    /\b(?:yearly|annually|annual|(?:per|by|each|every|a) year|year by year|year over year)\b/,
  ],
];
const TREND_WORDS = /\b(?:over time|trends?|trending|timeline|history)\b/;

/** The bucket "over time" means for a period of this many days. */
export function runtimeReportBucketForSpan(
  days: number | null,
): RuntimeReportBucket {
  if (days === null) return 'month';
  if (days <= 31) return 'day';
  if (days <= 92) return 'week';
  if (days <= 3 * 366) return 'month';
  return 'quarter';
}

function span(range: RuntimeReportTimeRange): number {
  return Math.round(
    (Date.parse(`${range.to}T00:00:00Z`) -
      Date.parse(`${range.from}T00:00:00Z`)) /
      DAY,
  );
}

/**
 * Resolve a period phrase against `now`. Null when the words name no period
 * (or "all time"). A quarter or month named without a year is its latest
 * occurrence that has started: in May, "Q3" is last year's.
 */
export function resolveRuntimeReportTimeRange(
  phrase: string,
  now: Date,
): RuntimeReportTimeRange | null {
  const text = phrase.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = Date.UTC(y, m, now.getUTCDate());
  const tomorrow = today + DAY;
  const monday = today - ((now.getUTCDay() + 6) % 7) * DAY;
  const quarter = Math.floor(m / 3) * 3;
  const range = (from: number, to: number, label: string) => ({
    from: ymd(from),
    to: ymd(to),
    label,
  });

  // "last 90 days", "past 6 months", "last 2 weeks"
  const recent =
    /\b(?:last|past|previous|trailing)\s+(\d{1,4})\s+(day|week|month|year)s?\b/.exec(
      text,
    );
  if (recent) {
    const n = Number(recent[1]);
    const unit = recent[2];
    if (n > 0) {
      const from =
        unit === 'day'
          ? tomorrow - n * DAY
          : unit === 'week'
            ? tomorrow - n * 7 * DAY
            : unit === 'month'
              ? Date.UTC(y, m - n, now.getUTCDate() + 1)
              : Date.UTC(y - n, m, now.getUTCDate() + 1);
      return range(from, tomorrow, `last ${n} ${unit}${n === 1 ? '' : 's'}`);
    }
  }

  // "Q3", "Q3 2025", "third quarter"
  const q =
    /\bq([1-4])(?:\s*(?:of\s*)?((?:19|20)\d{2}))?\b/.exec(text) ??
    /\b(first|second|third|fourth) quarter(?: (?:of )?((?:19|20)\d{2}))?\b/.exec(
      text,
    );
  if (q) {
    const n = /^\d$/.test(q[1]) ? Number(q[1]) : ORDINAL_QUARTERS[q[1]];
    const startMonth = (n - 1) * 3;
    const year = q[2]
      ? Number(q[2])
      : Date.UTC(y, startMonth, 1) <= today
        ? y
        : y - 1;
    return range(
      Date.UTC(year, startMonth, 1),
      Date.UTC(year, startMonth + 3, 1),
      `Q${n} ${year}`,
    );
  }

  if (/\b(?:year to date|ytd)\b/.test(text)) {
    return range(Date.UTC(y, 0, 1), tomorrow, 'year to date');
  }
  if (/\b(?:month to date|mtd)\b/.test(text)) {
    return range(Date.UTC(y, m, 1), tomorrow, 'month to date');
  }
  if (/\btoday\b/.test(text)) return range(today, tomorrow, 'today');
  if (/\byesterday\b/.test(text)) return range(today - DAY, today, 'yesterday');

  const relative =
    /\b(this|current|last|previous|past) (week|month|quarter|year)\b/.exec(
      text,
    );
  if (relative) {
    const last = relative[1] !== 'this' && relative[1] !== 'current';
    const unit = relative[2];
    const label = `${last ? 'last' : 'this'} ${unit}`;
    switch (unit) {
      case 'week':
        return last
          ? range(monday - 7 * DAY, monday, label)
          : range(monday, monday + 7 * DAY, label);
      case 'month':
        return last
          ? range(Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1), label)
          : range(Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1), label);
      case 'quarter':
        return last
          ? range(Date.UTC(y, quarter - 3, 1), Date.UTC(y, quarter, 1), label)
          : range(Date.UTC(y, quarter, 1), Date.UTC(y, quarter + 3, 1), label);
      default:
        return last
          ? range(Date.UTC(y - 1, 0, 1), Date.UTC(y, 0, 1), label)
          : range(Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1), label);
    }
  }

  // "December", "in March 2025"
  const month = new RegExp(
    `\\b(${MONTHS.join('|')})(?: ((?:19|20)\\d{2}))?\\b`,
  ).exec(text);
  // "may" alone is usually the verb; May counts only with a year.
  if (month && (month[1] !== 'may' || month[2])) {
    const match = month;
    const index = MONTHS.indexOf(match[1]);
    const year = match[2]
      ? Number(match[2])
      : Date.UTC(y, index, 1) <= today
        ? y
        : y - 1;
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    return range(
      Date.UTC(year, index, 1),
      Date.UTC(year, index + 1, 1),
      `${name} ${year}`,
    );
  }

  // "in 2025", "for 2024", or the period slot holding just a year
  const year =
    /\b(?:in|for|during)\s+((?:19|20)\d{2})\b/.exec(text) ??
    /^\s*((?:19|20)\d{2})\s*$/.exec(text);
  if (year) {
    const n = Number(year[1]);
    return range(Date.UTC(n, 0, 1), Date.UTC(n + 1, 0, 1), String(n));
  }
  return null;
}

/**
 * Read a request's time words: a grouping ("by month", "weekly"; "over time"
 * picks one from the period's length), a period, and whether time came up at
 * all ("the date month" mentions time without naming either).
 */
export function parseRuntimeReportTime(
  text: string,
  now: Date,
): RuntimeReportTimeIntent {
  const words = text.toLowerCase();
  const range = resolveRuntimeReportTimeRange(words, now) ?? undefined;
  let bucket = BUCKET_WORDS.find(([, pattern]) => pattern.test(words))?.[0];
  const trend = TREND_WORDS.test(words);
  if (!bucket && trend) {
    bucket = runtimeReportBucketForSpan(range ? span(range) : null);
  }
  const mentionsTime =
    Boolean(bucket || range || trend) ||
    /\b(?:date|dates|time|when|minute|hour|day|week|month|quarter|year)s?\b/.test(
      words,
    );
  return {
    ...(bucket ? { bucket } : {}),
    ...(range ? { range } : {}),
    mentionsTime,
  };
}
