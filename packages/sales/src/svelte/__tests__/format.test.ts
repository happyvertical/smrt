/**
 * Unit tests for the render-time formatting helpers of the svelte module.
 * Locales are passed explicitly so expectations stay machine-independent.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_VALUE_PLACEHOLDER,
  formatCents,
  formatDate,
  formatPercent,
} from '../format.js';

describe('formatCents', () => {
  it('formats integer cents as major currency units', () => {
    expect(formatCents(123456, 'USD', 'en-US')).toBe('$1,234.56');
  });

  it('formats zero', () => {
    expect(formatCents(0, 'USD', 'en-US')).toBe('$0.00');
  });

  it('formats negative cents (clawbacks) as negative amounts', () => {
    expect(formatCents(-4550, 'USD', 'en-US')).toBe('-$45.50');
  });

  it('handles large values with grouping', () => {
    expect(formatCents(123456789012, 'USD', 'en-US')).toBe('$1,234,567,890.12');
  });

  it('rounds accidental float inputs to whole cents (half away from zero)', () => {
    expect(formatCents(100.5, 'USD', 'en-US')).toBe('$1.01');
    expect(formatCents(-100.5, 'USD', 'en-US')).toBe('-$1.01');
  });

  it('respects the currency code', () => {
    expect(formatCents(9900, 'EUR', 'en-US')).toBe('€99.00');
  });

  it('falls back to "<major> <code>" for unknown currency codes', () => {
    expect(formatCents(12345, 'NOT_A_CODE', 'en-US')).toBe('123.45 NOT_A_CODE');
  });

  it('renders the placeholder for non-finite input', () => {
    expect(formatCents(Number.NaN, 'USD', 'en-US')).toBe(
      EMPTY_VALUE_PLACEHOLDER,
    );
  });
});

describe('formatDate', () => {
  it('formats Date instances as medium dates', () => {
    expect(formatDate(new Date(2026, 5, 15), 'en-US')).toBe('Jun 15, 2026');
  });

  it('parses ISO strings (local, no timezone suffix)', () => {
    expect(formatDate('2026-03-05T12:00:00', 'en-US')).toBe('Mar 5, 2026');
  });

  it('renders the placeholder for null, undefined, and empty input', () => {
    expect(formatDate(null, 'en-US')).toBe(EMPTY_VALUE_PLACEHOLDER);
    expect(formatDate(undefined, 'en-US')).toBe(EMPTY_VALUE_PLACEHOLDER);
    expect(formatDate('', 'en-US')).toBe(EMPTY_VALUE_PLACEHOLDER);
  });

  it('renders the placeholder for unparseable input', () => {
    expect(formatDate('not-a-date', 'en-US')).toBe(EMPTY_VALUE_PLACEHOLDER);
    expect(formatDate(new Date('not-a-date'), 'en-US')).toBe(
      EMPTY_VALUE_PLACEHOLDER,
    );
  });
});

describe('formatPercent', () => {
  it('formats simple fractions', () => {
    expect(formatPercent(0.5, 'en-US')).toBe('50%');
    expect(formatPercent(1, 'en-US')).toBe('100%');
    expect(formatPercent(0, 'en-US')).toBe('0%');
  });

  it('keeps at most one decimal', () => {
    expect(formatPercent(0.333, 'en-US')).toBe('33.3%');
    expect(formatPercent(0.3334, 'en-US')).toBe('33.3%');
  });

  it('formats negative fractions', () => {
    expect(formatPercent(-0.25, 'en-US')).toBe('-25%');
  });

  it('renders the placeholder for non-finite input', () => {
    expect(formatPercent(Number.NaN, 'en-US')).toBe(EMPTY_VALUE_PLACEHOLDER);
    expect(formatPercent(Number.POSITIVE_INFINITY, 'en-US')).toBe(
      EMPTY_VALUE_PLACEHOLDER,
    );
  });
});
