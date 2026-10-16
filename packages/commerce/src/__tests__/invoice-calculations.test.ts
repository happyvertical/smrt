import { describe, expect, it } from 'vitest';
import { calculateInvoiceMinorLine } from '../invoices.js';

describe('exact invoice minor-unit line calculation', () => {
  it('preserves canonical large fractional quantities without toFixed rounding', () => {
    const input = {
      quantity: 10000000000.12345,
      unitPrice: 90000,
      discount: 0,
      taxRate: 0,
    };
    expect(calculateInvoiceMinorLine(input).totalMinor).toBe(900000000011111);
    expect(
      calculateInvoiceMinorLine({ ...input, unitPrice: -90000 }).totalMinor,
    ).toBe(-900000000011111);
  });
  it('expands supported canonical exponent rates and retains precision limits', () => {
    expect(
      calculateInvoiceMinorLine({
        quantity: 1e-6,
        unitPrice: 100000000,
        discount: 0,
        taxRate: 0,
      }).totalMinor,
    ).toBe(100);
    expect(
      calculateInvoiceMinorLine({
        quantity: 1,
        unitPrice: 100000000,
        discount: 0,
        taxRate: 1e-8,
      }).taxMinor,
    ).toBe(1);
    expect(
      calculateInvoiceMinorLine({
        quantity: 1,
        unitPrice: 10000000,
        discount: 0,
        taxRate: 1e-7,
      }).taxMinor,
    ).toBe(1);
    for (const quantity of [1e-7, 1.0000001, 1.0000000000000002])
      expect(() =>
        calculateInvoiceMinorLine({
          quantity,
          unitPrice: 1,
          discount: 0,
          taxRate: 0,
        }),
      ).toThrow(RangeError);
    for (const taxRate of [1e-9, 0.123456789])
      expect(() =>
        calculateInvoiceMinorLine({
          quantity: 1,
          unitPrice: 1,
          discount: 0,
          taxRate,
        }),
      ).toThrow(RangeError);
  });
  it('rounds credit ties symmetrically with their positive counterparts', () => {
    expect(
      calculateInvoiceMinorLine({
        quantity: 1.5,
        unitPrice: -1,
        discount: 0,
        taxRate: 0,
      }),
    ).toMatchObject({ grossMinor: -2, totalMinor: -2 });
    expect(
      calculateInvoiceMinorLine({
        quantity: 1,
        unitPrice: -50,
        discount: 0,
        taxRate: 0.01,
      }),
    ).toMatchObject({ taxMinor: -1, totalMinor: -51 });
  });
  it('applies a signed amount discount that carries the gross sign', () => {
    const positive = calculateInvoiceMinorLine({
      quantity: 1,
      unitPrice: 100,
      discount: 10,
      taxRate: 0.05,
    });
    const negative = calculateInvoiceMinorLine({
      quantity: 1,
      unitPrice: -100,
      discount: -10,
      taxRate: 0.05,
    });
    expect(positive).toMatchObject({
      grossMinor: 100,
      discountMinor: 10,
      subtotalMinor: 90,
      taxMinor: 5,
      totalMinor: 95,
    });
    expect(negative).toMatchObject({
      grossMinor: -100,
      discountMinor: -10,
      subtotalMinor: -90,
      taxMinor: -5,
      totalMinor: -95,
    });
    for (const key of Object.keys(positive) as Array<keyof typeof positive>)
      expect(negative[key] + positive[key]).toBe(0);
  });
  it.each([
    { quantity: 0.0000001, unitPrice: 1, discount: 0, taxRate: 0 },
    { quantity: 1, unitPrice: 1.5, discount: 0, taxRate: 0 },
    { quantity: 1, unitPrice: 1, discount: -1, taxRate: 0 },
    { quantity: 1, unitPrice: 1, discount: 0, taxRate: 0.000000001 },
    { quantity: 1, unitPrice: 1, discount: 0, taxRate: 1.01 },
    {
      quantity: 2,
      unitPrice: Number.MAX_SAFE_INTEGER,
      discount: 0,
      taxRate: 0,
    },
  ])('rejects invalid model inputs before persistence %j', (input) => {
    expect(() => calculateInvoiceMinorLine(input)).toThrow(RangeError);
  });
});
