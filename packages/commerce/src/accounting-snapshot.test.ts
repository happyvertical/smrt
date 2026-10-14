import { describe, expect, it, vi } from 'vitest';
import {
  type FrozenAccountingDocumentSnapshot,
  type FrozenQuickBooksTaxMapping,
  mapFrozenAccountingSnapshot,
  pushFrozenCreditMemo,
  requireCreditMemoCapability,
} from './accounting-snapshot.js';

const mapping: FrozenQuickBooksTaxMapping = {
  lines: Object.fromEntries(
    ['1', '2', '3', '4'].map((id) => [
      id,
      { itemRef: `item-${id}`, taxCodeRef: `tax-code-${id}` },
    ]),
  ),
  components: {
    gst: { quickbooksTaxRateRef: 'rate-gst' },
    pst: { quickbooksTaxRateRef: 'rate-pst' },
  },
};

function document(
  overrides: Partial<FrozenAccountingDocumentSnapshot> = {},
): FrozenAccountingDocumentSnapshot {
  return {
    kind: 'invoice',
    id: 'invoice-1',
    number: 'INV-1',
    customerId: 'customer-1',
    customerExternalId: 'qbo-customer-1',
    issueDate: new Date('2026-10-13T00:00:00.000Z'),
    dueDate: new Date('2026-11-12T00:00:00.000Z'),
    currency: 'CAD',
    lineAmountType: 'exclusive',
    taxRoundingScope: 'line',
    subtotalMinor: 0,
    taxAmountMinor: 0,
    providerTaxMinor: 0,
    totalAmountMinor: 0,
    lineItems: [],
    ...overrides,
  };
}

function exampleA(
  taxRoundingScope: 'line' | 'document',
): FrozenAccountingDocumentSnapshot {
  return document({
    taxRoundingScope,
    subtotalMinor: 114_498,
    taxAmountMinor: 8_070,
    totalAmountMinor: 122_568,
    lineItems: [
      {
        id: '1',
        description: 'Example A line 1',
        quantity: 10,
        unitPriceMinor: 8500,
        discountMinor: 8500,
        amountMinor: 76_500,
        taxMinor: 3825,
        taxComponents: [
          { taxComponentId: 'gst', name: 'GST', percent: '5', taxMinor: 3825 },
        ],
      },
      {
        id: '2',
        description: 'Example A line 2',
        quantity: 2,
        unitPriceMinor: 4999,
        discountMinor: 500,
        amountMinor: 9498,
        taxMinor: 1140,
        taxComponents: [
          { taxComponentId: 'gst', name: 'GST', percent: '5', taxMinor: 475 },
          { taxComponentId: 'pst', name: 'PST', percent: '7', taxMinor: 665 },
        ],
      },
      {
        id: '3',
        description: 'Example A line 3',
        quantity: 12,
        unitPriceMinor: 2000,
        discountMinor: 0,
        amountMinor: 24_000,
        taxMinor: 2880,
        taxComponents: [
          { taxComponentId: 'gst', name: 'GST', percent: '5', taxMinor: 1200 },
          { taxComponentId: 'pst', name: 'PST', percent: '7', taxMinor: 1680 },
        ],
      },
      {
        id: '4',
        description: 'Example A line 4',
        quantity: 1,
        unitPriceMinor: 4500,
        discountMinor: 0,
        amountMinor: 4500,
        taxMinor: 225,
        taxComponents: [
          { taxComponentId: 'gst', name: 'GST', percent: '5', taxMinor: 225 },
        ],
      },
    ],
  });
}

function exampleB(
  taxRoundingScope: 'line' | 'document',
): FrozenAccountingDocumentSnapshot {
  const documentScope = taxRoundingScope === 'document';
  return document({
    lineAmountType: 'inclusive',
    taxRoundingScope,
    subtotalMinor: documentScope ? 107_051 : 107_052,
    taxAmountMinor: documentScope ? 7447 : 7446,
    totalAmountMinor: 114_498,
    lineItems: [
      {
        id: '1',
        description: 'Example B line 1',
        quantity: 10,
        unitPriceMinor: 8500,
        discountMinor: 8500,
        amountMinor: 72_857,
        taxMinor: 3643,
        taxComponents: [
          { taxComponentId: 'gst', name: 'GST', percent: '5', taxMinor: 3643 },
        ],
      },
      {
        id: '2',
        description: 'Example B line 2',
        quantity: 2,
        unitPriceMinor: 4999,
        discountMinor: 500,
        amountMinor: 8480,
        taxMinor: 1018,
        taxComponents: [
          { taxComponentId: 'gst', name: 'GST', percent: '5', taxMinor: 424 },
          { taxComponentId: 'pst', name: 'PST', percent: '7', taxMinor: 594 },
        ],
      },
      {
        id: '3',
        description: 'Example B line 3',
        quantity: 12,
        unitPriceMinor: 2000,
        discountMinor: 0,
        amountMinor: documentScope ? 21_428 : 21_429,
        taxMinor: documentScope ? 2572 : 2571,
        taxComponents: [
          {
            taxComponentId: 'gst',
            name: 'GST',
            percent: '5',
            taxMinor: documentScope ? 1072 : 1071,
          },
          { taxComponentId: 'pst', name: 'PST', percent: '7', taxMinor: 1500 },
        ],
      },
      {
        id: '4',
        description: 'Example B line 4',
        quantity: 1,
        unitPriceMinor: 4500,
        discountMinor: 0,
        amountMinor: 4286,
        taxMinor: 214,
        taxComponents: [
          { taxComponentId: 'gst', name: 'GST', percent: '5', taxMinor: 214 },
        ],
      },
    ],
  });
}

