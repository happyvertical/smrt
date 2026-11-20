// A PostgreSQL SERVER pool returns BIGINT as digits (the SDK sets no BIGINT
// parser); PGlite returns numbers, so the PGlite suites cannot see it. These
// feed the engine's integer read and compare paths what the server returns.
import { describe, expect, it } from 'vitest';
import { same } from './data-migrations.ts';
import { postgresDialect } from './db/postgres-dialect.ts';

describe('integers a server returns as text', () => {
  const read = (v: unknown, text: string | null) => {
    const row: Record<string, unknown> = { n: v, n__text: text };
    postgresDialect.finishStoredInteger(row, 'n');
    return row;
  };
  it('a safe integer becomes a number, whether it came as digits or a number', () => {
    expect(read('5', '5')).toEqual({ n: 5 });
    expect(read(5, '5')).toEqual({ n: 5 });
    expect(read('-9007199254740991', '-9007199254740991')).toEqual({
      n: -9007199254740991,
    });
  });
  it('an unsafe integer keeps its exact digits; null stays null', () => {
    expect(read('9007199254740993', '9007199254740993')).toEqual({
      n: '9007199254740993',
    });
    expect(read(9007199254740992, '9007199254740993')).toEqual({
      n: '9007199254740993',
    });
    expect(read(null, null)).toEqual({ n: null });
  });
  it('an incoming 5 equals the stored "5", and nothing else does', () => {
    expect(same(5, '5')).toBe(true);
    expect(same('5', 5)).toBe(true);
    expect(same(5, '6')).toBe(false);
    expect(same('5', '5.0')).toBe(false);
    expect(same(null, undefined)).toBe(true);
    expect(same(5, null)).toBe(false);
  });
});
