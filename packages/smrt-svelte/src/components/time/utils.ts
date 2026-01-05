/**
 * Shared utilities for time tracking components
 */

export type Currency = 'CAD' | 'USD';

export type TimeEntryStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

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
 * Format currency amount for display
 */
export function formatCurrency(
  amount: number,
  currency: Currency = 'CAD',
): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
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
