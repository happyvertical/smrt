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
  documentType: 'invoice' as const,
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
  it('uses exact A, B line/document, C/D exempt and E stored calculator goldens', () => {
    const result = aggregateTaxSummary(
      input({
        facts: [
          // A: GST is taxable on the full $1,144.98; PST only on $334.98.
          fact({ taxCodeId: 'gst', taxableMinor: 81_000, taxMinor: 1_875 }),
          fact({
            taxCodeId: 'gst-pst',
            taxableMinor: 33_498,
            taxMinor: 3_850,
          }),
          fact({
            taxCodeId: 'gst-pst',
            taxableMinor: 33_498,
            taxComponentId: 'pst',
            componentName: 'PST',
            liabilityAccountId: 'pst-payable',
            taxMinor: 2_345,
          }),
          // B line scope: GST $1,070.52; PST $299.09.
          fact({
            documentId: 'B-line',
            taxCodeId: 'gst',
            taxableMinor: 77_143,
            taxMinor: 3_856,
          }),
          fact({
            documentId: 'B-line',
            taxCodeId: 'gst-pst',
            taxableMinor: 29_909,
            taxMinor: 1_496,
          }),
          fact({
            documentId: 'B-line',
            taxCodeId: 'gst-pst',
            taxableMinor: 29_909,
            taxComponentId: 'pst',
            componentName: 'PST',
            liabilityAccountId: 'pst-payable',
            taxMinor: 2_094,
          }),
          // B document scope: GST $1,070.51; PST $299.08.
          fact({
            documentId: 'B-document',
            taxCodeId: 'gst',
            taxableMinor: 77_143,
            taxMinor: 3_857,
          }),
          fact({
            documentId: 'B-document',
            taxCodeId: 'gst-pst',
            taxableMinor: 29_908,
            taxMinor: 1_496,
          }),
          fact({
            documentId: 'B-document',
            taxCodeId: 'gst-pst',
            taxableMinor: 29_908,
            taxComponentId: 'pst',
            componentName: 'PST',
            liabilityAccountId: 'pst-payable',
            taxMinor: 2_094,
          }),
          // C is exempt. The actual stored fact contains no component row.
          fact({
            documentId: 'C',
            taxCodeId: 'exempt',
            taxCodeKind: 'exempt',
            taxableMinor: 114_498,
            taxMinor: 0,
            taxComponentId: null,
            componentName: null,
            liabilityAccountId: null,
          }),
          // D is the distinct inclusive-exempt document: stored base/tax match C.
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
          // E document scope persists the $0.34 rounding result: 2¢ + 2¢ tax.
          fact({
            documentId: 'E',
            taxCodeId: 'gst-pst',
            taxableMinor: 30,
            taxMinor: 2,
          }),
          fact({
            documentId: 'E',
            taxCodeId: 'gst-pst',
            taxableMinor: 30,
            taxComponentId: 'pst',
            componentName: 'PST',
            liabilityAccountId: 'pst-payable',
            taxMinor: 2,
          }),
        ],
        ledgerMovements: [
          {
            tenantId,
            entryId: 'manual-gst',
            accountId: 'gst-payable',
            currency: 'CAD',
            creditMinusDebit: 16_432,
          },
          {
            tenantId,
            entryId: 'manual-pst',
            accountId: 'pst-payable',
            currency: 'CAD',
            creditMinusDebit: 6_535,
          },
        ],
      }),
    );
    expect(result.kindRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxCodeKind: 'taxable',
          taxableMinor: 328_631,
          documentCount: 4,
        }),
        expect.objectContaining({
          taxCodeKind: 'exempt',
          taxableMinor: 228_996,
          documentCount: 2,
        }),
      ]),
    );
    expect(result.componentRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxComponentId: 'gst',
          taxableMinor: 328_631,
          collectedMinor: 16_432,
          netTaxMinor: 16_432,
          documentCount: 4,
        }),
        expect.objectContaining({
          taxComponentId: 'pst',
          taxableMinor: 93_345,
          collectedMinor: 6_535,
          documentCount: 4,
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

  it('warns for a nullable stored kind instead of classifying it as out-of-scope', () => {
    const result = aggregateTaxSummary(
      input({
        facts: [
          fact({
            taxCodeId: null,
            taxCodeKind: null,
            taxComponentId: null,
            componentName: null,
            liabilityAccountId: null,
            taxMinor: 0,
          }),
        ],
      }),
    );
    expect(result.complete).toBe(false);
    expect(result.kindRows).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unassigned-tax-code' }),
      ]),
    );
  });

  it('keeps zero-rated and out-of-scope stored bases distinct', () => {
    const result = aggregateTaxSummary(
      input({
        facts: [
          fact({
            documentId: 'zero',
            taxCodeId: 'zero',
            taxCodeKind: 'zero-rated',
            taxableMinor: 500,
            taxMinor: 0,
            taxComponentId: null,
            componentName: null,
            liabilityAccountId: null,
          }),
          fact({
            documentId: 'out',
            taxCodeId: 'out',
            taxCodeKind: 'out-of-scope',
            taxableMinor: 700,
            taxMinor: 0,
            taxComponentId: null,
            componentName: null,
            liabilityAccountId: null,
          }),
        ],
      }),
    );
    expect(result.kindRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxCodeKind: 'zero-rated',
          taxableMinor: 500,
          documentCount: 1,
        }),
        expect.objectContaining({
          taxCodeKind: 'out-of-scope',
          taxableMinor: 700,
          documentCount: 1,
        }),
      ]),
    );
  });

  it('uses document type as part of a unique stored document identity', () => {
    const result = aggregateTaxSummary(
      input({
        facts: [
          fact({ documentId: 'shared', taxableMinor: 100, taxMinor: 5 }),
          fact({
            documentType: 'contract',
            documentKind: 'contract',
            documentId: 'shared',
            taxableMinor: 200,
            taxMinor: 10,
          }),
        ],
      }),
    );
    expect(result.kindRows).toEqual([
      expect.objectContaining({ taxableMinor: 300, documentCount: 2 }),
    ]);
    expect(result.componentRows).toEqual([
      expect.objectContaining({ taxableMinor: 300, documentCount: 2 }),
    ]);
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
            commitmentLineId: 'line-1',
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

  it('marks shared liability accounts ambiguous instead of comparing one balance to each component', () => {
    const result = aggregateTaxSummary(
      input({
        facts: [
          fact({ liabilityAccountId: 'combined-payable' }),
          fact({
            documentId: 'B',
            taxComponentId: 'pst',
            componentName: 'PST',
            liabilityAccountId: 'combined-payable',
            taxMinor: 3_345,
          }),
        ],
        ledgerMovements: [
          {
            tenantId,
            entryId: 'combined',
            accountId: 'combined-payable',
            currency: 'CAD',
            creditMinusDebit: 9_070,
          },
        ],
      }),
    );
    expect(result.complete).toBe(false);
    expect(result.reconciliationRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taxComponentId: 'gst',
          ledgerMovementMinor: null,
          differenceMinor: null,
          status: 'ambiguous',
        }),
        expect.objectContaining({
          taxComponentId: 'pst',
          ledgerMovementMinor: null,
          differenceMinor: null,
          status: 'ambiguous',
        }),
      ]),
    );
    expect(result.warnings.map(({ code }) => code)).toContain(
      'shared-liability-account',
    );
  });

  it('rejects aggregate arithmetic outside safe minor-unit range', () => {
    expect(() =>
      aggregateTaxSummary(
        input({
          facts: [
            fact({ taxableMinor: 0, taxMinor: Number.MAX_SAFE_INTEGER }),
            fact({ documentId: 'B', taxableMinor: 0, taxMinor: 1 }),
          ],
        }),
      ),
    ).toThrow(/safe integer minor-unit range/);
  });

  it('does not treat a same-id purchase and expense in different currencies as linked', () => {
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
            expenseId: 'expense-usd',
            incurredOn: '2026-09-20',
            currency: 'USD',
            commitmentId: 'po-1',
            commitmentLineId: 'line-1',
            financialBreakdown: {
              taxes: [{ code: 'gst', amount: 300, recoverableAmount: 300 }],
            },
          },
        ],
      }),
    );
    expect(result.complete).toBe(true);
    expect(result.warnings.map(({ code }) => code)).not.toContain(
      'linked-purchase-expense',
    );
    expect(result.componentRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currency: 'USD',
          expenseRecoverableMinor: 300,
          inputTaxCreditMinor: 300,
        }),
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
