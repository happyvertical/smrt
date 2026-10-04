import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import InvoiceEditor from '../components/InvoiceEditor.svelte';
import InvoiceLineEditor from '../components/InvoiceLineEditor.svelte';

const values: InvoiceDraftValues = {
  customerId: 'customer-a',
  issuedOn: '2026-10-03',
  dueOn: '2026-11-03',
  currency: 'CAD',
  paymentTerms: 'Net 30',
  taxRate: '5',
  lines: [
    {
      key: 'line-a',
      description: 'Consulting',
      sku: 'CONSULT',
      quantity: '1.5',
      unitPrice: '100.00',
      discountType: 'percent',
      discountValue: '10',
      taxMode: 'inherit',
      taxRate: '0',
    },
  ],
};

import type { InvoiceDraftValues, InvoiceEditorProps } from './types.js';

const html = (props: Partial<InvoiceEditorProps> = {}) =>
  render(InvoiceEditor, {
    props: {
      action: '/save',
      values,
      hiddenFields: [
        { name: 'requestId', value: 'same-token' },
        { name: 'context', value: 'a' },
        { name: 'context', value: 'b' },
      ],
      ...props,
    },
  }).body;
describe('General invoice foundation', () => {
  it('renders general header and all line inputs with exact calculated previews', () => {
    const body = html();
    for (const name of [
      'customerId',
      'issuedOn',
      'dueOn',
      'currency',
      'paymentTerms',
      'invoiceTaxRate',
      'lineDescription',
      'lineSku',
      'lineQuantity',
      'lineUnitPrice',
      'lineDiscountType',
      'lineDiscountValue',
      'lineTaxMode',
      'lineTaxRate',
    ])
      expect(body).toContain(`name="${name}"`);
    expect(body).toContain('141.75');
    expect(body).toContain('value="1.5"');
    expect(body).toContain('value="CONSULT"');
    expect(body).toContain('value="same-token"');
    expect(body.match(/name="context"/g)).toHaveLength(2);
    expect(body.indexOf('value="save"')).toBeLessThan(
      body.indexOf('value="removeLine:line-a"'),
    );
    expect(body.match(/<form /g)).toHaveLength(1);
  });
  it('retains malformed values, unknown selections, caller errors and retry identity', () => {
    const body = html({
      values: {
        ...values,
        currency: 'future-money',
        issuedOn: 'bad-date',
        lines: [
          {
            ...values.lines[0],
            quantity: '1..2',
            unitPrice: 'oops',
            taxMode: 'future-mode',
            discountType: 'future-discount',
          },
        ],
      },
      errors: { 'line-a.quantity': 'Retained quantity error' },
      retryStatus: 'transport-error',
      message: 'Denied',
    });
    for (const value of [
      'future-money',
      'bad-date',
      '1..2',
      'oops',
      'future-mode',
      'future-discount',
    ])
      expect(body).toContain(`value="${value}"`);
    expect(body).toContain('Retained quantity error');
    expect(body).toContain('aria-invalid="true"');
    expect(body).toContain('Totals unavailable');
    expect(body).toContain('The outcome is uncertain');
    expect(body).toContain('same-token');
  });
  it('line primitive distinguishes inherited tax from explicit zero and has no form', () => {
    const body = render(InvoiceLineEditor, {
      props: {
        line: { ...values.lines[0], taxMode: 'override', taxRate: '0' },
        currency: 'CAD',
        inheritedTaxRate: '5',
      },
    }).body;
    expect(body).toContain('135.00');
    expect(body).not.toContain('141.75');
    expect(body).not.toContain('<form');
    expect(body).toContain('value="override" selected');
  });
  it('preserves read-only/pending restrictions and caller server review', () => {
    const body = html({
      canEdit: false,
      review: { label: 'Caller review', message: 'Not inferred from edits' },
    });
    expect(body).toContain('<fieldset disabled');
    expect(body).not.toContain('value="save"');
    expect(body).not.toContain('value="addLine"');
    expect(body).toContain('Caller review');
    expect(html({ pending: true })).toMatch(
      /<button[^>]*disabled[^>]*name="intent"/,
    );
  });
  it('adapts native names without changing retained draft strings', () => {
    const body = html({
      fields: { customerId: 'buyer', intent: 'operation' },
      lineFields: { quantity: 'qty' },
    });
    expect(body).toContain('name="buyer"');
    expect(body).toContain('name="qty"');
    expect(body).toContain('name="operation"');
  });
});
