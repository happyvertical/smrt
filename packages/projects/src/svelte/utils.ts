/**
 * Shared utilities for time tracking components
 */

export type Currency = 'CAD' | 'USD';

export type TimeEntryStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

/** Alias for TimeEntryStatus for approval workflows */
export type ApprovalStatus = TimeEntryStatus;

/**
 * Time entry data structure
 */
export interface TimeEntry {
  id: string;
  date: Date | string;
  hours: number;
  description: string;
  status: TimeEntryStatus;
  /** Integer minor units of the display currency — $19.99 is 1999 (#2401). */
  amount?: number;
  workerName?: string;
  mileage?: number;
  /** Minor units per hour, so `hours * hourlyRate` is minor units (#2401). */
  hourlyRate?: number;
}

/**
 * Status color mapping using M3 design tokens
 */
export const statusColors: Record<TimeEntryStatus, string> = {
  draft: 'var(--md-sys-color-outline)',
  submitted: 'var(--md-sys-color-tertiary)',
  approved: 'var(--md-sys-color-primary)',
  rejected: 'var(--md-sys-color-error)',
};

/**
 * Format a date for display (e.g., "Jan 5")
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

/**
 * Format a minor-units amount for display.
 *
 * Money in this package is integer minor units (#2401) — `$19.99` is `1999` —
 * and `Intl.NumberFormat` expects major units, so the scale is undone here.
 * Without it a $19.99 charge renders as $1,999.00.
 *
 * The currency's own minor-unit exponent is used rather than a hard-coded 100,
 * so zero-decimal currencies (JPY, KRW) are not divided by anything.
 */
export function formatCurrency(
  amount: number,
  currency: Currency = 'CAD',
): string {
  // No fraction-digit override: the currency's own exponent is both the scale
  // to undo and the precision to print. Forcing `minimumFractionDigits: 2`
  // (as this did before minor units) would pin `maximumFractionDigits` to 2 as
  // well, so a zero-decimal currency like JPY would report a scale of 2 — and
  // then render `¥1,999.00` for a currency that has no fractional part at all.
  // For CAD/USD the resolved default is already 2, so their output is
  // unchanged.
  const format = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(amount / 10 ** digits);
}

/**
 * Format hours for display (e.g., "8.5h")
 */
export function formatHours(hours: number): string {
  return `${hours.toFixed(1)}h`;
}

/**
 * Format hours in HH:MM format (e.g., "8:30")
 */
export function formatHoursHHMM(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}
