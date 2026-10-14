import { describe, expect, it, vi } from 'vitest';
import {
  type FrozenAccountingDocumentSnapshot,
  type FrozenQuickBooksTaxMapping,
  mapFrozenAccountingSnapshot,
  pushFrozenCreditMemo,
  requireCreditMemoCapability,
} from './accounting-snapshot.js';

const mapping: FrozenQuickBooksTaxMapping = {
  lines: {
    'line-1': { itemRef: 'item-1', taxCodeRef: 'tax-code-1' },
  },
  components: {
    gst: { quickbooksTaxRateRef: 'rate-gst' },
    pst: { quickbooksTaxRateRef: 'rate-pst' },
  },
};

function snapshot(
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
    currency: 'JPY',
    lineAmountType: 'exclusive',
    taxRoundingScope: 'line',
    subtotalMinor: 100,
    taxAmountMinor: 10,
    providerTaxMinor: 0,
    totalAmountMinor: 110,
    lineItems: [
      {
        id: 'line-1',
        description: 'JPY consultation',
        quantity: 1,
        unitPriceMinor: 100,
        discountMinor: 0,
        amountMinor: 100,
        taxMinor: 10,
        taxComponents: [
          { taxComponentId: 'gst', name: 'GST', percent: '10', taxMinor: 10 },
        ],
      },
    ],
    ...overrides,
  };
}

describe('mapFrozenAccountingSnapshot', () => {
  it.each([
    'line',
    'document',
  ] as const)('maps example A JPY exclusive facts with %s rounding intact', (taxRoundingScope) => {
    const result = mapFrozenAccountingSnapshot(
      snapshot({ taxRoundingScope }),
      mapping,
    );

    expect(result).toMatchObject({
      invoiceNumber: 'INV-1',
      currency: 'JPY',
      subtotal: 100,
      taxAmount: 10,
      totalAmount: 110,
      quickbooksMapping: { globalTaxCalculation: 'TaxExcluded' },
      lineItems: [
        {
          unitPrice: 100,
          amount: 100,
          taxAmount: 10,
          taxComponents: [
            {
              taxCode: 'gst',
              rate: '0.1',
              quickbooksTaxRateRef: 'rate-gst',
              taxAmount: 10,
            },
          ],
        },
      ],
    });
  });

  it.each([
    'line',
    'document',
  ] as const)('maps example B KWD inclusive discount facts with %s rounding intact', (taxRoundingScope) => {
    const result = mapFrozenAccountingSnapshot(
      snapshot({
        currency: 'KWD',
        lineAmountType: 'inclusive',
        taxRoundingScope,
        subtotalMinor: 950,
        taxAmountMinor: 50,
        totalAmountMinor: 1000,
        lineItems: [
          {
            id: 'line-1',
            description: 'KWD inclusive service',
            quantity: 1,
            unitPriceMinor: 1125,
            discountMinor: 125,
            amountMinor: 950,
            taxMinor: 50,
            taxComponents: [
              {
                taxComponentId: 'gst',
                name: 'GST',
                percent: '5',
                taxMinor: 50,
              },
            ],
          },
        ],
      }),
      mapping,
    );

    expect(result).toMatchObject({
      currency: 'KWD',
      subtotal: 0.95,
      taxAmount: 0.05,
      totalAmount: 1,
      quickbooksMapping: { globalTaxCalculation: 'TaxInclusive' },
      lineItems: [
        {
          unitPrice: 1.125,
          discount: 0.125,
          amount: 0.95,
          taxAmount: 0.05,
          taxInclusiveAmount: 1,
          taxComponents: [{ rate: '0.05', taxAmount: 0.05 }],
        },
      ],
    });
  });

  it('maps a positive credit memo and retains its credited invoice linkage', () => {
    const result = mapFrozenAccountingSnapshot(
      snapshot({
        kind: 'creditMemo',
        number: 'CM-1',
        creditedInvoiceExternalId: 'qbo-invoice-1',
      }),
      mapping,
    );

    expect(result).toMatchObject({
      creditMemoNumber: 'CM-1',
      creditedInvoiceExternalId: 'qbo-invoice-1',
      subtotal: 100,
      taxAmount: 10,
      totalAmount: 110,
    });
  });

  it('refuses a line/header mismatch before the provider write runs', async () => {
    const push = vi.fn(async () => ({ externalId: 'should-not-write' }));
    await expect(
      pushFrozenCreditMemo(
        { type: 'quickbooks', creditMemos: { push, sync: push } },
        snapshot({
          kind: 'creditMemo',
          creditedInvoiceExternalId: 'qbo-invoice-1',
          taxAmountMinor: 9,
          totalAmountMinor: 109,
        }),
        mapping,
      ),
    ).rejects.toThrow('Frozen line tax amounts do not equal frozen tax total');
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses guessed component tax-rate references and unsupported providers', () => {
    expect(() =>
      mapFrozenAccountingSnapshot(snapshot(), {
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
        snapshot({
          providerTaxMinor: 1,
          taxAmountMinor: 11,
          totalAmountMinor: 111,
        }),
        mapping,
      ),
    ).toThrow('Frozen provider tax cannot be mapped to QuickBooks');
  });
});