function exampleNonTaxable(
  lineAmountType: 'exclusive' | 'inclusive' | 'none',
  taxRoundingScope: 'line' | 'document',
): FrozenAccountingDocumentSnapshot {
  return document({
    lineAmountType,
    taxRoundingScope,
    subtotalMinor: 114_498,
    taxAmountMinor: 0,
    totalAmountMinor: 114_498,
    lineItems: [
      {
        id: '1',
        description: 'Example non-taxable line 1',
        quantity: 10,
        unitPriceMinor: 8500,
        discountMinor: 8500,
        amountMinor: 76_500,
        taxMinor: 0,
        taxComponents: [],
      },
      {
        id: '2',
        description: 'Example non-taxable line 2',
        quantity: 2,
        unitPriceMinor: 4999,
        discountMinor: 500,
        amountMinor: 9498,
        taxMinor: 0,
        taxComponents: [],
      },
      {
        id: '3',
        description: 'Example non-taxable line 3',
        quantity: 12,
        unitPriceMinor: 2000,
        discountMinor: 0,
        amountMinor: 24_000,
        taxMinor: 0,
        taxComponents: [],
      },
      {
        id: '4',
        description: 'Example non-taxable line 4',
        quantity: 1,
        unitPriceMinor: 4500,
        discountMinor: 0,
        amountMinor: 4500,
        taxMinor: 0,
        taxComponents: [],
      },
    ],
  });
}

