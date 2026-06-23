/**
 * Unit tests for the pure utility helpers in `src/lib/utils/index.ts`.
 *
 * These functions have no database dependency — they're imported and
 * asserted directly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('removes punctuation while folding accented letters to ASCII', () => {
    // NFKD decomposes "é" into "e" + combining mark; the mark is not a
    // letter/number so it is stripped, leaving the readable ASCII base.
    expect(slugify('Café & Crème (2024)')).toBe('cafe-creme-2024');
  });

  it('strips underscores (not Unicode letters or numbers) but keeps digits', () => {
    expect(slugify('SKU_001 Variant')).toBe('sku001-variant');
  });

  // Regression: a CJK/Cyrillic-only title must NOT collapse to an empty
  // string. The previous ASCII-only `[^\w ]` regex stripped every
  // non-Latin character, so a title like "已经" produced "" and every such
  // product collided on the (slug, context, _meta_type) unique index.
  it('preserves CJK characters instead of producing an empty slug', () => {
    expect(slugify('已经')).toBe('已经');
    expect(slugify('已经 Cotton')).toBe('已经-cotton');
  });

  it('preserves Cyrillic letters', () => {
    expect(slugify('Привет Мир')).toBe('привет-мир');
  });

  // Regression: leading/trailing punctuation used to leave dangling hyphens
  // (e.g. "-trim-me-"); they must be trimmed off both ends.
  it('trims leading and trailing hyphens left by edge punctuation', () => {
    expect(slugify('--Trim Me--')).toBe('trim-me');
    expect(slugify('!!!Edge!!!')).toBe('edge');
  });

  it('returns an empty string for input with no letters or numbers', () => {
    expect(slugify('   ')).toBe('');
    expect(slugify('—–-')).toBe('');
  });
});

describe('generateId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a non-empty base36 string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    // Derived from Math.random().toString(36) — only [0-9a-z], no separators.
    expect(id).toMatch(/^[0-9a-z]+$/);
  });

  it('derives distinct ids from distinct random seeds', () => {
    // Assert the mapping deterministically rather than relying on the
    // (astronomically unlikely but nonzero) chance that two real random
    // draws collide, which would make this test flaky.
    const seed = vi.spyOn(Math, 'random');
    seed.mockReturnValueOnce(0.123456789);
    const a = generateId();
    seed.mockReturnValueOnce(0.987654321);
    const b = generateId();
    expect(a).not.toBe(b);
  });
});
