import { describe, expect, it } from 'vitest';
import { catalog, getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import {
  blankRecord,
  missingRequired,
  recordTitle,
} from '../src/lib/data/columns.ts';
import {
  derivedFieldNames,
  lineAmounts,
  totalsOf,
} from '../src/lib/data/derived.ts';
import { fakeRecords, TAX_RATES } from '../src/lib/data/fakes.ts';
import {
  fieldLabel,
  formatValue,
  pluralize,
  recordCount,
} from '../src/lib/data/format.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { childLinks } from '../src/lib/recipes/plumbing.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const C = '@happyvertical/smrt-commerce:';
const model = (name: string) => {
  const found = getModelByQualifiedName(`${C}${name}`);
  if (!found) throw new Error(name);
  return found.model;
};
const agreement = model('Agreement');
const lineItem = model('ContractLineItem');

const source = () =>
  createMemoryDataSource({
    empty: [`${C}Agreement`],
    children: {
      models: catalog.packages.flatMap((p) => p.models),
      links: (id) => childLinks(catalog, recipes, id),
    },
  });

describe('line and parent amounts', () => {
  it('prices a line as quantity x unit price, less discount, plus tax', () => {
    expect(lineAmounts({ quantity: 3, unitPrice: 1000 }).amount).toBe(3000);
    expect(
      lineAmounts({
        quantity: 2,
        unitPrice: 1000,
        discount: 500,
        taxRate: 0.1,
      }),
    ).toEqual({ subtotal: 1500, tax: 150, amount: 1650 });
  });

  it('sums lines into subtotal, tax and total', () => {
    expect(
      totalsOf([
        { quantity: 1, unitPrice: 1000, taxRate: 0.05 },
        { quantity: 2, unitPrice: 500, taxRate: 0 },
      ]),
    ).toEqual({ subtotal: 2000, taxAmount: 50, totalAmount: 2050 });
  });

  it('marks line amounts and a parent with lines as calculated', () => {
    expect([...derivedFieldNames(lineItem, false)]).toEqual(['amount']);
    expect(derivedFieldNames(agreement, true).has('totalAmount')).toBe(true);
    expect(derivedFieldNames(agreement, false).size).toBe(0);
  });

  it('computes the amount on save and the parent total on add, edit and delete', async () => {
    const data = source();
    const parent = await data.create(agreement, {});
    const a = await data.create(lineItem, {
      contractId: parent.id,
      quantity: 3,
      unitPrice: 1000,
      amount: 0,
    });
    expect(a.amount).toBe(3000);
    expect((await data.get(agreement, parent.id))?.totalAmount).toBe(3000);
    const b = await data.create(lineItem, {
      contractId: parent.id,
      quantity: 1,
      unitPrice: 500,
      taxRate: 0.2,
    });
    expect(b.amount).toBe(600);
    expect((await data.get(agreement, parent.id))?.totalAmount).toBe(3600);
    await data.update(lineItem, a.id, { quantity: 1 });
    expect((await data.get(agreement, parent.id))?.totalAmount).toBe(1600);
    await data.delete(lineItem, b.id);
    const left = await data.get(agreement, parent.id);
    expect(left?.totalAmount).toBe(1000);
    expect(left?.subtotal).toBe(1000);
    // A form cannot overwrite the calculated total.
    await data.update(agreement, parent.id, { totalAmount: 99999 });
    expect((await data.get(agreement, parent.id))?.totalAmount).toBe(1000);
  });
});

describe('sample data', () => {
  it('uses plausible tax rates and payment terms', () => {
    for (const row of fakeRecords(lineItem, 30)) {
      expect(TAX_RATES as readonly unknown[]).toContain(row.taxRate);
    }
    for (const row of fakeRecords(agreement, 30)) {
      expect(String(row.terms)).toMatch(/Net|Due|deposit/);
      expect(String(row.channelId)).not.toMatch(/ /);
    }
  });

  it('shows a fractional tax rate as a percentage', () => {
    const taxRate = lineItem.fields.find((f) => f.name === 'taxRate');
    if (!taxRate) throw new Error('taxRate');
    expect(formatValue(taxRate, 0.0825)).toBe('8.25%');
    expect(formatValue(taxRate, 0)).toBe('0%');
  });
});

describe('labels and titles', () => {
  it('drops "id" from relation labels', () => {
    const product = lineItem.fields.find((f) => f.name === 'productId');
    if (!product) throw new Error('productId');
    expect(fieldLabel(product)).toBe('Product');
    const sku = lineItem.fields.find((f) => f.name === 'sku');
    expect(sku && fieldLabel(sku)).toBe('Sku');
  });

  it('pluralizes and counts', () => {
    expect(pluralize('Agreement')).toBe('Agreements');
    expect(pluralize('Currency')).toBe('Currencies');
    expect(pluralize('Address')).toBe('Addresses');
    expect(recordCount(1)).toBe('1 record');
    expect(recordCount(8)).toBe('8 records');
  });

  it('titles a record by its related record and reference', () => {
    const view = recipeState.apply(agreement).fields;
    const customer = view.find((f) => f.name === 'customerId');
    const labels = new Map([[`${customer?.related}:c1`, 'Ada Nguyen']]);
    expect(
      recordTitle(
        agreement,
        view,
        { customerId: 'c1', reference: 'PO-7' },
        labels,
      ),
    ).toBe('Ada Nguyen · PO-7');
  });
});

describe('new records', () => {
  it('starts a status at draft and checks required fields', () => {
    const view = recipeState.apply(agreement).fields;
    expect(blankRecord(view).status).toBe('draft');
    const required = view.map((f) =>
      f.name === 'customerId' ? { ...f, required: true } : f,
    );
    expect(missingRequired(required, blankRecord(required))).toEqual({
      customerId: 'Customer is required.',
    });
    expect(
      missingRequired(required, { ...blankRecord(required), customerId: 'x' }),
    ).toEqual({});
  });
});
