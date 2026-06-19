import { describe, expect, it } from 'vitest';
import { validateCronExpression } from '../schedule-runner.js';

/**
 * Regression for S5 audit #1402 (LOW): the cron parser previously accepted
 * out-of-range fields (e.g. minute=70), which never match and force a full
 * ~525k-minute scan. Validate field ranges up front instead.
 */
describe('validateCronExpression', () => {
  it('accepts valid expressions', () => {
    expect(validateCronExpression('* * * * *')).toHaveLength(5);
    expect(validateCronExpression('0 0 1 1 0')).toHaveLength(5);
    expect(validateCronExpression('*/15 9-17 * * 1-5')).toHaveLength(5);
    // day-of-week accepts 0-7 (both 0 and 7 are Sunday)
    expect(validateCronExpression('0 0 * * 7')).toHaveLength(5);
  });

  it('rejects the wrong field count', () => {
    expect(() => validateCronExpression('* * * *')).toThrow(/expected 5/);
    expect(() => validateCronExpression('* * * * * *')).toThrow(/expected 5/);
  });

  it('rejects out-of-range minute', () => {
    expect(() => validateCronExpression('70 * * * *')).toThrow(
      /minute field "70" is out of range/,
    );
  });

  it('rejects out-of-range hour, day, month, and day-of-week', () => {
    expect(() => validateCronExpression('0 24 * * *')).toThrow(/hour field/);
    expect(() => validateCronExpression('0 0 32 * *')).toThrow(
      /day-of-month field/,
    );
    expect(() => validateCronExpression('0 0 1 13 *')).toThrow(/month field/);
    expect(() => validateCronExpression('0 0 * * 8')).toThrow(
      /day-of-week field/,
    );
  });

  it('rejects out-of-range values inside ranges, lists and steps', () => {
    expect(() => validateCronExpression('0-70 * * * *')).toThrow(/minute/);
    expect(() => validateCronExpression('1,2,99 * * * *')).toThrow(/minute/);
    expect(() => validateCronExpression('*/0 * * * *')).toThrow(/invalid step/);
    expect(() => validateCronExpression('30-10 * * * *')).toThrow(
      /inverted range/,
    );
  });

  it('rejects non-numeric field values', () => {
    expect(() => validateCronExpression('abc * * * *')).toThrow(/minute/);
  });

  // Regression for S5 audit #1402 (Copilot, round 3): split('/')/split('-')
  // without a segment-count check silently parsed `1/2/3` as `1/2` and
  // `1-2-3` as `1-2`, dropping trailing segments and accepting malformed
  // expressions. Validation must reject extra separators outright.
  it('rejects malformed step syntax with multiple slashes', () => {
    expect(() => validateCronExpression('1/2/3 * * * *')).toThrow(
      /malformed step syntax/,
    );
    expect(() => validateCronExpression('*/2/3 * * * *')).toThrow(
      /malformed step syntax/,
    );
  });

  it('rejects malformed range syntax with multiple dashes', () => {
    expect(() => validateCronExpression('1-2-3 * * * *')).toThrow(
      /malformed range syntax/,
    );
  });

  it('rejects empty range parts', () => {
    expect(() => validateCronExpression('1- * * * *')).toThrow(
      /malformed range syntax|empty range part/,
    );
    expect(() => validateCronExpression('-5 * * * *')).toThrow(
      /malformed range syntax|empty range part/,
    );
  });
});
