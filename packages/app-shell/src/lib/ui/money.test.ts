import { describe, expect, it } from 'vitest';
import { formatMoney, inputToMinor, minorToInput } from './money.ts';

describe('money', () => {
  it('formats minor units as currency', () => {
    expect(formatMoney(123450, 'USD', 'en-US')).toBe('$1,234.50');
    expect(formatMoney(-5, 'USD', 'en-US')).toBe('-$0.05');
    expect(formatMoney(null)).toBe('');
  });

  it('round-trips through editable text', () => {
    expect(minorToInput(1250)).toBe('12.50');
    expect(minorToInput(5)).toBe('0.05');
    expect(minorToInput(-1999)).toBe('-19.99');
    expect(minorToInput(null)).toBe('');
    expect(inputToMinor('12.50')).toBe(1250);
  });

  it('parses amounts without float error', () => {
    expect(inputToMinor('19.99')).toBe(1999);
    expect(inputToMinor('0.1')).toBe(10);
    expect(inputToMinor('1,234')).toBe(123400);
    expect(inputToMinor('$7')).toBe(700);
    expect(inputToMinor('-3.5')).toBe(-350);
    expect(inputToMinor('1.005')).toBeNull();
    expect(inputToMinor('abc')).toBeNull();
    expect(inputToMinor('')).toBeNull();
  });
});
