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
  /** IANA time zone for tooltips and absolute timestamps (default `'UTC'` so SSR and browser agree). */
  timeZone?: string;
  /** Localized label for timestamps within the last 45 seconds (default `'just now'`). */
  justNowLabel?: string;
  /** Shared reference clock epoch in milliseconds; when omitted, renders a deterministic clock-free timestamp. */
  now?: number;
}

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveTimeZone(timeZone: string | undefined): string {
  const candidate = timeZone?.trim();
  if (!candidate) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

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

function formatDateTime(
  parsed: Date,
  locale: string,
  options: Intl.DateTimeFormatOptions,
  fallback: string,
): string {
  try {
    return new Intl.DateTimeFormat(locale, options).format(parsed);
  } catch {
    try {
      return new Intl.DateTimeFormat('en-US', options).format(parsed);
    } catch {
      return fallback;
    }
  }
}

function formatFullTitle(
  parsed: Date,
  raw: string,
  locale: string,
  timeZone: string,
  isCalendarDate: boolean,
): string {
  const iso = isCalendarDate ? raw : parsed.toISOString();
  const formatted = formatDateTime(
    parsed,
    locale,
    isCalendarDate
      ? { dateStyle: 'long', timeZone: 'UTC' }
      : { dateStyle: 'medium', timeStyle: 'short', timeZone },
    iso,
  );
  return formatted === iso ? iso : `${formatted} (${iso})`;
}

function formatAbsoluteLabel(
  parsed: Date,
  raw: string,
  locale: string,
  timeZone: string,
  isCalendarDate: boolean,
): string {
  return formatDateTime(
    parsed,
    locale,
    isCalendarDate
      ? { dateStyle: 'medium', timeZone: 'UTC' }
      : { dateStyle: 'medium', timeStyle: 'short', timeZone },
    isCalendarDate ? raw : parsed.toISOString(),
  );
}

/**
 * Formats an ISO timestamp or calendar date into a readable relative label (when
 * a shared `now` epoch is supplied) or deterministic localized timestamp (when
 * `now` is omitted), plus full `<time datetime title>` metadata. Never reads the
 * ambient clock or local time zone, and never throws on invalid inputs.
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

  const locale = options.locale?.trim() || 'en-US';
  const timeZone = resolveTimeZone(options.timeZone);
  const justNow = options.justNowLabel || 'just now';
  const hasNow =
    typeof options.now === 'number' && Number.isFinite(options.now);

  let label: string;
  if (!hasNow) {
    label = formatAbsoluteLabel(
      parsed,
      trimmed,
      locale,
      timeZone,
      isCalendarDate,
    );
  } else {
    const deltaSeconds = Math.round((ms - (options.now as number)) / 1000);
    const absSeconds = Math.abs(deltaSeconds);
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
        label = rtf.format(
          sign * Math.max(1, Math.round(absDays / 30)),
          'month',
        );
      } else {
        label = rtf.format(
          sign * Math.max(1, Math.round(absDays / 365)),
          'year',
        );
      }
    }
  }

  return {
    datetime: isCalendarDate ? trimmed : parsed.toISOString(),
    title: formatFullTitle(parsed, trimmed, locale, timeZone, isCalendarDate),
    label,
  };
}
