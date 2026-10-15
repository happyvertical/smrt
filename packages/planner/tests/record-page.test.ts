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
import { afterEach, describe, expect, it } from 'vitest';
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
import { setSamplePricing, setSampleTaxRate } from '../src/lib/data/packs.ts';
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
import {
  documentTotals,
  storedDocumentTotals,
} from '../src/lib/screens/totals.ts';

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

  afterEach(() => {
    setSamplePricing({});
    setSampleTaxRate(undefined);
  });

  const sampleSource = () =>
    createMemoryDataSource({
      children: {
        models: catalog.packages.flatMap((p) => p.models),
        links: (id) => childLinks(catalog, recipes, id),
      },
    });

  /** A sample document's page: `pick` chooses the order (or invoice) by its row. */
  async function documentPage(
    parentId: typeof ORDER | typeof INVOICE,
    pick: (row: Record<string, unknown>, index: number) => boolean,
  ) {
    // Sample parents come with their line items, as in the app.
    const source = sampleSource();
    const rows = await source.list(model(parentId));
    const index = rows.findIndex((row, i) => pick(row, i));
    const order = must(rows[index], `${parentId} matching`);
    const app =
      parentId === ORDER
        ? inApp
        : appModels(
            [must(recipesById.get('commerce.invoicing'), 'invoicing')],
            [],
          );
    const relations = screenRelations(catalog, parentId, app);
    const items = must(relations.find((r) => r.kind === 'items'));
    const lines = await source.listWhere(
      model(items.model),
      items.field,
      order.id,
    );
    const name = parentId === ORDER ? 'Order' : 'Invoice';
    const definition = must(
      detailOverviewFor(detailOverviewId('commerce', name), app),
    );
    const ctx = {
      source,
      sections: [],
      entryIndex: new Map(),
      href,
      record: { model: parentId, id: order.id },
      relations,
    };
    const widget = (type: string) =>
      must(
        definition.defaults.find((w) => w.type === type),
        type,
      );
    const data = (await loadSectionWidget(
      definition,
      ctx,
      widget('line-items'),
    )) as LineItemsWidgetData;
    return { source, order, index, lines, data };
  }

  const draft = (row: Record<string, unknown>, i: number) =>
    row.status === 'draft' && i !== MISMATCH_ROW;
  const issued = (row: Record<string, unknown>) =>
    typeof row.status === 'string' && row.status !== 'draft';
  const sum = (rows: readonly Record<string, unknown>[], key: string) =>
    rows.reduce((t, r) => t + Number(r[key] ?? 0), 0);

  it('lists a draft order with its live totals, which agree with its lines', async () => {
    const page = await documentPage(ORDER, draft);
    const { data } = page;
    expect(page.lines.length).toBeGreaterThan(0);
    expect(data.rows).toHaveLength(page.lines.length);
    expect(data.columns.map((c) => c.key)).toEqual([
      'description',
      'quantity',
      'unitPrice',
      'amount',
    ]);
    const amounts = sum(page.lines, 'amount');
    expect(data.summaries?.amount).toBe(amounts);
    // Lines live inside the order: no row links, no "View all".
    expect(data.rows.some((row) => row.href)).toBe(false);
    expect(data.href).toBeUndefined();
    expect(data.storedTotals).toBeUndefined();
    // The informational discount stays out of the live block (smrt#4010).
    expect(data.totals).toEqual({
      subtotal: page.order.subtotal,
      tax: page.order.taxAmount,
      total: page.order.totalAmount,
    });
    expect(amounts).toBe(page.order.subtotal);
    expect(lineItemTotals(data.totals, amounts).mismatch).toBeNull();
  });

  it("shows an issued order's frozen totals with a row per tax component", async () => {
    const page = await documentPage(ORDER, issued);
    const stored = must(page.data.storedTotals, 'storedTotals');
    expect(page.data.totals).toBeUndefined();
    expect(stored).toMatchObject({
      subtotal: page.order.subtotal,
      discount: page.order.discountTotal,
      tax: page.order.taxAmount,
      total: page.order.totalAmount,
      lineAmountType: 'exclusive',
      roundingScope: 'line',
    });
    expect(sum(stored.taxes, 'tax')).toBe(page.order.taxAmount);
    // The app's 5% is smrt's cookbook activation code: one component.
    for (const tax of stored.taxes) {
      expect(tax).toMatchObject({ name: 'Cookbook 5%', percent: '5' });
    }
  });

  it('keeps GST and PST apart on an issued invoice of a CAD app at 12%', async () => {
    setSamplePricing({ currency: 'CAD' });
    setSampleTaxRate(0.12);
    const page = await documentPage(
      INVOICE,
      (row) => issued(row) && Number(row.taxAmount) > 0,
    );
    const stored = must(page.data.storedTotals, 'storedTotals');
    expect(stored.taxes.map((t) => `${t.name} ${t.percent}`).sort()).toEqual([
      'BC PST 7% 7',
      'Canada GST 5% 5',
    ]);
    const gst = must(stored.taxes.find((t) => t.percent === '5'));
    const pst = must(stored.taxes.find((t) => t.percent === '7'));
    // Both components tax the same lines: the same base, each its own rate.
    expect(gst.taxable).toBe(pst.taxable);
    expect(gst.tax + pst.tax).toBe(page.order.taxAmount);
    const taxed = page.lines.filter((l) => Number(l.taxAmount) > 0);
    expect(gst.taxable).toBe(sum(taxed, 'amount'));
    expect(
      page.lines.every((l) => l.currency === undefined || l.currency === 'CAD'),
    ).toBe(true);
  });

  it('prices tax-inclusive documents when the app does', async () => {
    setSamplePricing({ pricesIncludeTax: true });
    const page = await documentPage(
      INVOICE,
      (row) => issued(row) && Number(row.taxAmount) > 0,
    );
    const stored = must(page.data.storedTotals, 'storedTotals');
    // Inclusive: a line's amount is its gross; the total is what the lines
    // add up to and the subtotal is that less the tax inside it.
    expect(page.order.lineAmountType).toBe('inclusive');
    expect(stored.lineAmountType).toBe('inclusive');
    expect(stored.showNetSubtotal).toBe(true);
    expect(stored.total).toBe(sum(page.lines, 'amount'));
    expect(stored.subtotal).toBe(stored.total - stored.tax);
    for (const tax of stored.taxes) {
      expect(tax.taxable).toBe(
        sum(
          page.lines.filter((l) => Number(l.taxAmount) > 0),
          'amount',
        ) - sum(page.lines, 'taxAmount'),
      );
    }
    const live = await documentPage(INVOICE, draft);
    expect(live.data.storedTotals).toBeUndefined();
    expect(
      lineItemTotals(live.data.totals, sum(live.lines, 'amount')).mismatch,
    ).toBeNull();
  });

  it('rounds tax once per document when the app does', async () => {
    setSamplePricing({ taxRounding: 'document' });
    const page = await documentPage(ORDER, issued);
    expect(page.order.taxRoundingScope).toBe('document');
    expect(page.data.storedTotals?.roundingScope).toBe('document');
  });

  it('flags the seeded draft order whose subtotal disagrees with its lines', async () => {
    const page = await documentPage(ORDER, (_row, i) => i === MISMATCH_ROW);
    expect(page.order.status).toBe('draft');
    const result = lineItemTotals(
      page.data.totals,
      page.data.summaries?.amount ?? null,
    );
    // The lines add up to the true subtotal, not the stale one.
    expect(page.data.summaries?.amount).toBe(
      Number(page.order.subtotal) - MISMATCH_AMOUNT,
    );
    expect(result.mismatch).toEqual({
      field: 'subtotal',
      recorded: Number(page.order.subtotal),
      lines: Number(page.order.subtotal) - MISMATCH_AMOUNT,
    });
  });

  it('flags only the seeded stale Order and Invoice, never a correct one', async () => {
    const source = sampleSource();
    for (const [parentId, lineId, fk] of [
      [ORDER, `${C}ContractLineItem`, 'contractId'],
      [INVOICE, `${C}InvoiceLineItem`, 'invoiceId'],
    ] as const) {
      const parents = await source.list(model(parentId));
      const lines = await source.list(model(lineId));
      const flagged = parents.flatMap((parent, index) => {
        const mine = lines.filter((l) => l[fk] === parent.id);
        if (storedDocumentTotals(model(parentId), parent, mine)) return [];
        const totals = documentTotals(model(parentId), parent);
        return lineItemTotals(totals, sum(mine, 'amount')).mismatch
          ? [index]
          : [];
      });
      expect(parents.length).toBeGreaterThan(MISMATCH_ROW + 1);
      expect(flagged, parentId).toEqual([MISMATCH_ROW]);
    }
  });

  it("reports a discounted document's discount without taking it off again", async () => {
    const page = await documentPage(
      ORDER,
      (row, i) =>
        i !== MISMATCH_ROW && issued(row) && discounted(row as { id: string }),
    );
    const discount = sum(page.lines, 'discount');
    expect(discount).toBeGreaterThan(0);
    const stored = must(page.data.storedTotals, 'storedTotals');
    expect(stored.discount).toBe(discount);
    // The discount is already inside the subtotal: total = subtotal + tax.
    expect(stored.subtotal).toBe(sum(page.lines, 'amount'));
    expect(stored.total).toBe(stored.subtotal + stored.tax);
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
