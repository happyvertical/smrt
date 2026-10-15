/**
 * The record page's data (smrt#3718 record page): documents named by their
 * identifier, the records loader's table cells and totals, and the sample
 * documents' line items and totals.
 */
import {
  type LineItemsWidgetData,
  lineItemTotals,
  type RelatedWidgetData,
} from '@happyvertical/smrt-svelte/overview';
import { relationKey } from '@happyvertical/smrt-svelte/screens';
import { describe, expect, it } from 'vitest';
import { catalog } from '../src/lib/catalog/index.ts';
import {
  discounted,
  MISMATCH_AMOUNT,
  MISMATCH_ROW,
} from '../src/lib/data/children.ts';
import {
  identifierField,
  recordHeading,
  recordName,
} from '../src/lib/data/display.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import {
  detailOverviewFor,
  detailOverviewId,
} from '../src/lib/overviews/definitions.ts';
import { loadSectionWidget } from '../src/lib/overviews/page.ts';
import { plannerLoaders } from '../src/lib/overviews/registry.ts';
import { recipes, recipesById } from '../src/lib/recipes/index.ts';
import { childLinks } from '../src/lib/recipes/plumbing.ts';
import { appModels, screenRelations } from '../src/lib/screens/relations.ts';
import { documentTotals } from '../src/lib/screens/totals.ts';

const C = '@happyvertical/smrt-commerce:';
const CUSTOMER = `${C}Customer`;
const ORDER = `${C}Order`;
const INVOICE = `${C}Invoice`;
const PAYMENT = `${C}Payment`;

const model = (id: string) => {
  const found = catalog.packages
    .flatMap((p) => p.models)
    .find((m) => m.id === id);
  if (!found) throw new Error(`${id} missing from catalog`);
  return found;
};
function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`${what} missing`);
  return value;
}

describe('document labels', () => {
  const none = () => undefined;

  it('find the identifier by the framework roles, never on a named model', () => {
    expect(identifierField(model(ORDER))?.name).toBe('reference');
    expect(identifierField(model(INVOICE))?.name).toBe('invoiceNumber');
    expect(
      identifierField(model('@happyvertical/smrt-inventory:InventoryLocation')),
    ).toBeUndefined();
    expect(identifierField(model(CUSTOMER))).toBeUndefined();
  });

  it('name a document by its identifier and head its page with its kind', () => {
    const order = { id: 'o1', reference: 'GRA-3159', customerId: 'c1' };
    const party = () => 'Ridgeline Construction';
    const name = must(recordName(model(ORDER), order, party));
    expect(name).toBe('GRA-3159');
    expect(recordHeading(model(ORDER), order, name, 'Order')).toBe(
      'Order GRA-3159',
    );
    // No identifier: the party, amount and date of a money record.
    const payment = {
      id: 'p1',
      customerId: 'c1',
      amount: 7130,
      paidAt: '2026-03-04T00:00:00.000Z',
    };
    const paid = must(recordName(model(PAYMENT), payment, () => 'Ada'));
    expect(paid).toBe('Ada · $71.30 · 2026-03-04');
    expect(recordHeading(model(PAYMENT), payment, paid, 'Payment')).toBe(paid);
    expect(recordName(model(ORDER), { id: 'x' }, none)).toBeUndefined();
  });
});

