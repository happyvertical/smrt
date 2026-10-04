import { describe, expect, it } from 'vitest';
import {
  calculateInvoiceDraft,
  calculateInvoiceLine,
  calculateInvoiceMinorLine,
  type InvoiceDraftValues,
  type InvoiceLineDraft,
  resolveInvoiceLineDraft,
} from '../invoices.js';

const line: InvoiceLineDraft = {
  key: 'one',
  description: 'Consulting',
  sku: 'HOUR',
  quantity: '1.5',
  unitPrice: '19.99',
  discountType: 'flat',
  discountValue: '0',
  taxMode: 'inherit',
  taxRate: '',
};
const context = { currency: 'USD', inheritedTaxRate: '5' };
const invoice: InvoiceDraftValues = {
  customerId: 'customer',
  issuedOn: '2026-10-03',
  dueOn: '2026-11-03',
  currency: 'USD',
  paymentTerms: 'Net 30',
  taxRate: '5',
  lines: [line],
};

describe('exact general invoice calculations', () => {
  it('accepts exact trailing zeroes when changing currency without rewriting the draft', () => {
    const draft = {
      ...line,
      quantity: '1',
      unitPrice: '100.00',
      discountValue: '5.000',
      taxMode: 'override',
      taxRate: '0',
    };
    expect(
      calculateInvoiceLine(draft, { ...context, currency: 'JPY' }),
    ).toMatchObject({
      valid: true,
      grossMinor: 100,
      discountMinor: 5,
      totalMinor: 95,
    });
    expect(draft.unitPrice).toBe('100.00');
    expect(
      calculateInvoiceLine(
        { ...draft, unitPrice: '100.01' },
        { ...context, currency: 'JPY' },
      ),
    ).toMatchObject({ valid: false, errors: { unitPrice: 'precision' } });
  });
  it('rounds fractional quantities then tax to exact minor units', () => {
    expect(calculateInvoiceLine(line, context)).toEqual({
      valid: true,
      effectiveTaxRate: '5',
      grossMinor: 2999,
      discountMinor: 0,
      subtotalMinor: 2999,
      taxMinor: 150,
      totalMinor: 3149,
    });
  });
  it('distinguishes a flat discount from a percentage discount before tax', () => {
    expect(
      calculateInvoiceLine({ ...line, discountValue: '5' }, context),
    ).toMatchObject({
      valid: true,
      discountMinor: 500,
      subtotalMinor: 2499,
      taxMinor: 125,
      totalMinor: 2624,
    });
    expect(
      calculateInvoiceLine(
        { ...line, discountType: 'percent', discountValue: '5' },
        context,
      ),
    ).toMatchObject({
      valid: true,
      discountMinor: 150,
      subtotalMinor: 2849,
      taxMinor: 142,
      totalMinor: 2991,
    });
  });
  it('preserves an explicit zero override and rejects a blank override', () => {
    expect(
      calculateInvoiceLine(
        { ...line, taxMode: 'override', taxRate: '0' },
        context,
      ),
    ).toMatchObject({
      valid: true,
      effectiveTaxRate: '0',
      taxMinor: 0,
      totalMinor: 2999,
    });
    expect(
      calculateInvoiceLine(
        { ...line, taxMode: 'override', taxRate: '' },
        context,
      ),
    ).toMatchObject({ valid: false, errors: { taxRate: 'invalid-decimal' } });
    expect(
      calculateInvoiceLine(
        { ...line, taxMode: 'inherit', taxRate: 'garbage' },
        context,
      ),
    ).toMatchObject({ valid: true, effectiveTaxRate: '5' });
  });
  it.each([
    ['JPY', '1', 1, 2],
    ['USD', '0.01', 1, 2],
    ['BHD', '0.001', 1, 2],
    ['CLF', '0.0001', 1, 2],
  ])('uses currency exponent for %s rather than display locale', (currency, unitPrice, _unit, grossMinor) => {
    expect(
      calculateInvoiceLine(
        { ...line, unitPrice, taxMode: 'override', taxRate: '0' },
        { ...context, currency },
      ),
    ).toMatchObject({ valid: true, grossMinor, totalMinor: grossMinor });
  });
  it('handles decimal rates exactly at half-cent boundaries', () => {
    expect(
      calculateInvoiceLine(
        {
          ...line,
          quantity: '1',
          unitPrice: '0.50',
          taxMode: 'override',
          taxRate: '1',
        },
        context,
      ),
    ).toMatchObject({ valid: true, taxMinor: 1, totalMinor: 51 });
    expect(
      calculateInvoiceLine(
        {
          ...line,
          quantity: '1',
          unitPrice: '100',
          discountType: 'percent',
          discountValue: '12.3456',
          taxMode: 'override',
          taxRate: '7.125',
        },
        context,
      ),
    ).toMatchObject({
      valid: true,
      discountMinor: 1235,
      subtotalMinor: 8765,
      taxMinor: 625,
      totalMinor: 9390,
    });
  });
  it('does not lose a cent at the safe integer boundary', () => {
    expect(
      calculateInvoiceLine(
        {
          ...line,
          quantity: '1',
          unitPrice: '90071992547409.91',
          taxMode: 'override',
          taxRate: '0',
        },
        context,
      ),
    ).toMatchObject({
      valid: true,
      grossMinor: Number.MAX_SAFE_INTEGER,
      totalMinor: Number.MAX_SAFE_INTEGER,
    });
    expect(
      calculateInvoiceLine(
        { ...line, quantity: '1', unitPrice: '90071992547409.92' },
        context,
      ),
    ).toMatchObject({ valid: false, errors: { unitPrice: 'range' } });
  });
  it.each([
    '',
    '-1',
    '1e2',
    'Infinity',
    'NaN',
    ' 1',
    '1 ',
    '1..5',
    '0.0000001',
  ])('retains and rejects invalid quantity %j', (quantity) => {
    const draft = { ...line, quantity };
    expect(calculateInvoiceLine(draft, context).valid).toBe(false);
    expect(draft.quantity).toBe(quantity);
  });
  it.each([
    { unitPrice: '1.001' },
    { discountValue: '30' },
    { discountType: 'other' },
    { taxMode: 'other' },
    { discountType: 'percent', discountValue: '100.000001' },
    { taxMode: 'override', taxRate: '-1' },
    { taxMode: 'override', taxRate: '101' },
    { unitPrice: '90071992547409.91', quantity: '2' },
  ])('invalidates unsafe or unsupported drafts %j', (patch) => {
    expect(calculateInvoiceLine({ ...line, ...patch }, context).valid).toBe(
      false,
    );
  });
  it('allows zero quantity and a full discount without manufacturing tax', () => {
    expect(
      calculateInvoiceLine({ ...line, quantity: '0' }, context),
    ).toMatchObject({ valid: true, totalMinor: 0 });
    expect(
      calculateInvoiceLine(
        { ...line, discountType: 'percent', discountValue: '100' },
        context,
      ),
    ).toMatchObject({
      valid: true,
      subtotalMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
    });
  });
  it('adds exact line amounts and never trusts extra client totals', () => {
    expect(
      calculateInvoiceDraft({
        ...invoice,
        lines: [line, { ...line, key: 'two' }],
        totalMinor: 1,
      } as InvoiceDraftValues),
    ).toMatchObject({
      valid: true,
      grossMinor: 5998,
      subtotalMinor: 5998,
      taxMinor: 300,
      totalMinor: 6298,
    });
  });
  it.each([
    { customerId: '' },
    { issuedOn: '2026-02-30' },
    { dueOn: '2026-01-01' },
    { currency: 'usd' },
    { taxRate: '' },
    { lines: [] },
    { lines: [line, line] },
    { lines: [{ ...line, quantity: 'invalid' }] },
  ])('rejects invalid header or line membership %j', (patch) => {
    const result = calculateInvoiceDraft({ ...invoice, ...patch });
    expect(result.valid).toBe(false);
    expect(result).not.toHaveProperty('totalMinor');
  });
  it('rejects aggregate overflow even when each individual line is safe', () => {
    const large = {
      ...line,
      quantity: '1',
      unitPrice: '45035996273704.96',
      taxMode: 'override',
      taxRate: '0',
    };
    expect(
      calculateInvoiceDraft({
        ...invoice,
        lines: [large, { ...large, key: 'two' }],
      }),
    ).toMatchObject({ valid: false, errors: { total: 'range' } });
  });
  it('resolves discount and inherited tax to model fields without changing totals', () => {
    const draft = { ...line, discountType: 'percent', discountValue: '5' };
    const resolved = resolveInvoiceLineDraft(draft, context);
    expect(resolved).toEqual({
      description: 'Consulting',
      sku: 'HOUR',
      quantity: 1.5,
      unitPrice: 1999,
      discount: 150,
      taxRate: 0.05,
      amount: 2991,
    });
    expect(calculateInvoiceMinorLine(resolved)).toMatchObject({
      subtotalMinor: 2849,
      taxMinor: 142,
      totalMinor: 2991,
    });
    expect(
      resolveInvoiceLineDraft(
        { ...line, taxMode: 'override', taxRate: '0.000001' },
        context,
      ).taxRate,
    ).toBe(0.00000001);
    expect(
      resolveInvoiceLineDraft(
        { ...line, taxMode: 'override', taxRate: '1.234567' },
        context,
      ).taxRate,
    ).toBe(0.01234567);
  });
  it('refuses quantities that numeric persistence cannot represent exactly', () => {
    expect(
      calculateInvoiceLine(
        { ...line, quantity: '9007199254740990.1', unitPrice: '0' },
        context,
      ),
    ).toMatchObject({ valid: false, errors: { quantity: 'precision' } });
    expect(() =>
      resolveInvoiceLineDraft(
        { ...line, quantity: '9007199254740990.1', unitPrice: '0' },
        context,
      ),
    ).toThrow('Invalid invoice line');
  });
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
    ).toBe(-900000000011110);
    expect(
      resolveInvoiceLineDraft(
        {
          ...line,
          quantity: '10000000000.12345',
          unitPrice: '900.00',
          discountValue: '0',
          taxMode: 'override',
          taxRate: '0',
        },
        context,
      ).amount,
    ).toBe(900000000011111);
    // This distinct source decimal is lost before a Number reaches the model.
    expect(
      calculateInvoiceLine(
        { ...line, quantity: '100000000000.12345', unitPrice: '0' },
        context,
      ),
    ).toMatchObject({ valid: false, errors: { quantity: 'precision' } });
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
  it('keeps existing negative-price credit rounding toward positive infinity', () => {
    expect(
      calculateInvoiceMinorLine({
        quantity: 1.5,
        unitPrice: -1,
        discount: 0,
        taxRate: 0,
      }),
    ).toMatchObject({ grossMinor: -1, totalMinor: -1 });
    expect(
      calculateInvoiceMinorLine({
        quantity: 1,
        unitPrice: -50,
        discount: 0,
        taxRate: 0.01,
      }),
    ).toMatchObject({ taxMinor: 0, totalMinor: -50 });
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
