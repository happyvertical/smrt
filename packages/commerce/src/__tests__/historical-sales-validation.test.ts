import { describe, expect, it } from 'vitest';
import type {
  HistoricalSalesMoneyFacts,
  HistoricalSalesSource,
} from '../historical-sales-types.js';
import {
  historicalSalesMagnitudes,
  validateHistoricalSalesMoneyFacts,
  validateHistoricalSalesSource,
} from '../historical-sales-validation.js';

const facts = (): HistoricalSalesMoneyFacts => ({
  currency: 'CAD',
  kind: 'invoice',
  polarity: 'magnitudes',
  netMinor: 10000,
  taxMinor: 501,
  grossMinor: 10501,
  taxComponents: null,
  detail: { kind: 'header-only' },
});
const source = (): HistoricalSalesSource => ({
  namespace: 'invented-history',
  key: 'original-1',
  version: 'v1',
  issuedOn: '2020-02-29',
  dueOn: null,
  timeZone: 'America/Edmonton',
  approval: null,
});
const line = (sourceKey = 'line-1', netMinor = 10000) => ({
  sourceKey,
  creditedLineId: null,
  description: 'Invented historical line',
  netMinor,
  taxMinor: null,
  grossMinor: null,
  quantityText: null,
  unitRateText: null,
  sourceFields: { basis_amount: '100.00', rate: '' },
});
describe('historical sales factual validation', () => {
  it('retains the counterexample exact header without inventing rate, lines, or classification', () => {
    expect(validateHistoricalSalesMoneyFacts(facts())).toEqual(facts());
    expect(historicalSalesMagnitudes(facts())).toEqual({
      netMinor: 10000,
      taxMinor: 501,
      grossMinor: 10501,
    });
  });
  it('preserves unknown source dates/approval separately from exact known source identity', () => {
    expect(validateHistoricalSalesSource(source())).toEqual(source());
  });
  it('retains signed original credit facts under an explicit polarity without modifying them', () => {
    const input = {
      ...facts(),
      kind: 'credit_note' as const,
      polarity: 'signed' as const,
      netMinor: -10000,
      taxMinor: -501,
      grossMinor: -10501,
    };
    expect(validateHistoricalSalesMoneyFacts(input)).toEqual(input);
    expect(historicalSalesMagnitudes(input)).toEqual({
      netMinor: 10000,
      taxMinor: 501,
      grossMinor: 10501,
    });
  });
  it('accepts genuine signed adjustment lines while leaving unknown line tax nullable', () => {
    const input = {
      ...facts(),
      detail: {
        kind: 'lines' as const,
        lines: [line('positive', 11000), line('adjustment', -1000)],
      },
    };
    const original = JSON.stringify(input);
    expect(validateHistoricalSalesMoneyFacts(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(original);
  });
  it.each([
    { grossMinor: 10500 },
    { netMinor: 1.1 },
    { taxMinor: NaN },
    { grossMinor: Number.MAX_SAFE_INTEGER + 1 },
    { currency: 'cad' },
    { kind: 'unknown' },
    { polarity: undefined },
  ])('rejects invalid source facts without tolerance or defaults', (change) => {
    expect(() =>
      validateHistoricalSalesMoneyFacts({
        ...facts(),
        ...change,
      } as HistoricalSalesMoneyFacts),
    ).toThrow('exact supported source facts');
  });
  it('does not infer polarity from negative values', () => {
    expect(() =>
      validateHistoricalSalesMoneyFacts({
        ...facts(),
        netMinor: -10000,
        taxMinor: -501,
        grossMinor: -10501,
      }),
    ).toThrow();
    expect(() =>
      validateHistoricalSalesMoneyFacts({
        ...facts(),
        kind: 'credit_note',
        polarity: 'signed',
      }),
    ).toThrow();
  });
  it('requires exact line sums and complete known breakdown sums', () => {
    expect(() =>
      validateHistoricalSalesMoneyFacts({
        ...facts(),
        detail: { kind: 'lines', lines: [line('wrong', 9999)] },
      }),
    ).toThrow();
    expect(() =>
      validateHistoricalSalesMoneyFacts({
        ...facts(),
        detail: {
          kind: 'lines',
          lines: [{ ...line(), taxMinor: 500, grossMinor: 10500 }],
        },
      }),
    ).toThrow();
    expect(() =>
      validateHistoricalSalesMoneyFacts({
        ...facts(),
        detail: {
          kind: 'lines',
          lines: [{ ...line(), taxMinor: 501, grossMinor: 10500 }],
        },
      }),
    ).toThrow();
  });
  it('rejects duplicate source children instead of merging them', () => {
    expect(() =>
      validateHistoricalSalesMoneyFacts({
        ...facts(),
        detail: {
          kind: 'lines',
          lines: [line('duplicate', 5000), line('duplicate', 5000)],
        },
      }),
    ).toThrow();
  });
  it('preserves source quantity/rate text and string-only descriptors without evaluating them', () => {
    const child = {
      ...line(),
      quantityText: '0.0000',
      unitRateText: '12.345600',
      sourceFields: { rate: '0.0500', type: 'retained-source' },
    };
    expect(
      validateHistoricalSalesMoneyFacts({
        ...facts(),
        detail: { kind: 'lines', lines: [child] },
      }).detail,
    ).toEqual({ kind: 'lines', lines: [child] });
  });
  it('retains known component amounts without inferring percent or a classification', () => {
    const taxComponents = [
      {
        sourceKey: 'tax-1',
        label: 'Original tax',
        amountMinor: 501,
        classification: null,
        taxCodeId: null,
        taxComponentId: null,
        taxableMinor: null,
        netMinor: null,
        liabilityAccountId: null,
      },
    ];
    expect(
      validateHistoricalSalesMoneyFacts({ ...facts(), taxComponents })
        .taxComponents,
    ).toEqual(taxComponents);
    expect(() =>
      validateHistoricalSalesMoneyFacts({
        ...facts(),
        taxComponents: [{ ...taxComponents[0], amountMinor: 500 }],
      }),
    ).toThrow();
    expect(() =>
      validateHistoricalSalesMoneyFacts({
        ...facts(),
        taxComponents: [{ ...taxComponents[0], classification: 'exempt' }],
      }),
    ).toThrow();
  });
  it.each([
    { issuedOn: '2026-02-30' },
    { dueOn: 'not-a-date' },
    { timeZone: 'PRIVATE_INVALID_ZONE' },
    { approval: undefined },
    { namespace: ' ambiguous ' },
  ])('rejects missing/invalid original metadata without echoing private values', (change) => {
    expect(() =>
      validateHistoricalSalesSource({
        ...source(),
        ...change,
      } as HistoricalSalesSource),
    ).toThrow('exact supported source facts');
  });
});
