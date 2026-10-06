import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import InvoiceCard from '../components/InvoiceCard.svelte';
import InvoiceHeader from '../components/InvoiceHeader.svelte';
import InvoiceLineItems from '../components/InvoiceLineItems.svelte';
import InvoiceTotals from '../components/InvoiceTotals.svelte';
import { formatInvoiceMinorUnits } from '../invoice-display.js';
import RetainedInvoiceDisplayFixture from './__tests__/fixtures/RetainedInvoiceDisplayFixture.svelte';

describe('retained invoice display', () => {
  it.each([
    ['JPY', 'JP¥1,001'],
    ['CAD', '$10.01'],
    ['KWD', 'KWD 1.001'],
  ])('formats 1001 minor units exactly for %s', (currency, expected) => {
    expect(formatInvoiceMinorUnits(1001, currency)).toBe(expected);
  });

  it('formats the safe-integer boundary without losing cents', () => {
    expect(formatInvoiceMinorUnits(Number.MAX_SAFE_INTEGER, 'CAD')).toBe(
      '$90,071,992,547,409.91',
    );
    expect(() =>
      formatInvoiceMinorUnits(Number.MAX_SAFE_INTEGER + 1, 'CAD'),
    ).toThrow(/safe integer/u);
    expect(() => formatInvoiceMinorUnits(1, 'not-a-currency')).toThrow(
      /three-letter code/u,
    );
  });

  it('renders caller-authoritative retained facts without recalculation or mutations', () => {
    const body = render(RetainedInvoiceDisplayFixture).body;
    expect(body).toContain('Posting blocked');
    expect(body).not.toContain('Draft');
    expect(body).toContain('1.0005');
    expect(body).toContain('$10.01');
    expect(body).toContain('$99.99');
    expect(body).toContain('$104.99');
    expect(body).not.toContain('$10.01</td></tr></tfoot>');
    for (const evidence of [
      'Flat discount CAD 0.00',
      'GST explicit 0%',
      'PST retained 5%',
      'Corrects invoice line revision 3',
      'GST retained',
      'PST retained',
      'Construction holdback retained',
      'Card evidence · posting-blocked',
      'Line evidence · line-1',
      'Totals evidence · CAD',
    ])
      expect(body).toContain(evidence);
    expect(body).not.toContain('Payable');
    expect(body).not.toContain('<form');
    expect(body).not.toContain('<button');
  });

  it('preserves legacy decimal-major defaults', () => {
    const header = render(InvoiceHeader, {
      props: {
        invoiceNumber: 'INV-legacy',
        status: 'draft',
        issueDate: '2026-10-05T12:00:00Z',
      },
    }).body;
    const card = render(InvoiceCard, {
      props: {
        invoice: {
          id: 'legacy',
          invoiceNumber: 'INV-legacy',
          status: 'draft',
          issueDate: '2026-10-05T12:00:00Z',
          totalAmount: 12.34,
        },
      },
    }).body;
    const lines = render(InvoiceLineItems, {
      props: {
        items: [
          {
            id: 'legacy-line',
            description: 'Legacy',
            quantity: 1,
            unitPrice: 12.34,
            amount: 12.34,
          },
        ],
      },
    }).body;
    const totals = render(InvoiceTotals, {
      props: { subtotal: 10, taxRate: 5, total: 10.5 },
    }).body;
    expect(header).toContain('Draft');
    expect(card).toContain('$12.34');
    expect(lines.match(/\$12\.34/g)).toHaveLength(3);
    expect(totals).toContain('$0.50');
    expect(totals).toContain('$10.50');
  });
});
