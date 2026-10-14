import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import InvoiceEditor from '../components/InvoiceEditor.svelte';
import {
  calculateMoneyEditorDraft,
  type MoneyEditorProps,
  moneyEditorSubmission,
} from './money-editor.js';

const money: MoneyEditorProps = {
  mode: 'v2',
  draft: {
    currency: 'CAD',
    lineAmountType: 'inclusive',
    roundingScope: 'line',
    lines: [
      {
        id: 'line-a',
        description: 'Consulting',
        quantity: '1',
        unitPrice: '112.00',
        discountType: 'percent',
        discountValue: '10',
        taxMode: 'inherit',
        inheritedTaxCodeId: 'gst',
        inheritedTaxCodeSource: 'product',
      },
    ],
  },
  taxCodes: [
    {
      id: 'gst',
      code: 'GST',
      name: 'GST',
      kind: 'taxable',
      components: [
        { taxComponentId: 'gst-component', percent: '5', compound: false },
      ],
    },
  ],
  sellerTaxRegistrations: ['GST/HST No. 123456789 RT0001'],
  partyTaxId: 'CA-Party-1',
  showNetSubtotal: true,
};

describe('v2 money editor adapter', () => {
  it('uses the pure calculator and submits only typed input fields', () => {
    const calculated = calculateMoneyEditorDraft(money.draft, money.taxCodes);
    expect(calculated).toMatchObject({
      valid: true,
      result: {
        subtotalMinor: 9600,
        taxMinor: 480,
        totalMinor: 10080,
        discountTotalMinor: 1120,
      },
    });
    expect(moneyEditorSubmission(money.draft)).toEqual({
      lineAmountType: 'inclusive',
      taxRoundingScope: 'line',
      lines: [
        {
          id: 'line-a',
          description: 'Consulting',
          quantity: '1',
          unitPrice: '112.00',
          discountType: 'percent',
          discountValue: '10',
          taxMode: 'inherit',
          taxCodeId: '',
        },
      ],
    });
  });
  it('allows a genuinely unassigned code in exclusive mode without inventing tax', () => {
    const calculated = calculateMoneyEditorDraft(
      {
        ...money.draft,
        lineAmountType: 'exclusive',
        lines: [{ ...money.draft.lines[0], inheritedTaxCodeId: null }],
      },
      money.taxCodes,
    );
    expect(calculated).toMatchObject({
      valid: true,
      result: { subtotalMinor: 10080, taxMinor: 0, totalMinor: 10080 },
    });
  });
  it('renders stored frozen facts without recalculating and preserves native fields', () => {
    const body = render(InvoiceEditor, {
      props: {
        action: '/invoices',
        money: {
          ...money,
          draft: {
            ...money.draft,
            lines: [{ ...money.draft.lines[0], unitPrice: 'not-a-decimal' }],
          },
          frozen: true,
          status: 'SENT',
          stored: {
            lineAmountType: 'inclusive',
            roundingScope: 'document',
            subtotalMinor: 9600,
            discountTotalMinor: 1120,
            taxMinor: 480,
            totalMinor: 10080,
            taxes: [
              {
                id: 'gst',
                taxComponentId: 'gst-component',
                name: 'GST',
                percent: '5',
                taxableMinor: 7600,
                taxMinor: 380,
              },
              {
                id: 'gst-in-combined-code',
                taxComponentId: 'gst-component',
                name: 'GST',
                percent: '5',
                taxableMinor: 2000,
                taxMinor: 100,
              },
            ],
          },
        },
      },
    }).body;
    expect(body).toContain('Frozen · SENT');
    expect(body).toContain('GST/HST No. 123456789 RT0001');
    expect(body).toContain('Includes GST 5% of');
    expect(body.match(/Includes GST 5% of/g)).toHaveLength(1);
    expect(body).toContain('Rounded per document');
    expect(body).toContain('name="lineAmountType"');
    expect(body).toContain('disabled');
    expect(body).not.toContain('Amounts must be non-negative decimal text');
  });
  it('does not produce an inclusive tax row for exempt stored values', () => {
    const body = render(InvoiceEditor, {
      props: {
        action: '/invoices',
        money: {
          ...money,
          frozen: true,
          customerTaxExempt: true,
          stored: {
            lineAmountType: 'inclusive',
            roundingScope: 'line',
            subtotalMinor: 10080,
            discountTotalMinor: 0,
            taxMinor: 0,
            totalMinor: 10080,
            taxes: [],
          },
        },
      },
    }).body;
    expect(body).not.toContain('Includes GST');
    expect(body).toContain('Subtotal');
    expect(body).not.toContain('Subtotal (excl. tax)');
    expect(body).toContain('Total');
  });
});
