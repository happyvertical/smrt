/**
 * Tests for the integer-cents money helpers — half-away-from-zero rounding
 * (including negatives and exact .5 cases) and cents/amount conversions.
 */

import { describe, expect, it } from 'vitest';
import {
  amountToCents,
  calculateCommissionAmountCents,
  centsToAmount,
  roundCents,
} from '../money.js';

describe('roundCents', () => {
  it('rounds exact .5 values away from zero in both directions', () => {
    expect(roundCents(2.5)).toBe(3);
    expect(roundCents(-2.5)).toBe(-3);
    expect(roundCents(0.5)).toBe(1);
    expect(roundCents(-0.5)).toBe(-1);
    expect(roundCents(7.5)).toBe(8);
    expect(roundCents(-7.5)).toBe(-8);
  });

  it('rounds sub-half fractions toward zero and super-half away', () => {
    expect(roundCents(1.4)).toBe(1);
    expect(roundCents(-1.4)).toBe(-1);
    expect(roundCents(1.6)).toBe(2);
    expect(roundCents(-1.6)).toBe(-2);
  });

  it('is the identity on integers and normalizes zero', () => {
    expect(roundCents(0)).toBe(0);
    expect(roundCents(42)).toBe(42);
    expect(roundCents(-42)).toBe(-42);
    // No negative zero leaking out of the sign arithmetic.
    expect(Object.is(roundCents(-0.4), 0)).toBe(true);
    expect(Object.is(roundCents(-0), 0)).toBe(true);
  });
});

describe('centsToAmount / amountToCents', () => {
  it('converts between cents and major units', () => {
    expect(centsToAmount(12345)).toBe(123.45);
    expect(centsToAmount(-50)).toBe(-0.5);
    expect(amountToCents(123.45)).toBe(12345);
    expect(amountToCents(-0.5)).toBe(-50);
  });

  it('amountToCents rounds half away from zero at the cent boundary', () => {
    expect(amountToCents(0.005)).toBe(1);
    expect(amountToCents(-0.005)).toBe(-1);
    // Classic float trap: 19.99 * 100 === 1998.9999999999998
    expect(amountToCents(19.99)).toBe(1999);
  });

  it('round-trips integer cents exactly', () => {
    for (const cents of [0, 1, -1, 99, -12345, 500000]) {
      expect(amountToCents(centsToAmount(cents))).toBe(cents);
    }
  });
});

describe('calculateCommissionAmountCents', () => {
  it('applies rate and defaults shareFraction to 1', () => {
    expect(calculateCommissionAmountCents(10000, 0.1)).toBe(1000);
    expect(calculateCommissionAmountCents(10000, 0.1, undefined)).toBe(1000);
  });

  it('applies the share fraction and rounds once on the final product', () => {
    // 125 * 0.1 = 12.5 → half away from zero → 13
    expect(calculateCommissionAmountCents(125, 0.1)).toBe(13);
    // 125 * 0.1 * 0.6 = 7.5 → 8; 125 * 0.1 * 0.4 = 5 → 5
    expect(calculateCommissionAmountCents(125, 0.1, 0.6)).toBe(8);
    expect(calculateCommissionAmountCents(125, 0.1, 0.4)).toBe(5);
  });

  it('handles negative bases symmetrically (clawback-style math)', () => {
    expect(calculateCommissionAmountCents(-125, 0.1)).toBe(-13);
    expect(calculateCommissionAmountCents(-10000, 0.05, 0.5)).toBe(-250);
  });
});
