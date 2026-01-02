<script lang="ts">
/**
 * DateDisplay - Formats and displays dates
 *
 * Supports various format options and relative time display.
 */

interface Props {
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
}

const {
  date,
  format = 'medium',
  fallback = 'N/A',
  showTime = false,
  locale = 'en-CA',
}: Props = $props();

// Parse the date
const parsedDate = $derived.by(() => {
  if (date === null || date === undefined) return null;
  if (date instanceof Date) return date;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
});

// Format options for Intl.DateTimeFormat
const dateOptions: Record<string, Intl.DateTimeFormatOptions> = {
  short: { month: 'short', day: 'numeric' },
  medium: { year: 'numeric', month: 'short', day: 'numeric' },
  long: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
};

// Format relative time
function formatRelative(d: Date): string {
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

  if (format === 'relative') {
    return formatRelative(parsedDate);
  }

  const options = { ...dateOptions[format] };
  if (showTime) {
    options.hour = 'numeric';
    options.minute = '2-digit';
  }

  return new Intl.DateTimeFormat(locale, options).format(parsedDate);
});

// ISO string for datetime attribute
const isoString = $derived(parsedDate?.toISOString() ?? '');
</script>

{#if parsedDate}
  <time class="date-display" datetime={isoString}>
    {formatted}
  </time>
{:else}
  <span class="date-display date-fallback">
    {fallback}
  </span>
{/if}

<style>
  .date-display {
    white-space: nowrap;
  }

  .date-fallback {
    color: #9ca3af;
    font-style: italic;
  }
</style>