describe('the records loader as a table', () => {
  const records = must(plannerLoaders.records, 'records loader');
  const href = (path: string) => `#${path}`;

  it('fills cells by role and totals every matching row, in minor units', async () => {
    const source = createMemoryDataSource();
    const [customer] = await source.list(model(CUSTOMER));
    const ctx = {
      overviewId: 'detail:commerce.Customer',
      source,
      href,
      record: { model: CUSTOMER, id: must(customer).id },
    };
    const options = {
      model: ORDER,
      filter: 'parent',
      field: 'customerId',
      limit: 2,
    };
    const data = await records(options, ctx as never);
    const all = await source.listWhere(
      model(ORDER),
      'customerId',
      must(customer).id,
    );
    expect(all.length).toBeGreaterThan(2);
    expect(data.rows).toHaveLength(2);
    // Default columns by role, the parent link left out (a sales document has
    // a customer only, since smrt 0.56).
    expect(data.columns?.map((c) => [c.key, c.role])).toEqual([
      ['reference', 'identifier'],
      ['status', 'status'],
      ['issueDate', 'date'],
      ['totalAmount', 'money'],
    ]);
    expect(data.total).toBe(all.length);
    const row = must(data.rows[0]);
    const source0 = must(all.find((o) => o.id === row.id));
    expect(row.cells?.reference).toBe(source0.reference);
    expect(row.cells?.status).toBe(source0.status);
    // A reference reads as its record's name, never an id.
    const named = await records(
      { ...options, columns: 'reference,customerId' },
      ctx as never,
    );
    const namedRow = must(named.rows[0]);
    const namedSource = must(all.find((o) => o.id === namedRow.id));
    expect(String(namedRow.cells?.customerId)).not.toBe(
      String(namedSource.customerId),
    );

    // Money columns sum over all matching rows, not the page.
    const money = await records(
      { ...options, columns: 'reference,totalAmount,subtotal' },
      ctx as never,
    );
    expect(money.columns?.map((c) => c.role)).toEqual([
      'identifier',
      'money',
      'money',
    ]);
    const sum = (key: string) =>
      all.reduce((total, o) => total + Number(o[key]), 0);
    expect(money.summaries).toEqual({
      totalAmount: sum('totalAmount'),
      subtotal: sum('subtotal'),
    });
    expect(Number.isInteger(money.summaries?.totalAmount)).toBe(true);
    expect(money.rows[0]?.cells?.totalAmount).toBe(
      all.find((o) => o.id === money.rows[0]?.id)?.totalAmount,
    );
    // A line table: the unit price is shown, never summed.
    const [order] = all;
    const lines = await records(
      {
        model: `${C}ContractLineItem`,
        filter: 'parent',
        field: 'contractId',
        columns: 'description,quantity,unitPrice,amount',
        limit: 50,
      },
      { ...ctx, record: { model: ORDER, id: must(order).id } } as never,
    );
    expect(lines.columns?.find((c) => c.key === 'unitPrice')).toMatchObject({
      role: 'money',
      summarize: false,
    });
    expect(Object.keys(lines.summaries ?? {}).sort()).toEqual([
      'amount',
      'quantity',
    ]);
    await expect(
      records({ ...options, columns: 'nope' }, ctx as never),
    ).rejects.toThrow(/no field nope/);
  });
});

