import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  assertIsoDate,
  dateWithin,
  isIsoDate,
} from '../dates.js';
import { HrError } from '../types.js';

describe('calendar dates', () => {
  it('accepts only real calendar dates written YYYY-MM-DD', () => {
    for (const date of ['2026-01-05', '2024-02-29', '2000-02-29', '9999-12-31'])
      expect(isIsoDate(date), date).toBe(true);
    for (const value of [
      '2026-02-30',
      '2025-02-29',
      '1900-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-1-5',
      '05/01/2026',
      '2026-01-05T00:00:00Z',
      ' 2026-01-05',
      '',
      null,
      undefined,
      20260105,
      new Date('2026-01-05'),
    ])
      expect(isIsoDate(value), String(value)).toBe(false);
  });

  it('returns a valid date and names the field when it rejects one', () => {
    expect(assertIsoDate('startedOn', '2026-01-05')).toBe('2026-01-05');
    let thrown: unknown;
    try {
      assertIsoDate('startedOn', '2026-02-30');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HrError);
    expect(thrown).toMatchObject({
      code: 'HR_INVALID',
      message: expect.stringContaining('startedOn'),
    });
    expect(() => assertIsoDate('on', undefined)).toThrow(HrError);
  });

  it('adds and subtracts days across month, year and leap-day boundaries', () => {
    expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
    expect(addDays('2026-06-01', 30)).toBe('2026-07-01');
    expect(addDays('2026-06-01', 0)).toBe('2026-06-01');
    expect(() => addDays('2026-02-30', 1)).toThrow(HrError);
  });

  it('adds months and clamps to the end of a shorter month, leap years included', () => {
    expect(addMonths('2026-03-01', 36)).toBe('2029-03-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2023-12-31', 2)).toBe('2024-02-29');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2024-02-29', 48)).toBe('2028-02-29');
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30');
    expect(addMonths('2026-10-31', 3)).toBe('2027-01-31');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-05-15', 0)).toBe('2026-05-15');
    expect(() => addMonths('yesterday', 1)).toThrow(HrError);
  });

  it('treats a range as inclusive at both ends and open when it has no end', () => {
    expect(dateWithin('2026-01-05', '2026-01-05', '2026-03-31')).toBe(true);
    expect(dateWithin('2026-03-31', '2026-01-05', '2026-03-31')).toBe(true);
    expect(dateWithin('2026-01-04', '2026-01-05', '2026-03-31')).toBe(false);
    expect(dateWithin('2026-04-01', '2026-01-05', '2026-03-31')).toBe(false);
    expect(dateWithin('2026-01-05', '2026-01-05', '2026-01-05')).toBe(true);
    expect(dateWithin('2040-01-01', '2026-01-05', null)).toBe(true);
    expect(dateWithin('2026-01-04', '2026-01-05', null)).toBe(false);
  });
});
