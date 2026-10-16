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
) as {
  objects: Record<
    string,
    { extends?: string; fields: Record<string, ManifestField> }
  >;
};

const PREFIX = '@happyvertical/smrt-commerce:';
const fieldsOf = (className: string) =>
  manifest.objects[`${PREFIX}${className}`].fields;

const MONEY: Record<string, string[]> = {
  Contract: ['subtotal', 'discountTotal', 'taxAmount', 'totalAmount'],
  ContractLineItem: ['unitPrice', 'discount', 'taxAmount', 'amount'],
  Invoice: [
    'subtotal',
    'discountTotal',
    'taxAmount',
    'providerTaxAmount',
    'totalAmount',
    'amountPaid',
    'creditedAmount',
  ],
  InvoiceLineItem: ['unitPrice', 'discount', 'taxAmount', 'amount'],
  DocumentTax: ['taxableMinor', 'taxMinor', 'recoverableMinor'],
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

  // #4011: every money-named integer on the document-money models (and the
  // Contract STI subtypes that inherit them) carries the hint, so the next
  // money field cannot miss it.
  const MONEY_NAME = /(?:Amount|Total|Minor)$|^subtotal$/;
  /** Integers that match MONEY_NAME but are deliberately unhinted. */
  const NOT_MONEY: Record<string, string> = {};
  const DOCUMENT_MONEY = new Set([
    'Invoice',
    'InvoiceLineItem',
    'Contract',
    'ContractLineItem',
    'DocumentTax',
  ]);

  /** The model's root class, following `extends` through the STI chain. */
  const rootOf = (cls: string): string => {
    const parent = manifest.objects[`${PREFIX}${cls}`]?.extends;
    return parent && manifest.objects[`${PREFIX}${parent}`]
      ? rootOf(parent)
      : cls;
  };

  it('hints every money-named integer on the document-money models', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const [key, object] of Object.entries(manifest.objects)) {
      const cls = key.slice(PREFIX.length);
      if (!DOCUMENT_MONEY.has(rootOf(cls))) continue;
      for (const [name, field] of Object.entries(object.fields)) {
        if (field.type !== 'integer' || !MONEY_NAME.test(name)) continue;
        if (NOT_MONEY[`${rootOf(cls)}.${name}`]) {
          expect(field._meta?.ui?.format, `${cls}.${name}`).toBeUndefined();
          continue;
        }
        checked++;
        if (field._meta?.ui?.format !== 'money') missing.push(`${cls}.${name}`);
      }
    }
    expect(missing).toEqual([]);
    // Invoice, its lines, DocumentTax, Contract and its STI subtypes.
    expect(checked).toBeGreaterThan(40);
  });

  it('describes line amount and unit price in v2 pricing-mode terms (#4012)', () => {
    for (const cls of ['InvoiceLineItem', 'ContractLineItem']) {
      const fields = fieldsOf(cls) as Record<
        string,
        ManifestField & { description?: string }
      >;
      expect(fields.amount.description, `${cls}.amount`).toMatch(
        /net of discount.*including tax only when/,
      );
      expect(fields.unitPrice.description, `${cls}.unitPrice`).toMatch(
        /before discount; includes tax when/,
      );
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
