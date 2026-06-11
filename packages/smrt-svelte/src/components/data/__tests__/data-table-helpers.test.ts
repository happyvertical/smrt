/**
 * Unit tests for DataTable sort/accessor helpers (coverage uplift, S6 gate).
 */
import { describe, expect, it } from 'vitest';
import { defaultSort, getNestedValue } from '../types';

describe('getNestedValue', () => {
  it('reads dot-notation paths', () => {
    expect(getNestedValue({ a: { b: 5 } }, 'a.b')).toBe(5);
    expect(getNestedValue({ a: 1 }, 'a')).toBe(1);
  });

  it('returns undefined for missing paths / non-objects', () => {
    expect(getNestedValue({ a: 1 }, 'x.y')).toBeUndefined();
    expect(getNestedValue(null, 'a')).toBeUndefined();
  });
});

describe('defaultSort', () => {
  it('returns 0 when direction is null', () => {
    expect(defaultSort({ a: 1 }, { a: 2 }, 'a', null)).toBe(0);
  });

  it('sorts numbers by direction', () => {
    expect(defaultSort({ a: 1 }, { a: 2 }, 'a', 'asc')).toBeLessThan(0);
    expect(defaultSort({ a: 1 }, { a: 2 }, 'a', 'desc')).toBeGreaterThan(0);
  });

  it('sorts strings and dates', () => {
    expect(
      defaultSort({ a: 'apple' }, { a: 'banana' }, 'a', 'asc'),
    ).toBeLessThan(0);
    expect(
      defaultSort({ a: new Date(1) }, { a: new Date(2) }, 'a', 'asc'),
    ).toBeLessThan(0);
  });

  it('handles nullish values', () => {
    expect(defaultSort({ a: null }, { a: 1 }, 'a', 'asc')).toBeGreaterThan(0);
    expect(defaultSort({ a: 1 }, { a: null }, 'a', 'asc')).toBeLessThan(0);
    expect(defaultSort({ a: null }, { a: null }, 'a', 'asc')).toBe(0);
  });

  it('falls back to string compare for mixed types', () => {
    expect(typeof defaultSort({ a: true }, { a: false }, 'a', 'asc')).toBe(
      'number',
    );
  });
});
