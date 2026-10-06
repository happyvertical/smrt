/**
 * Shared utilities for time tracking components
 */

/** ISO 4217 currency code used to display integer minor-unit amounts. */
export type Currency = string;

/** Caller-controlled decimal-hours presentation. */
export type HoursFormatter = (hours: number) => string;

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
 * ISO 4217 exponents, matching the SDK accounting and commerce tables.
 * ICU display precision is not a monetary scale (notably IQD, MGA and ALL).
 */
const ISO_EXPONENTS: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

/** Return the ISO 4217 minor-unit exponent used by timesheet amounts. */
export function currencyMinorUnitExponent(currency: Currency): number {
  return ISO_EXPONENTS[currency.trim().toUpperCase()] ?? 2;
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
  const code = currency.trim().toUpperCase();
  const digits = currencyMinorUnitExponent(code);
  const format = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
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
