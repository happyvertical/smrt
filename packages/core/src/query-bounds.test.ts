/**
 * Unit tests for the shared list-bounds parser (#2367).
 *
 * This is the one parser every generated read surface uses, so the cases below
 * are the exact inputs those surfaces used to mishandle: a non-numeric string
 * (`LIMIT NaN` at the driver), a deliberate `0` (folded into 50 by
 * `Number(x) || 50`), and an unbounded page size (a full table scan on a public
 * endpoint).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_LIST_ORDER_BY,
  MAX_LIST_LIMIT,
  QueryBoundsError,
  resolveListLimit,
  resolveListOffset,
} from './query-bounds';

describe('#2367 resolveListLimit', () => {
  it('defaults when the parameter is absent', () => {
    expect(resolveListLimit(null)).toBe(DEFAULT_LIST_LIMIT);
    expect(resolveListLimit(undefined)).toBe(DEFAULT_LIST_LIMIT);
    expect(resolveListLimit('')).toBe(DEFAULT_LIST_LIMIT);
  });

  it('accepts a digit string and a number', () => {
    expect(resolveListLimit('25')).toBe(25);
    expect(resolveListLimit(' 25 ')).toBe(25);
    expect(resolveListLimit(25)).toBe(25);
  });

  it('preserves an explicit 0 instead of folding it into the default', () => {
    expect(resolveListLimit('0')).toBe(0);
    expect(resolveListLimit(0)).toBe(0);
  });

  it('clamps an oversized page to the ceiling', () => {
    expect(resolveListLimit('100000000')).toBe(MAX_LIST_LIMIT);
    expect(resolveListLimit(MAX_LIST_LIMIT + 1)).toBe(MAX_LIST_LIMIT);
    expect(resolveListLimit(MAX_LIST_LIMIT)).toBe(MAX_LIST_LIMIT);
  });

  it('honours a caller-supplied ceiling and default', () => {
    expect(resolveListLimit('40', { maxValue: 10 })).toBe(10);
    expect(resolveListLimit(null, { defaultValue: 7 })).toBe(7);
    // A default above the ceiling is itself clamped.
    expect(resolveListLimit(null, { defaultValue: 90, maxValue: 10 })).toBe(10);
  });

  it.each([
    ['abc'],
    ['12abc'],
    ['1.5'],
    ['1e3'],
    ['-1'],
    ['0x10'],
    ['+5'],
    [' '],
  ])('rejects the non-numeric input %j', (raw) => {
    expect(() => resolveListLimit(raw)).toThrow(QueryBoundsError);
  });

  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 2],
  ])('rejects the out-of-contract number %j', (raw) => {
    expect(() => resolveListLimit(raw)).toThrow(QueryBoundsError);
  });

  it.each([
    [true],
    [{}],
    [[]],
    [() => 1],
  ])('rejects the non-scalar input %j', (raw) => {
    expect(() => resolveListLimit(raw)).toThrow(QueryBoundsError);
  });

  it('names the offending parameter and reports a 400', () => {
    try {
      resolveListLimit('abc');
      expect.unreachable('resolveListLimit should have thrown');
    } catch (cause) {
      expect(cause).toBeInstanceOf(QueryBoundsError);
      const error = cause as QueryBoundsError;
      expect(error.message).toContain('limit');
      expect(error.status).toBe(400);
      expect(error.publicMessage).toBe(error.message);
    }
  });
});

describe('#2367 resolveListOffset', () => {
  it('defaults to 0 and accepts any non-negative integer', () => {
    expect(resolveListOffset(null)).toBe(0);
    expect(resolveListOffset('500000')).toBe(500_000);
  });

  it('is not capped by the limit ceiling', () => {
    expect(resolveListOffset(MAX_LIST_LIMIT * 10)).toBe(MAX_LIST_LIMIT * 10);
  });

  it('rejects a malformed offset and names it', () => {
    expect(() => resolveListOffset('abc')).toThrow(/offset/);
  });
});

describe('#2367 DEFAULT_LIST_ORDER_BY', () => {
  it('orders by creation time with a total-order tiebreak', () => {
    // Both terms matter: `created_at DESC` alone still ties for rows created in
    // the same tick, which is what makes LIMIT/OFFSET paging skip and repeat.
    expect(DEFAULT_LIST_ORDER_BY).toEqual(['created_at DESC', 'id ASC']);
  });
});