describe('mapFrozenAccountingSnapshot', () => {
  it.each([
    'line',
    'document',
  ] as const)('maps actual example A exclusive stored facts under %s rounding', (taxRoundingScope) => {
    const result = mapFrozenAccountingSnapshot(
      exampleA(taxRoundingScope),
      mapping,
    );
    expect(result).toMatchObject({
      currency: 'CAD',
      subtotal: 1144.98,
      taxAmount: 80.7,
      totalAmount: 1225.68,
      quickbooksMapping: { globalTaxCalculation: 'TaxExcluded' },
    });
    expect(result.lineItems[0]).toMatchObject({
      unitPrice: 85,
      discount: 85,
      amount: 765,
      taxAmount: 38.25,
    });
    expect(result.lineItems[1]).toMatchObject({
      unitPrice: 49.99,
      discount: 5,
      amount: 94.98,
      taxAmount: 11.4,
    });
  });

  it.each([
    ['C exempt-exclusive', 'exclusive', 'TaxExcluded'],
    ['C out-of-scope', 'none', 'NotApplicable'],
    ['D inclusive-exempt', 'inclusive', 'TaxInclusive'],
  ] as const)('maps actual %s zero-tax facts without fabricating components', (_name, lineAmountType, globalTaxCalculation) => {
    for (const taxRoundingScope of ['line', 'document'] as const) {
      const result = mapFrozenAccountingSnapshot(
        exampleNonTaxable(lineAmountType, taxRoundingScope),
        mapping,
      );
      expect(result).toMatchObject({
        subtotal: 1144.98,
        taxAmount: 0,
        totalAmount: 1144.98,
        quickbooksMapping: { globalTaxCalculation },
      });
      expect(
        result.lineItems.every((line) => line.taxComponents.length === 0),
      ).toBe(true);
      if (lineAmountType === 'inclusive') {
        expect(result.lineItems[2]).toMatchObject({
          amount: 240,
          taxAmount: 0,
          taxInclusiveAmount: 240,
        });
      }
    }
  });

  it.each([
    'line',
    'document',
  ] as const)('maps actual example B inclusive stored facts under %s rounding', (taxRoundingScope) => {
    const result = mapFrozenAccountingSnapshot(
      exampleB(taxRoundingScope),
      mapping,
    );
    const documentScope = taxRoundingScope === 'document';
    expect(result).toMatchObject({
      currency: 'CAD',
      subtotal: documentScope ? 1070.51 : 1070.52,
      taxAmount: documentScope ? 74.47 : 74.46,
      totalAmount: 1144.98,
      quickbooksMapping: { globalTaxCalculation: 'TaxInclusive' },
    });
    expect(result.lineItems[2]).toMatchObject({
      amount: documentScope ? 214.28 : 214.29,
      taxAmount: documentScope ? 25.72 : 25.71,
      taxInclusiveAmount: 240,
      taxComponents: [
        {
          taxCode: 'gst',
          rate: '0.05',
          taxAmount: documentScope ? 10.72 : 10.71,
        },
        { taxCode: 'pst', rate: '0.07', taxAmount: 15 },
      ],
    });
  });

  it('preserves JPY zero-decimal minor values', () => {
    const result = mapFrozenAccountingSnapshot(
      document({
        currency: 'JPY',
        subtotalMinor: 100,
        taxAmountMinor: 10,
        totalAmountMinor: 110,
        lineItems: [
          {
            id: '1',
            description: 'JPY service',
            quantity: 1,
            unitPriceMinor: 100,
            discountMinor: 0,
            amountMinor: 100,
            taxMinor: 10,
            taxComponents: [
              {
                taxComponentId: 'gst',
                name: 'GST',
                percent: '10',
                taxMinor: 10,
              },
            ],
          },
        ],
      }),
      mapping,
    );
    expect(result).toMatchObject({
      currency: 'JPY',
      subtotal: 100,
      taxAmount: 10,
      totalAmount: 110,
    });
  });

  it('preserves a valid KWD three-decimal inclusive allocation', () => {
    const result = mapFrozenAccountingSnapshot(
      document({
        currency: 'KWD',
        lineAmountType: 'inclusive',
        subtotalMinor: 952,
        taxAmountMinor: 48,
        totalAmountMinor: 1000,
        lineItems: [
          {
            id: '1',
            description: 'KWD service',
            quantity: 1,
            unitPriceMinor: 1000,
            discountMinor: 0,
            amountMinor: 952,
            taxMinor: 48,
            taxComponents: [
              {
                taxComponentId: 'gst',
                name: 'GST',
                percent: '5',
                taxMinor: 48,
              },
            ],
          },
        ],
      }),
      mapping,
    );
    expect(result.lineItems[0]).toMatchObject({
      amount: 0.952,
      taxAmount: 0.048,
      taxInclusiveAmount: 1,
    });
  });

  it('maps a positive credit memo and retains its credited invoice linkage', () => {
    const result = mapFrozenAccountingSnapshot(exampleA('line'), mapping);
    const memo = mapFrozenAccountingSnapshot(
      {
        ...exampleA('line'),
        kind: 'creditMemo',
        number: 'CM-1',
        creditedInvoiceExternalId: 'qbo-invoice-1',
      },
      mapping,
    );
    expect(result.totalAmount).toBe(1225.68);
    expect(memo).toMatchObject({
      creditMemoNumber: 'CM-1',
      creditedInvoiceExternalId: 'qbo-invoice-1',
      totalAmount: 1225.68,
    });
  });

  it('refuses a line/header mismatch before the provider write runs', async () => {
    const push = vi.fn(async () => ({ externalId: 'should-not-write' }));
    await expect(
      pushFrozenCreditMemo(
        { type: 'quickbooks', creditMemos: { push, sync: push } },
        {
          ...exampleA('line'),
          kind: 'creditMemo',
          creditedInvoiceExternalId: 'qbo-invoice-1',
          taxAmountMinor: 8069,
          totalAmountMinor: 122_567,
        },
        mapping,
      ),
    ).rejects.toThrow('Frozen line tax amounts do not equal frozen tax total');
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses positive inclusive tax without component facts before a credit-memo write', async () => {
    const push = vi.fn(async () => ({ externalId: 'should-not-write' }));
    const snapshot = exampleNonTaxable('inclusive', 'document');
    const lineItems = snapshot.lineItems.map((line, index) =>
      index === 0 ? { ...line, taxMinor: 1 } : line,
    );
    await expect(
      pushFrozenCreditMemo(
        { type: 'quickbooks', creditMemos: { push, sync: push } },
        {
          ...snapshot,
          kind: 'creditMemo',
          creditedInvoiceExternalId: 'qbo-invoice-1',
          taxAmountMinor: 1,
          totalAmountMinor: 114_499,
          lineItems,
        },
        mapping,
      ),
    ).rejects.toThrow('frozen component tax 0 does not equal line tax 1');
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses guessed component tax-rate references and unsupported providers', () => {
    expect(() =>
      mapFrozenAccountingSnapshot(exampleA('line'), {
        ...mapping,
        components: {},
      }),
    ).toThrow(
      "Missing explicit QuickBooks tax-rate reference for component 'gst'",
    );
    expect(() => requireCreditMemoCapability({ type: 'stripe' })).toThrow(
      "Accounting provider 'stripe' does not support credit memos",
    );
  });

  it('refuses header-only provider tax with no frozen component facts', () => {
    expect(() =>
      mapFrozenAccountingSnapshot(
        document({
          providerTaxMinor: 1,
          taxAmountMinor: 1,
          totalAmountMinor: 1,
          subtotalMinor: 0,
          lineItems: [
            {
              id: '1',
              description: 'Provider tax',
              quantity: 1,
              unitPriceMinor: 0,
              discountMinor: 0,
              amountMinor: 0,
              taxMinor: 0,
              taxComponents: [],
            },
          ],
        }),
        mapping,
      ),
    ).toThrow('Frozen provider tax cannot be mapped to QuickBooks');
  });
});
