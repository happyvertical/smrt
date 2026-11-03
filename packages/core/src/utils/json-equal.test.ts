import { describe, expect, it } from 'vitest';
import { jsonValuesEqual, parseJsonContainerText } from './json-equal';

describe('jsonValuesEqual (#4604)', () => {
  it('compares plain objects key-order-insensitively, recursively', () => {
    expect(
      jsonValuesEqual(
        { a: 1, b: { c: [1, { d: 'x', e: null }] } },
        { b: { c: [1, { e: null, d: 'x' }] }, a: 1 },
      ),
    ).toBe(true);
    expect(jsonValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonValuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('keeps array order significant', () => {
    expect(jsonValuesEqual([1, 2], [1, 2])).toBe(true);
    expect(jsonValuesEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonValuesEqual([1], [1, 1])).toBe(false);
    expect(jsonValuesEqual([], {})).toBe(false);
    // Holes are not skipped: `[ , ]` persists as `[null]`, not `[42]`.
    // biome-ignore lint/suspicious/noSparseArray: the sparse array is the case under test.
    expect(jsonValuesEqual([, 1], [42, 1])).toBe(false);
    expect(jsonValuesEqual(new Array(1), [42])).toBe(false);
  });

  it('treats undefined-valued keys as absent but null as a value', () => {
    expect(jsonValuesEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(jsonValuesEqual({ a: null }, {})).toBe(false);
    expect(jsonValuesEqual({ a: null }, { a: undefined })).toBe(false);
    expect(jsonValuesEqual(null, undefined)).toBe(false);
  });

  it('matches object keys as own properties only (__proto__)', () => {
    const parsed = JSON.parse('{"__proto__":{}}');
    expect(jsonValuesEqual(parsed, { other: {} })).toBe(false);
    expect(jsonValuesEqual({ other: {} }, parsed)).toBe(false);
    expect(jsonValuesEqual(parsed, JSON.parse('{"__proto__":{}}'))).toBe(true);
  });

  it('does not coerce between numbers, strings, and booleans', () => {
    expect(jsonValuesEqual({ a: 1 }, { a: '1' })).toBe(false);
    expect(jsonValuesEqual([0], [false])).toBe(false);
  });

  it('compares dates by instant or by their JSON ISO string', () => {
    const iso = '2026-11-02T10:00:00.000Z';
    expect(jsonValuesEqual(new Date(iso), new Date(iso))).toBe(true);
    expect(jsonValuesEqual({ at: new Date(iso) }, { at: iso })).toBe(true);
    expect(jsonValuesEqual({ at: new Date(iso) }, { at: '2026-11-02' })).toBe(
      false,
    );
    expect(jsonValuesEqual(new Date('nope'), new Date('nope'))).toBe(false);
  });

  it('reports cyclic values unequal instead of overflowing', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const b: Record<string, unknown> = {};
    b.self = b;
    expect(jsonValuesEqual(a, b)).toBe(false);
  });
});

describe('parseJsonContainerText', () => {
  it('parses object/array JSON text and leaves everything else alone', () => {
    expect(parseJsonContainerText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonContainerText(' [1] ')).toEqual([1]);
    expect(parseJsonContainerText('"x"')).toBe('"x"');
    expect(parseJsonContainerText('{oops')).toBe('{oops');
    expect(parseJsonContainerText(5)).toBe(5);
  });

  it('leaves text with numbers a double cannot hold exactly unparsed', () => {
    const text = '{"id":9007199254740993}';
    expect(parseJsonContainerText(text)).toBe(text);
  });
});
