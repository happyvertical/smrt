import { describe, expect, it } from 'vitest';
import { catalog, getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import {
  blankRecord,
  missingRequired,
  recordTitle,
} from '../src/lib/data/columns.ts';
import { derivedFieldNames, lineAmount } from '../src/lib/data/derived.ts';
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

describe('line and parent amounts (smrt money model)', () => {
  it('prices a line at quantity x unit price less its discount, tax apart', () => {
    expect(lineAmount({ quantity: 3, unitPrice: 1000 })).toBe(3000);
    expect(
      lineAmount({
        quantity: 2,
        unitPrice: 1000,
        discountType: 'amount',
        discount: 500,
      }),
    ).toBe(1500);
    expect(
      lineAmount({
        quantity: 2,
        unitPrice: 1000,
        discountType: 'percent',
        discountRate: '10',
      }),
    ).toBe(1800);
    // A discount with no kind is no discount: the model reads `discountType`.
    expect(lineAmount({ quantity: 1, unitPrice: 1000, discount: 300 })).toBe(
      1000,
    );
  });

  it("marks a line's money and a parent's totals as calculated", () => {
    expect([...derivedFieldNames(lineItem, false)]).toEqual([
      'amount',
      'taxAmount',
      'taxRate',
      'taxCodeCode',
      'taxCodeName',
    ]);
    expect([...derivedFieldNames(agreement, true)]).toEqual([
      'subtotal',
      'taxAmount',
      'totalAmount',
      'discountTotal',
    ]);
    expect(derivedFieldNames(agreement, false).size).toBe(0);
  });

  it('settles lines and totals on add, edit and delete, at the default 5%', async () => {
    const data = source();
    const parent = await data.create(agreement, {});
    const a = await data.create(lineItem, {
      contractId: parent.id,
      quantity: 3,
      unitPrice: 1000,
      amount: 0,
    });
    expect(a).toMatchObject({ amount: 3000, taxAmount: 150, taxRate: 0.05 });
    expect(await data.get(agreement, parent.id)).toMatchObject({
      subtotal: 3000,
      taxAmount: 150,
      totalAmount: 3150,
      discountTotal: 0,
    });
    const b = await data.create(lineItem, {
      contractId: parent.id,
      quantity: 1,
      unitPrice: 500,
      // A typed rate is not an input: the line's code decides its tax.
      taxRate: 0.2,
      discountType: 'amount',
      discount: 100,
    });
    expect(b).toMatchObject({ amount: 400, taxAmount: 20, discount: 100 });
    expect(await data.get(agreement, parent.id)).toMatchObject({
      subtotal: 3400,
      taxAmount: 170,
      totalAmount: 3570,
      discountTotal: 100,
    });
    await data.update(lineItem, a.id, { quantity: 1 });
    expect((await data.get(agreement, parent.id))?.totalAmount).toBe(1470);
    await data.delete(lineItem, b.id);
    const left = await data.get(agreement, parent.id);
    expect(left).toMatchObject({
      subtotal: 1000,
      taxAmount: 50,
      totalAmount: 1050,
    });
    // A form cannot overwrite the calculated total.
    await data.update(agreement, parent.id, { totalAmount: 99999 });
    expect((await data.get(agreement, parent.id))?.totalAmount).toBe(1050);
  });

  it('refuses money the model refuses and leaves the rows as they were', async () => {
    const data = source();
    const parent = await data.create(agreement, {});
    const line = await data.create(lineItem, {
      contractId: parent.id,
      quantity: 1,
      unitPrice: 1000,
    });
    await expect(
      data.update(lineItem, line.id, {
        discountType: 'amount',
        discount: 5000,
      }),
    ).rejects.toThrow();
    expect(await data.get(lineItem, line.id)).toMatchObject({
      amount: 1000,
      discount: 0,
    });
    expect((await data.get(agreement, parent.id))?.totalAmount).toBe(1050);
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

  it('titles a document by its reference alone', () => {
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
    ).toBe('PO-7');
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
