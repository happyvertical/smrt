import type { DateLike } from './types.js';

export function formatCents(
  cents: number,
  currency: string,
  locale?: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

export function formatNumber(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatPercent(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatDate(value: DateLike, locale?: string): string {
  if (value == null) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

export function formatDateRange(
  startAt: DateLike,
  endAt: DateLike,
  locale?: string,
): string {
  if (startAt == null && endAt == null) return 'No fixed schedule';
  return `${formatDate(startAt, locale)} – ${formatDate(endAt, locale)}`;
}

export function humanizeKey(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, (letter) => letter.toUpperCase());
}
