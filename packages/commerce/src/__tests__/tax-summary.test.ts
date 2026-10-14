import { describe, expect, it } from 'vitest';
import { aggregateTaxSummary, type TaxSummaryInput } from '../tax-summary.js';

const tenantId = 'tenant-a';
const period = { tenantId, from: '2026-09-01', to: '2026-09-30' };
const input = (overrides: Partial<TaxSummaryInput> = {}): TaxSummaryInput => ({
  ...period,
  facts: [],
  expenses: [],
  expenseComponentMappings: [
    {
      tenantId,
      expenseCode: 'gst',
      taxComponentId: 'gst',
      componentName: 'GST',
      liabilityAccountId: 'gst-payable',
    },
  ],
  ledgerMovements: [],
  ...overrides,
});
const fact = (overrides: Partial<TaxSummaryInput['facts'][number]> = {}) => ({
  tenantId,
  documentId: 'A',
  documentKind: 'invoice' as const,
  issueDate: '2026-09-15',
  status: 'sent',
  direction: 'sales' as const,
  currency: 'CAD',
  taxCodeId: 'gst-pst',
  taxCodeKind: 'taxable' as const,
  taxableMinor: 114_498,
  taxMinor: 5_725,
  recoverableMinor: 0,
  taxComponentId: 'gst',
  componentName: 'GST',
  liabilityAccountId: 'gst-payable',
  ...overrides,
});

describe('aggregateTaxSummary', () => {
  it('reproduces the A–E stored-fact golden cases without double-counting multi-component sales base', () => {
    const result = aggregateTaxSummary(
      input({
        facts: [
          fact(),
          fact({
            taxComponentId: 'pst',
            componentName: 'PST',
            liabilityAccountId: 'pst-payable',
            taxMinor: 2_345,
          }),
          fact({ documentId: 'B', taxableMinor: 107_052, taxMinor: 5_352 }),
          fact({
            documentId: 'B',
            taxableMinor: 107_052,
            taxComponentId: 'pst',
            componentName: 'PST',
            liabilityAccountId: 'pst-payable',
            taxMinor: 2_094,
          }),
          fact({
            documentId: 'C',
            taxCodeId: 'zero',
            taxCodeKind: 'zero-rated',
            taxableMinor: 114_498,
            taxMinor: 0,
            taxComponentId: null,
            componentName: null,
            liabilityAccountId: null,
          }),
          fact({
            documentId: 'D',
            taxCodeId: 'exempt',
            taxCodeKind: 'exempt',
            taxableMinor: 114_498,
            taxMinor: 0,
            taxComponentId: null,
            componentName: null,
            liabilityAccountId: null,
          }),
          fact({
            documentId: 'E',
            taxCodeId: 'none',
            taxCodeKind: 'out-of-scope',
            taxableMinor: 1_000,
            taxMinor: 0,
            taxComponentId: null,
            componentName: null,
            liabilityAccountId: null,
          }),
        ],
        ledgerMovements: [
          {
            tenantId,
            entryId: 'manual-gst',
            accountId: 'gst-payable',
            currency: 'CAD',
            creditMinusDebit: 11_077,
          },
          {
            tenantId,
            entryId: 'manual-pst',
            accountId: 'pst-payable',
            currency: 'CAD',
            creditMinusDebit: 4_439,
          },
        ],
      }),
    );
    expect(result.kindRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxCodeKind: 'taxable',
          taxableMinor: 221_550,
          documentCount: 2,
        }),
        expect.objectContaining({
          taxCodeKind: 'zero-rated',
          taxableMinor: 114_498,
        }),
        expect.objectContaining({
          taxCodeKind: 'exempt',
          taxableMinor: 114_498,
        }),
        expect.objectContaining({
          taxCodeKind: 'out-of-scope',
          taxableMinor: 1_000,
        }),
      ]),
    );
    expect(result.componentRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxComponentId: 'gst',
          collectedMinor: 11_077,
          netTaxMinor: 11_077,
        }),
        expect.objectContaining({
          taxComponentId: 'pst',
          collectedMinor: 4_439,
        }),
      ]),
    );
    expect(result.reconciliationRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxComponentId: 'gst',
          status: 'reconciled',
          differenceMinor: 0,
        }),
        expect.objectContaining({
          taxComponentId: 'pst',
          status: 'reconciled',
          differenceMinor: 0,
        }),
      ]),
    );
  });

  it('signs positive credit-note facts once, isolates currencies and excludes draft, cancelled, foreign and out-of-period facts', () => {
    const result = aggregateTaxSummary(
      input({
        facts: [
          fact({
            documentId: 'credit',
            documentKind: 'credit_note',
            taxableMinor: 10_000,
            taxMinor: 500,
          }),
          fact({ documentId: 'usd', currency: 'USD' }),
          fact({ documentId: 'draft', status: 'draft' }),
          fact({ documentId: 'cancelled', status: 'cancelled' }),
          fact({ documentId: 'late', issueDate: '2026-10-01' }),
          fact({ documentId: 'foreign', tenantId: 'tenant-b' }),
        ],
      }),
    );
    expect(result.componentRows).toEqual([
      expect.objectContaining({ currency: 'CAD', collectedMinor: -500 }),
      expect.objectContaining({ currency: 'USD', collectedMinor: 5_725 }),
    ]);
  });

  it('combines mapped expense/purchase ITCs, but marks linked or unmapped expense facts incomplete', () => {
    const result = aggregateTaxSummary(
      input({
        facts: [
          fact({
            direction: 'purchase',
            documentId: 'po',
            taxMinor: 500,
            recoverableMinor: 500,
            commitmentId: 'po-1',
          }),
        ],
        expenses: [
          {
            tenantId,
            expenseId: 'expense-linked',
            incurredOn: '2026-09-20',
            currency: 'CAD',
            commitmentId: 'po-1',
            commitmentLineId: null,
            financialBreakdown: {
              taxes: [{ code: 'gst', amount: 300, recoverableAmount: 300 }],
            },
          },
          {
            tenantId,
            expenseId: 'expense-unmapped',
            incurredOn: '2026-09-21',
            currency: 'CAD',
            commitmentId: null,
            commitmentLineId: null,
            financialBreakdown: {
              taxes: [{ code: 'pst', amount: 100, recoverableAmount: 100 }],
            },
          },
        ],
      }),
    );
    expect(result.complete).toBe(false);
    expect(result.componentRows).toEqual([
      expect.objectContaining({
        taxComponentId: 'gst',
        purchaseRecoverableMinor: 500,
        expenseRecoverableMinor: 300,
        inputTaxCreditMinor: null,
        netTaxMinor: null,
      }),
    ]);
    expect(result.warnings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'linked-purchase-expense',
        'unmapped-expense-component',
      ]),
    );
  });

  it('keeps unassigned components visible with no reconciliation amount', () => {
    const result = aggregateTaxSummary(
      input({
        facts: [
          fact({
            taxComponentId: 'legacy',
            componentName: 'Legacy',
            liabilityAccountId: null,
          }),
        ],
      }),
    );
    expect(result.reconciliationRows).toEqual([
      expect.objectContaining({
        taxComponentId: 'legacy',
        status: 'unassigned',
        ledgerMovementMinor: null,
      }),
    ]);
    expect(result.warnings.map(({ code }) => code)).toContain(
      'unassigned-liability-account',
    );
  });
});
