<script lang="ts">
/**
 * DateDisplay - Formats and displays dates
 *
 * Supports various format options and relative time display.
 */

/** Props for DateDisplay component */
export interface Props {
  /** Date to display (Date, ISO string, or timestamp) */
  date: Date | string | number | null | undefined;
  /** Display format */
  format?: 'short' | 'medium' | 'long' | 'relative';
  /** Fallback text when date is null/undefined */
  fallback?: string;
  /** Show time along with date */
  showTime?: boolean;
  /** Locale for formatting (defaults to en-CA) */
  locale?: string;
  /** IANA zone for timestamps and relative calendar-day boundaries. */
  timeZone?: string;
  /** Optional CSS class */
  class?: string;
}

const {
  date,
  format = 'medium',
  fallback = 'N/A',
  showTime = false,
  locale = 'en-CA',
  timeZone,
  class: className = '',
}: Props = $props();

const isCalendarDate = $derived(
  typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date),
);

// Bare dates denote a calendar day, never a browser-local instant.
const parsedDate = $derived.by(() => {
  if (date === null || date === undefined) return null;
  if (date instanceof Date) return Number.isNaN(date.getTime()) ? null : date;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  if (isCalendarDate && d.toISOString().slice(0, 10) !== date) return null;
  return d;
});

// Format options for Intl.DateTimeFormat
const dateOptions: Record<string, Intl.DateTimeFormatOptions> = {
  short: { month: 'short', day: 'numeric' },
  medium: { year: 'numeric', month: 'short', day: 'numeric' },
  long: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
};

// Convert zone-local Gregorian dates to ordinals so DST does not alter day counts.
function calendarDay(d: Date, zone?: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(d);
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const midnight = new Date(0);
  midnight.setUTCFullYear(part('year'), part('month') - 1, part('day'));
  return midnight.getTime() / 86400000;
}

function formatCalendarRelative(d: Date): string {
  const now = new Date();
  const days =
    calendarDay(now, timeZone) -
    (isCalendarDate ? d.getTime() / 86400000 : calendarDay(d, timeZone));
  if (days === 0) {
    if (isCalendarDate || d > now) return 'today';
    const minutes = Math.floor((now.getTime() - d.getTime()) / 60000);
    if (minutes === 0) return 'just now';
    return minutes < 60
      ? `${minutes}m ago`
      : `${Math.floor(minutes / 60)}h ago`;
  }
  if (days === 1) return 'yesterday';
  if (days === -1) return 'tomorrow';
  const count = Math.abs(days);
  const [amount, unit] =
    count < 7
      ? [count, 'days']
      : count < 30
        ? [Math.floor(count / 7), 'weeks']
        : count < 365
          ? [Math.floor(count / 30), 'months']
          : [Math.floor(count / 365), 'years'];
  return days < 0 ? `in ${amount} ${unit}` : `${amount} ${unit} ago`;
}

// Preserve duration-based relative defaults for instant inputs without a zone.
function formatRelative(d: Date): string {
  if (timeZone !== undefined || isCalendarDate)
    return formatCalendarRelative(d);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  // Future dates
  if (diffMs < 0) {
    const absDiffDays = Math.abs(diffDays);
    if (absDiffDays === 0) return 'today';
    if (absDiffDays === 1) return 'tomorrow';
    if (absDiffDays < 7) return `in ${absDiffDays} days`;
    if (absDiffDays < 30) return `in ${Math.abs(diffWeeks)} weeks`;
    if (absDiffDays < 365) return `in ${Math.abs(diffMonths)} months`;
    return `in ${Math.abs(diffYears)} years`;
  }

  // Past dates
  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffWeeks < 4) return `${diffWeeks} weeks ago`;
  if (diffMonths < 12) return `${diffMonths} months ago`;
  return `${diffYears} years ago`;
}

// Format the date
const formatted = $derived.by(() => {
  if (!parsedDate) return fallback;

  try {
    if (format === 'relative') return formatRelative(parsedDate);

    const options = {
      ...dateOptions[format],
      timeZone: isCalendarDate ? 'UTC' : timeZone,
    };
    if (showTime && !isCalendarDate) {
      options.hour = 'numeric';
      options.minute = '2-digit';
    }
    return new Intl.DateTimeFormat(locale, options).format(parsedDate);
  } catch (error) {
    if (error instanceof RangeError) return fallback;
    throw error;
  }
});

// ISO string for datetime attribute
const isoString = $derived(
  isCalendarDate && parsedDate
    ? String(date)
    : (parsedDate?.toISOString() ?? ''),
);
</script>

{#if parsedDate}
  <time class="date-display {className}" datetime={isoString}>
    {formatted}
  </time>
{:else}
  <span class="date-display date-fallback {className}">
    {fallback}
  </span>
{/if}

<style>
  .date-display {
    white-space: nowrap;
  }

  .date-fallback {
    color: var(--smrt-color-on-surface-variant, #9ca3af);
    font-style: italic;
  }
</style>