describe('the record page widgets', () => {
  const href = (path: string) => `#${path}`;
  const inApp = appModels(
    [must(recipesById.get('commerce.sales'), 'commerce.sales')],
    [],
  );

  async function orderPage(index: number) {
    // Sample parents come with their line items, as in the app.
    const source = createMemoryDataSource({
      children: {
        models: catalog.packages.flatMap((p) => p.models),
        links: (id) => childLinks(catalog, recipes, id),
      },
    });
    const orders = await source.list(model(ORDER));
    const order = must(orders[index], `order ${index}`);
    const relations = screenRelations(catalog, ORDER, inApp);
    const items = must(relations.find((r) => r.kind === 'items'));
    const lines = await source.listWhere(
      model(items.model),
      items.field,
      order.id,
    );
    const definition = must(
      detailOverviewFor(detailOverviewId('commerce', 'Order'), inApp),
    );
    const ctx = {
      source,
      sections: [],
      entryIndex: new Map(),
      href,
      record: { model: ORDER, id: order.id },
      relations,
    };
    const widget = (type: string) =>
      must(
        definition.defaults.find((w) => w.type === type),
        type,
      );
    return { source, order, lines, definition, ctx, widget };
  }

  it('lists the lines with the record totals, which agree with them', async () => {
    const page = await orderPage(0);
    const data = (await loadSectionWidget(
      page.definition,
      page.ctx,
      page.widget('line-items'),
    )) as LineItemsWidgetData;
    expect(page.lines.length).toBeGreaterThan(0);
    expect(data.rows).toHaveLength(page.lines.length);
    expect(data.columns.map((c) => c.key)).toEqual([
      'description',
      'quantity',
      'unitPrice',
      'amount',
    ]);
    const amounts = page.lines.reduce((t, l) => t + Number(l.amount), 0);
    expect(data.summaries?.amount).toBe(amounts);
    // Lines live inside the order: no row links, no "View all".
    expect(data.rows.some((row) => row.href)).toBe(false);
    expect(data.href).toBeUndefined();
    expect(data.totals?.subtotal).toBe(page.order.subtotal);
    expect(data.totals?.tax).toBe(page.order.taxAmount);
    expect(data.totals?.total).toBe(page.order.totalAmount);
    expect(lineItemTotals(data.totals, amounts).mismatch).toBeNull();
  });

  it('flags the seeded order whose subtotal disagrees with its lines', async () => {
    const page = await orderPage(MISMATCH_ROW);
    const data = (await loadSectionWidget(
      page.definition,
      page.ctx,
      page.widget('line-items'),
    )) as LineItemsWidgetData;
    const result = lineItemTotals(data.totals, data.summaries?.amount ?? null);
    // The lines add up to the true (tax-inclusive) total, not the stale one,
    // so the widget checks the recorded subtotal against them and flags it.
    expect(data.summaries?.amount).toBe(
      Number(page.order.totalAmount) - MISMATCH_AMOUNT,
    );
    expect(result.mismatch).toEqual({
      field: 'subtotal',
      recorded: Number(page.order.subtotal),
      lines: Number(page.order.totalAmount) - MISMATCH_AMOUNT,
    });
  });

  it('flags only the seeded stale Order and Invoice, never a correct one', async () => {
    // smrt-svelte 0.55.24's widget reads commerce line amounts as
    // tax-inclusive (smrt#3954): lines adding up to the recorded total agree.
    const source = createMemoryDataSource({
      children: {
        models: catalog.packages.flatMap((p) => p.models),
        links: (id) => childLinks(catalog, recipes, id),
      },
    });
    for (const [parentId, lineId, fk] of [
      [ORDER, `${C}ContractLineItem`, 'contractId'],
      [INVOICE, `${C}InvoiceLineItem`, 'invoiceId'],
    ] as const) {
      const parents = await source.list(model(parentId));
      const lines = await source.list(model(lineId));
      const flagged = parents.flatMap((parent, index) => {
        const mine = lines.filter((l) => l[fk] === parent.id);
        const sum = mine.reduce((t, l) => t + Number(l.amount), 0);
        const totals = documentTotals(model(parentId), parent, mine);
        return lineItemTotals(totals, sum).mismatch ? [index] : [];
      });
      expect(parents.length).toBeGreaterThan(MISMATCH_ROW + 1);
      expect(flagged, parentId).toEqual([MISMATCH_ROW]);
    }
  });

  it('reads a discounted order discount from its lines at load time', async () => {
    const first = await orderPage(0);
    const orders = await first.source.list(model(ORDER));
    const index = orders.findIndex(
      (o, i) => i !== MISMATCH_ROW && discounted(o),
    );
    const page = await orderPage(index);
    const data = (await loadSectionWidget(
      page.definition,
      page.ctx,
      page.widget('line-items'),
    )) as LineItemsWidgetData;
    const discount = page.lines.reduce((t, l) => t + Number(l.discount), 0);
    expect(discount).toBeGreaterThan(0);
    expect(data.totals?.discount).toBe(discount);
    expect(data.totals?.total).toBe(
      Number(page.order.subtotal) - discount + Number(page.order.taxAmount),
    );
    expect(
      lineItemTotals(data.totals, data.summaries?.amount ?? null).mismatch,
    ).toBeNull();
  });

  it('shows a discount from the lines when the document has no field for it', () => {
    const totals = documentTotals(
      model(ORDER),
      { id: 'o', subtotal: 2000, taxAmount: 90, totalAmount: 1890 },
      [{ quantity: 2, unitPrice: 1000, discount: 200, taxRate: 0.05 }],
    );
    expect(totals).toEqual({
      subtotal: 2000,
      discount: 200,
      tax: 90,
      total: 1890,
    });
    expect(lineItemTotals(totals, 2000).mismatch).toBeNull();
  });

  it('tabs the related records with columns and totals over every row', async () => {
    const source = createMemoryDataSource();
    const [customer] = await source.list(model(CUSTOMER));
    const relations = screenRelations(catalog, CUSTOMER, inApp);
    const definition = must(
      detailOverviewFor(detailOverviewId('commerce', 'Customer'), inApp),
    );
    const related = must(definition.defaults.find((w) => w.type === 'related'));
    const data = (await loadSectionWidget(
      definition,
      {
        source,
        sections: [],
        entryIndex: new Map(),
        href,
        record: { model: CUSTOMER, id: must(customer).id },
        relations,
      },
      related,
    )) as RelatedWidgetData;
    const tab = must(data.tabs.find((t) => t.key === 'Order-customerId'));
    const orders = await source.listWhere(
      model(ORDER),
      'customerId',
      must(customer).id,
    );
    expect(tab.total).toBe(orders.length);
    expect(tab.columns.map((c) => c.key)).toEqual([
      'reference',
      'status',
      'issueDate',
      'totalAmount',
    ]);
    expect(tab.summaries?.totalAmount).toBe(
      orders.reduce((t, o) => t + Number(o.totalAmount), 0),
    );
    // Every tab is one of the app's related models; no line items here.
    for (const t of data.tabs) {
      expect(relations.some((r) => relationKey(r) === t.key)).toBe(true);
    }
    // The money tile of the strip sums every order's total.
    const sum = must(
      definition.defaults.find(
        (w) => w.options.model === ORDER && w.options.measure === 'sum',
      ),
    );
    const tile = (await loadSectionWidget(
      definition,
      {
        source,
        sections: [],
        entryIndex: new Map(),
        href,
        record: { model: CUSTOMER, id: must(customer).id },
      },
      sum,
    )) as { value: number; format: string };
    expect(tile).toMatchObject({
      value: tab.summaries?.totalAmount,
      format: 'money',
    });
  });
});
