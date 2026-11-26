/** Formatted timestamp presentation for `<time datetime title>`. */
export interface FormattedActivityTime {
  /** Valid machine-readable ISO timestamp or YYYY-MM-DD calendar string, when parseable. */
  datetime?: string;
  /** Full human-readable timestamp shown on hover (`title`). */
  title: string;
  /** Concise relative timestamp shown inline. */
  label: string;
}

export interface FormatActivityTimestampOptions {
  /** BCP-47 locale tag (default `'en-US'`). */
  locale?: string;
  /** Localized label for timestamps within the last 45 seconds (default `'just now'`). */
  justNowLabel?: string;
  /** Reference clock epoch in milliseconds (default `Date.now()`). */
  now?: number;
}

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveRelativeFormatter(locale: string): Intl.RelativeTimeFormat {
  try {
    return new Intl.RelativeTimeFormat(locale, {
      numeric: 'auto',
      style: 'short',
    });
  } catch {
    return new Intl.RelativeTimeFormat('en-US', {
      numeric: 'auto',
      style: 'short',
    });
  }
}

function formatFullTitle(
  parsed: Date,
  raw: string,
  locale: string,
  isCalendarDate: boolean,
): string {
  try {
    const formatted = new Intl.DateTimeFormat(
      locale,
      isCalendarDate
        ? { dateStyle: 'long', timeZone: 'UTC' }
        : { dateStyle: 'medium', timeStyle: 'short' },
    ).format(parsed);
    return isCalendarDate
      ? `${formatted} (${raw})`
      : `${formatted} (${parsed.toISOString()})`;
  } catch {
    return isCalendarDate ? raw : parsed.toISOString();
  }
}

/**
 * Formats an ISO timestamp or calendar date into a readable relative label plus
 * full `<time datetime title>` metadata. Never throws on invalid dates or locales.
 */
export function formatActivityTimestamp(
  value: string | null | undefined,
  options: FormatActivityTimestampOptions = {},
): FormattedActivityTime | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isCalendarDate = CALENDAR_DATE_RE.test(trimmed);
  const parsed = new Date(trimmed);
  const ms = parsed.getTime();
  if (
    !Number.isFinite(ms) ||
    (isCalendarDate && parsed.toISOString().slice(0, 10) !== trimmed)
  ) {
    return { title: trimmed, label: trimmed };
  }

  const locale = options.locale || 'en-US';
  const justNow = options.justNowLabel || 'just now';
  const now = options.now ?? Date.now();
  const deltaSeconds = Math.round((ms - now) / 1000);
  const absSeconds = Math.abs(deltaSeconds);

  let label: string;
  if (absSeconds < 45 && !isCalendarDate) {
    label = justNow;
  } else {
    const rtf = resolveRelativeFormatter(locale);
    const sign = deltaSeconds < 0 ? -1 : 1;
    const absMinutes = Math.round(absSeconds / 60);
    const absHours = Math.round(absSeconds / 3600);
    const absDays = Math.round(absSeconds / 86_400);
    if (absSeconds < 3600 && !isCalendarDate) {
      label = rtf.format(sign * Math.max(1, absMinutes), 'minute');
    } else if (absSeconds < 86_400 && !isCalendarDate) {
      label = rtf.format(sign * Math.max(1, absHours), 'hour');
    } else if (absDays === 0 && isCalendarDate) {
      label = rtf.format(0, 'day');
    } else if (absDays < 7) {
      label = rtf.format(sign * Math.max(1, absDays), 'day');
    } else if (absDays < 30) {
      label = rtf.format(sign * Math.max(1, Math.round(absDays / 7)), 'week');
    } else if (absDays < 365) {
      label = rtf.format(sign * Math.max(1, Math.round(absDays / 30)), 'month');
    } else {
      label = rtf.format(sign * Math.max(1, Math.round(absDays / 365)), 'year');
    }
  }

  return {
    datetime: isCalendarDate ? trimmed : parsed.toISOString(),
    title: formatFullTitle(parsed, trimmed, locale, isCalendarDate),
    label,
  };
}
