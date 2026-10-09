import { beforeEach, describe, expect, it } from 'vitest';
import { catalog, getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import {
  cellValue,
  listColumns,
  recordTitle,
} from '../src/lib/data/columns.ts';
import {
  derivedFieldNames,
  isProductField,
  productPrefill,
  settleInvoice,
} from '../src/lib/data/derived.ts';
import { PRODUCT_CATALOG } from '../src/lib/data/fakes.ts';
import { singularize } from '../src/lib/data/format.ts';
import { recordLabel, relationLabels } from '../src/lib/data/labels.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { childLinks } from '../src/lib/recipes/plumbing.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const C = '@happyvertical/smrt-commerce:';
const model = (id: string) => {
  const found = getModelByQualifiedName(id)?.model;
  if (!found) throw new Error(`${id} missing`);
  return found;
};
const invoice = model(`${C}Invoice`);
const payment = model(`${C}Payment`);
const allocation = model(`${C}PaymentAllocation`);
const order = model(`${C}Order`);
const lineItem = model(`${C}ContractLineItem`);

const NOW = Date.UTC(2026, 5, 1);
const source = () =>
  createMemoryDataSource({
    now: () => NOW,
    children: {
      models: catalog.packages.flatMap((p) => p.models),
      links: (id) => childLinks(catalog, recipes, id),
    },
  });

beforeEach(() => {
  recipeState.add('commerce.invoicing');
  recipeState.add('commerce.sales');
});

describe('record labels', () => {
  it('names an invoice by its number and customer, never an id', async () => {
    const s = source();
    const rows = await s.list(invoice);
    for (const row of rows) {
      const label = await recordLabel(s, invoice, row);
      expect(label).toContain(String(row.invoiceNumber));
      expect(label).not.toContain(String(row.id).slice(0, 8));
    }
  });

  it('labels the relations of an invoice, payment and allocation', async () => {
    const s = source();
    for (const m of [invoice, payment, allocation]) {
      const rows = await s.list(m);
      const fields = recipeState.apply(m).fields;
      const labels = await relationLabels(s, fields, rows);
      for (const row of rows) {
        for (const f of fields.filter((x) => x.related)) {
          const id = row[f.name];
          if (typeof id !== 'string' || !id) continue;
          const label = labels.get(`${f.related}:${id}`);
          if (label === undefined) continue;
          expect(label).not.toBe(id.slice(0, 8));
        }
      }
    }
  });

  it('leads an invoice title with its number, the row aria-label too', () => {
    const fields = recipeState.apply(invoice).fields;
    const customer = fields.find((f) => f.name === 'customerId');
    const labels = new Map([[`${customer?.related}:c1`, 'Lantern Collective']]);
    expect(
      recordTitle(
        invoice,
        fields,
        { customerId: 'c1', invoiceNumber: 'WIL-1133', reference: 'x' },
        labels,
      ),
    ).toBe('WIL-1133 · Lantern Collective');
  });

  it('titles a payment by customer, amount and date', () => {
    const fields = recipeState.apply(payment).fields;
    const customer = fields.find((f) => f.name === 'customerId');
    const labels = new Map([[`${customer?.related}:c1`, 'Ada Nguyen']]);
    expect(
      recordTitle(
        payment,
        fields,
        { customerId: 'c1', amount: 7130, paidAt: '2026-03-04T00:00:00.000Z' },
        labels,
      ),
    ).toBe('Ada Nguyen · $71.30 · 2026-03-04');
  });
});

describe('list columns', () => {
  it('shows status, total and amount due on invoices, not the contract', () => {
    const columns = listColumns(recipeState.apply(invoice).fields);
    const names = columns.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['status', 'totalAmount', 'amountDue']),
    );
    expect(names).not.toContain('contractId');
    expect(columns.length).toBeLessThanOrEqual(6);
    const due = columns.find((c) => c.name === 'amountDue');
    expect(
      due && cellValue(due, { totalAmount: 10000, amountPaid: 2500 }),
    ).toBe(7500);
  });

  it('keeps payments and orders to meaningful columns', () => {
    for (const m of [payment, order]) {
      const names = listColumns(recipeState.apply(m).fields).map((c) => c.name);
      expect(names.length).toBeLessThanOrEqual(6);
      expect(names).toContain('status');
      expect(names).toContain('customerId');
    }
    expect(
      listColumns(recipeState.apply(payment).fields).map((c) => c.name),
    ).toContain('amount');
    expect(
      listColumns(recipeState.apply(order).fields).map((c) => c.name),
    ).toContain('totalAmount');
  });
});

