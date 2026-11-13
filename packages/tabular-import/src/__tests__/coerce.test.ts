import { describe, expect, it } from 'vitest';
import { coerceCell, type PlanField } from '../index.js';
import { cellOf, day } from './helpers.js';

const field = (
  type: PlanField['type'],
  extra: Partial<PlanField> = {},
): PlanField => ({
  key: 'f',
  label: 'F',
  type,
  column: 1,
  ...extra,
});
const c = (spec: Parameters<typeof cellOf>[0]) => cellOf(spec);
const value = (cell: ReturnType<typeof cellOf>, f: PlanField) => {
  const result = coerceCell(cell, f);
  return result.ok ? result.value : `refused:${result.code}`;
};

describe('coerceCell', () => {
  it('turns blanks into null for every type', () => {
    for (const type of [
      'text',
      'number',
      'integer',
      'boolean',
      'date',
      'money',
    ] as const) {
      expect(
        coerceCell(
          undefined,
          field(type, { money: { currency: 'USD', scale: 2 } }),
        ),
      ).toEqual({ ok: true, value: null });
    }
    expect(
      coerceCell({ value: '   ', type: 'text' }, field('integer')),
    ).toEqual({ ok: true, value: null });
    expect(coerceCell({ value: '   ', type: 'text' }, field('text'))).toEqual({
      ok: true,
      value: '   ',
    });
  });

  it('refuses error cells with the Excel text, for every type', () => {
    const error = { value: null, type: 'error' as const, error: '#N/A' };
    for (const type of ['text', 'number', 'date'] as const) {
      expect(coerceCell(error, field(type))).toEqual({
        ok: false,
        code: 'cell-error',
        detail: '#N/A',
      });
    }
  });

  it('text: strings as-is, numbers as typed or shortest, dates as ISO', () => {
    expect(value(c('  x '), field('text'))).toBe('  x ');
    expect(
      value({ value: 5, type: 'number', originalText: '5.0' }, field('text')),
    ).toBe('5.0');
    expect(value(c(0.1), field('text'))).toBe('0.1');
    expect(value(c(1e21), field('text'))).toBe('1000000000000000000000');
    expect(value(c(1e-7), field('text'))).toBe('0.0000001');
    expect(value(c(day('2024-02-29')), field('text'))).toBe('2024-02-29');
  });

  it('integer: only safe whole numbers', () => {
    expect(value(c(4), field('integer'))).toBe(4);
    expect(value(c('12'), field('integer'))).toBe(12);
    expect(value(c(4.5), field('integer'))).toBe('refused:not-integer');
    expect(value(c(2 ** 53), field('integer'))).toBe('refused:unsafe-integer');
    expect(value(c('12345678901234567'), field('integer'))).toBe(
      'refused:unsafe-integer',
    );
    expect(value(c('007'), field('integer'))).toBe('refused:not-integer');
    expect(value(c('abc'), field('integer'))).toBe('refused:not-integer');
    expect(value(c(Number.POSITIVE_INFINITY), field('integer'))).toBe(
      'refused:not-integer',
    );
    expect(Object.is(value(c(-0), field('integer')), 0)).toBe(true);
  });

  it('number: finite only', () => {
    expect(value(c(1.25), field('number'))).toBe(1.25);
    expect(value(c('-0.5'), field('number'))).toBe(-0.5);
    expect(value(c(Number.NaN), field('number'))).toBe('refused:not-number');
    expect(value(c(true), field('number'))).toBe('refused:not-number');
    expect(value(c(day('2024-01-01')), field('number'))).toBe(
      'refused:not-number',
    );
  });

  it('boolean: true/false and yes/no/y/n/1/0 in any case', () => {
    for (const yes of ['Yes', 'Y', 'TRUE', ' true ', '1'])
      expect(value(c(yes), field('boolean'))).toBe(true);
    for (const no of ['No', 'n', 'False', '0'])
      expect(value(c(no), field('boolean'))).toBe(false);
    expect(value(c(1), field('boolean'))).toBe(true);
    expect(value(c(false), field('boolean'))).toBe(false);
    expect(value(c('maybe'), field('boolean'))).toBe('refused:not-boolean');
    expect(value(c(2), field('boolean'))).toBe('refused:not-boolean');
  });

  it('date: date cells and ISO text only', () => {
    expect(value(c(day('2024-12-31')), field('date'))).toBe('2024-12-31');
    expect(value(c('2024-02-29'), field('date'))).toBe('2024-02-29');
    expect(value(c('2024-02-29T10:00:00Z'), field('date'))).toBe('2024-02-29');
    expect(value(c('2023-02-29'), field('date'))).toBe('refused:not-date');
    expect(value(c('03/04/2024'), field('date'))).toBe('refused:not-date');
    expect(value(c(45000), field('date'))).toBe('refused:not-date');
  });

  it('money: integer minor units, refusing fractions of a minor unit', () => {
    const usd = field('money', { money: { currency: 'USD', scale: 2 } });
    expect(value(c(19.99), usd)).toBe(1999);
    expect(value(c(0.07), usd)).toBe(7);
    expect(value(c('1200'), usd)).toBe(120000);
    expect(value(c(10.005), usd)).toBe('refused:not-money');
    expect(value(c(Number('90071992547409.93')), usd)).toBe(
      'refused:not-money',
    );
    expect(
      value(c(5), field('money', { money: { currency: 'JPY', scale: 0 } })),
    ).toBe(5);
  });

  it('choice: exact match after trim', () => {
    const f = field('choice', { choices: ['new', 'used'] });
    expect(value(c(' used '), f)).toBe('used');
    expect(value(c('Used'), f)).toBe('refused:not-choice');
    expect(value(c('other'), f)).toBe('refused:not-choice');
  });
});
