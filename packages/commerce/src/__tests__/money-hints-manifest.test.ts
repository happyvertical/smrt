/**
 * #3718: amounts carry the money hint (`ui.format: 'money'`, integer minor
 * units) so record pages format and total them; the currency CODE keeps the
 * `ui.widget: 'currency'` picker; line-item foreign keys carry
 * `role: 'items'`, which the generated web relationship edge emits.
 *
 * Reads the manifest the smrt-vitest plugin generates from source before the
 * run (`.smrt/manifest.json`), i.e. exactly what the scanner emits.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type ManifestField = {
  type: string;
  _meta?: { ui?: Record<string, unknown>; role?: unknown };
};
const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), '.smrt/manifest.json'), 'utf8'),
) as { objects: Record<string, { fields: Record<string, ManifestField> }> };

const fieldsOf = (className: string) =>
  manifest.objects[`@happyvertical/smrt-commerce:${className}`].fields;

const MONEY: Record<string, string[]> = {
  Contract: ['subtotal', 'taxAmount', 'totalAmount'],
  ContractLineItem: ['unitPrice', 'discount', 'amount'],
  Invoice: [
    'subtotal',
    'taxAmount',
    'providerTaxAmount',
    'totalAmount',
    'amountPaid',
  ],
  InvoiceLineItem: ['unitPrice', 'discount', 'amount'],
  Payment: ['amount'],
  PaymentAllocation: ['amount'],
  Customer: ['creditLimit'],
  Vendor: ['minimumOrderAmount'],
};

describe('commerce manifest money hints', () => {
  it.each(
    Object.entries(MONEY),
  )('marks the %s amounts as money', (cls, names) => {
    for (const name of names) {
      const field = fieldsOf(cls)[name];
      expect(field?.type, `${cls}.${name}`).toBe('integer');
      expect(field?._meta?.ui?.format, `${cls}.${name}`).toBe('money');
    }
  });

  it('keeps the currency-code picker on the text currency field, not on amounts', () => {
    expect(fieldsOf('Contract').currency._meta?.ui).toEqual({
      widget: 'currency',
    });
    expect(fieldsOf('Contract').totalAmount._meta?.ui?.widget).toBeUndefined();
  });

  it('leaves rates and quantities unhinted', () => {
    expect(
      fieldsOf('ContractLineItem').taxRate._meta?.ui?.format,
    ).toBeUndefined();
    expect(
      fieldsOf('ContractLineItem').quantity._meta?.ui?.format,
    ).toBeUndefined();
  });

  it('marks the line-item foreign keys role items', () => {
    expect(fieldsOf('ContractLineItem').contractId._meta?.role).toBe('items');
    expect(fieldsOf('InvoiceLineItem').invoiceId._meta?.role).toBe('items');
    expect(fieldsOf('FulfillmentLineItem').fulfillmentId._meta?.role).toBe(
      'items',
    );
    expect(fieldsOf('ContractLineItem').productId?._meta?.role).toBeUndefined();
  });
});