describe('invoice payment state', () => {
  it('derives amount paid from completed payments only', () => {
    const inv = { totalAmount: 10000, status: 'sent', dueDate: '2026-12-01' };
    const part = settleInvoice(inv, [{ amount: 4000, at: '2026-01-02' }], NOW);
    expect(part).toMatchObject({ amountPaid: 4000, status: 'sent' });
    expect(part.paidDate).toBeNull();
    const full = settleInvoice(
      inv,
      [
        { amount: 4000, at: '2026-01-02' },
        { amount: 6000, at: '2026-02-03' },
      ],
      NOW,
    );
    expect(full).toMatchObject({ amountPaid: 10000, status: 'paid' });
    expect(full.paidDate).toBe('2026-02-03');
    expect(
      settleInvoice({ ...inv, dueDate: '2026-01-01' }, [], NOW).status,
    ).toBe('overdue');
    expect(settleInvoice({ ...inv, status: 'draft' }, [], NOW).status).toBe(
      'draft',
    );
  });

  it('makes amount paid and paid date read-only with allocations', () => {
    const names = derivedFieldNames(invoice, true, true);
    expect(names.has('amountPaid')).toBe(true);
    expect(names.has('paidDate')).toBe(true);
    expect(derivedFieldNames(invoice, true, false).has('amountPaid')).toBe(
      false,
    );
  });

  it('keeps sample invoices consistent with their allocations', async () => {
    const s = source();
    const invoices = await s.list(invoice);
    const payments = new Map((await s.list(payment)).map((p) => [p.id, p]));
    const allocations = await s.list(allocation);
    for (const inv of invoices) {
      const paid = allocations
        .filter(
          (a) =>
            a.invoiceId === inv.id &&
            payments.get(String(a.paymentId))?.status === 'completed',
        )
        .reduce((sum, a) => sum + Number(a.amount), 0);
      expect(inv.amountPaid).toBe(paid);
      expect(paid).toBeLessThanOrEqual(Number(inv.totalAmount));
      if (paid >= Number(inv.totalAmount) && paid > 0) {
        expect(inv.status).toBe('paid');
        expect(inv.paidDate).toBeTruthy();
      } else {
        expect(inv.status).not.toBe('paid');
        expect(inv.paidDate ?? null).toBeNull();
      }
    }
  });

  it('follows an allocation added later', async () => {
    const s = source();
    const [inv] = (await s.list(invoice)).filter(
      (i) => Number(i.totalAmount) > 0 && i.status !== 'draft',
    );
    if (!inv) throw new Error('no invoice');
    const done = (await s.list(payment)).find((p) => p.status === 'completed');
    if (!done) throw new Error('no completed payment');
    const before = Number((await s.get(invoice, inv.id))?.amountPaid ?? 0);
    await s.create(allocation, {
      paymentId: done.id,
      invoiceId: inv.id,
      amount: 100,
      allocatedAt: '2026-05-01T00:00:00.000Z',
    });
    expect((await s.get(invoice, inv.id))?.amountPaid).toBe(before + 100);
  });
});

describe('sample payments and allocations', () => {
  it('only completed payments allocate, to their own customer, in order', async () => {
    const s = source();
    const invoices = new Map((await s.list(invoice)).map((i) => [i.id, i]));
    const payments = new Map((await s.list(payment)).map((p) => [p.id, p]));
    const allocations = await s.list(allocation);
    expect(allocations.length).toBeGreaterThan(0);
    const perPayment = new Map<string, number>();
    const perInvoice = new Map<string, number>();
    for (const a of allocations) {
      const p = payments.get(String(a.paymentId));
      const i = invoices.get(String(a.invoiceId));
      if (!p || !i) throw new Error('dangling allocation');
      expect(p.status).toBe('completed');
      expect(p.customerId).toBe(i.customerId);
      expect(a.allocatedAt).toBe(p.paidAt);
      expect(Date.parse(String(a.allocatedAt))).toBeGreaterThanOrEqual(
        Date.parse(String(i.issueDate)),
      );
      perPayment.set(p.id, (perPayment.get(p.id) ?? 0) + Number(a.amount));
      perInvoice.set(i.id, (perInvoice.get(i.id) ?? 0) + Number(a.amount));
    }
    for (const [id, sum] of perPayment) {
      expect(sum).toBeLessThanOrEqual(Number(payments.get(id)?.amount));
    }
    for (const [id, sum] of perInvoice) {
      expect(sum).toBeLessThanOrEqual(Number(invoices.get(id)?.totalAmount));
    }
  });

  it('generates each allocation once', async () => {
    const s = source();
    const ids = (await s.list(allocation)).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('products on line items', () => {
  it('fills description and unit price from a picked product', () => {
    expect(
      productPrefill(lineItem, { name: 'Canvas tote', price: 2400 }),
    ).toEqual({ description: 'Canvas tote', unitPrice: 2400 });
    expect(productPrefill(lineItem, { name: '' })).toEqual({});
    expect(productPrefill(lineItem, undefined)).toEqual({});
    const field = lineItem.fields.find((f) => f.name === 'productId');
    expect(field && isProductField(field)).toBe(true);
  });

  it('gives sample products product-like names and lines item descriptions', async () => {
    const s = source();
    const names = new Set(PRODUCT_CATALOG.map((p) => p.name));
    const products = await s.list(
      model('@happyvertical/smrt-products:Product'),
    );
    for (const p of products) expect(names.has(String(p.name))).toBe(true);
    const lines = await s.list(lineItem);
    for (const line of lines) {
      expect(names.has(String(line.description))).toBe(true);
    }
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const line of lines) {
      const product = byId.get(String(line.productId));
      if (product) {
        expect(line.description).toBe(product.name);
        expect(line.unitPrice).toBe(product.price);
      }
    }
  });
});

describe('sales order form', () => {
  it('hides the quote-only expiry date on orders', () => {
    recipeState.add('commerce.purchases');
    recipeState.add('commerce.wholesale');
    for (const name of ['Order', 'PurchaseOrder', 'WholesaleOrder']) {
      const m = model(`${C}${name}`);
      const names = recipeState.apply(m).fields.map((f) => f.name);
      expect(names).not.toContain('expiryDate');
    }
  });

  it('names the New button after the menu entry', () => {
    expect(singularize('Sales Orders').toLowerCase()).toBe('sales order');
    expect(singularize('Invoices')).toBe('Invoice');
    expect(singularize('Currencies')).toBe('Currency');
    expect(singularize('Addresses')).toBe('Address');
  });
});
