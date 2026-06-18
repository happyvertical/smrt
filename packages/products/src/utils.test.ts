/**
 * Unit tests for the pure utility helpers in `src/lib/utils/index.ts`.
 *
 * These functions have no database dependency — they're imported and
 * asserted directly.
 */

import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatPrice,
  generateId,
  slugify,
} from './lib/utils/index.js';

describe('formatPrice', () => {
  it('formats a fractional amount as a USD currency string', () => {
    expect(formatPrice(1234.5)).toBe('$1,234.50');
  });

  it('formats whole-dollar amounts with two trailing decimals', () => {
    expect(formatPrice(10)).toBe('$10.00');
  });

  it('formats zero as $0.00', () => {
    expect(formatPrice(0)).toBe('$0.00');
  });

  it('renders negative amounts with a leading minus sign', () => {
    expect(formatPrice(-5.25)).toBe('-$5.25');
  });
});

describe('formatDate', () => {
  it('formats a Date instance into a short, human-readable date', () => {
    // Construct with explicit local Y/M/D so the formatted output is
    // independent of the running machine's timezone.
    const date = new Date(2024, 0, 15); // 15 Jan 2024, local time
    expect(formatDate(date)).toBe('Jan 15, 2024');
  });

  it('formats an ISO date string the same way as the equivalent Date', () => {
    // A date-only ISO string is parsed as UTC midnight; assert against the
    // Intl-formatted equivalent so the test is timezone-independent.
    const input = '2024-01-15';
    const expected = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(input));
    expect(formatDate(input)).toBe(expected);
  });
});

describe('slugify', () => {
  it('lowercases, strips punctuation, and converts spaces to hyphens', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });

  it('collapses runs of spaces into a single hyphen', () => {
    expect(slugify('Organic   Cotton')).toBe('organic-cotton');
  });

  it('removes punctuation that is not a word character or space', () => {
    expect(slugify('Café & Crème (2024)')).toBe('caf-crme-2024');
  });

  it('preserves underscores and digits as word characters', () => {
    expect(slugify('SKU_001 Variant')).toBe('sku_001-variant');
  });
});

describe('generateId', () => {
  it('returns a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns different values across calls', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
  });
});
