import { describe, expect, it } from 'vitest';
import { catalog, getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import {
  discounted,
  MISMATCH_AMOUNT,
  MISMATCH_ROW,
} from '../src/lib/data/children.ts';
import { blankChild, rowsOf } from '../src/lib/data/columns.ts';
import { totalsOf } from '../src/lib/data/derived.ts';
import { DEFAULT_SAMPLE_TAX_RATE } from '../src/lib/data/fakes.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import {
  childLinks,
  childTitle,
  hasNavPage,
  lineageNames,
} from '../src/lib/recipes/plumbing.ts';

const C = '@happyvertical/smrt-commerce:';
const names = (id: string) =>
  childLinks(catalog, recipes, id).map((l) => `${l.model.name}.${l.fk}`);

describe('childLinks', () => {
  it('puts line items under every Contract subtype', () => {
    for (const parent of [
      'Agreement',
      'Order',
      'PurchaseOrder',
      'Estimate',
      'WholesaleOrder',
    ]) {
      expect(names(`${C}${parent}`)).toContain('ContractLineItem.contractId');
    }
  });

  it('gives an Invoice its lines and payment allocations', () => {
    expect(names(`${C}Invoice`).sort()).toEqual([
      'InvoiceLineItem.invoiceId',
      'PaymentAllocation.invoiceId',
    ]);
  });

  it('nests fulfilment lines and journal entries', () => {
    expect(names(`${C}Fulfillment`)).toContain(
      'FulfillmentLineItem.fulfillmentId',
    );
    expect(names('@happyvertical/smrt-ledgers:Journal')).toEqual([
      'JournalEntry.journalId',
    ]);
  });

  it('never treats a model with its own menu entry as a child', () => {
    // Issue points at Project but is a nav page of the tracker recipe.
    expect(names('@happyvertical/smrt-projects:Project')).not.toContain(
      'Issue.projectId',
    );
    expect(hasNavPage(recipes, '@happyvertical/smrt-projects:Issue')).toBe(
      true,
    );
    expect(hasNavPage(recipes, `${C}ContractLineItem`)).toBe(false);
  });

  it('falls back to plumbing-shaped models for a model in no recipe', () => {
    const inRecipe = new Set(recipes.flatMap((r) => r.models));
    const parent = catalog.packages
      .flatMap((p) => p.models)
      .find(
        (m) => !inRecipe.has(m.id) && childLinks(catalog, [], m.id).length > 0,
      );
    expect(parent).toBeDefined();
  });
});

describe('childTitle', () => {
  it('drops the parent prefix and pluralises', () => {
    const parents = lineageNames(catalog, `${C}Agreement`);
    expect(parents).toEqual(['Agreement', 'Contract']);
    expect(childTitle('ContractLineItem', parents)).toBe('Line items');
    expect(childTitle('InvoiceLineItem', ['Invoice'])).toBe('Line items');
    expect(childTitle('PaymentAllocation', ['Invoice'])).toBe(
      'Payment allocations',
    );
    expect(childTitle('JournalEntry', ['Journal'])).toBe('Entries');
  });
});

describe('child rows in a record view', () => {
  const lineItem = getModelByQualifiedName(`${C}ContractLineItem`)?.model;

  it('shows only rows whose foreign key points at the record', async () => {
    if (!lineItem) throw new Error('ContractLineItem missing');
    const source = createMemoryDataSource({ empty: [lineItem.id] });
    await source.create(lineItem, { contractId: 'a', description: 'one' });
    await source.create(lineItem, { contractId: 'b', description: 'two' });
    const rows = rowsOf(await source.list(lineItem), 'contractId', 'a');
    expect(rows.map((r) => r.description)).toEqual(['one']);
  });

  it('presets the foreign key on a new child', () => {
    const blank = blankChild([], 'contractId', 'parent-1');
    expect(blank.contractId).toBe('parent-1');
  });
});

describe('sample records come with their line items', () => {
  const source = () =>
    createMemoryDataSource({
      children: {
        models: catalog.packages.flatMap((p) => p.models),
        links: (id) => childLinks(catalog, recipes, id),
      },
    });
  const model = (name: string) => {
    const found = getModelByQualifiedName(name)?.model;
    if (!found) throw new Error(`${name} missing`);
    return found;
  };

  it('gives every sample parent one to four children pointing at it', async () => {
    const data = source();
    for (const [parent, child, fk] of [
      [`${C}Invoice`, `${C}InvoiceLineItem`, 'invoiceId'],
      [`${C}Order`, `${C}ContractLineItem`, 'contractId'],
      [
        '@happyvertical/smrt-ledgers:Journal',
        '@happyvertical/smrt-ledgers:JournalEntry',
        'journalId',
      ],
    ] as const) {
      const parents = await data.list(model(parent));
      const children = await data.list(model(child));
      expect(parents.length).toBeGreaterThan(0);
      for (const record of parents) {
        const mine = rowsOf(children, fk, record.id);
        expect(mine.length).toBeGreaterThanOrEqual(1);
        expect(mine.length).toBeLessThanOrEqual(4);
      }
    }
  });

  it('is deterministic and keeps totals consistent', async () => {
    const [a, b] = [source(), source()];
    const invoice = model(`${C}Invoice`);
    const lines = model(`${C}InvoiceLineItem`);
    // Children first: the parent's totals must still match its lines.
    const first = await a.list(lines);
    expect(first).toEqual(await b.list(lines));
    const invoices = await a.list(invoice);
    invoices.forEach((record, index) => {
      const mine = rowsOf(first, 'invoiceId', record.id);
      // Line amounts are tax-inclusive: they add up to the total. The
      // subtotal is the lines' prices; the total takes off their discounts
      // and adds their tax. One invoice is seeded with stale totals, so the
      // record page's mismatch flag can be seen.
      const stale = index === MISMATCH_ROW ? MISMATCH_AMOUNT : 0;
      const totals = totalsOf(mine);
      expect(record.subtotal).toBe(totals.subtotal + stale);
      expect(record.totalAmount).toBe(
        mine.reduce((total, r) => total + Number(r.amount), 0) + stale,
      );
      expect(record.totalAmount).toBe(totals.totalAmount + stale);
      expect(record.totalAmount).toBe(
        Number(record.subtotal) - totals.discount + Number(record.taxAmount),
      );
    });
  });

  it('taxes every line at one rate and discounts some documents', async () => {
    const data = source();
    const orders = await data.list(model(`${C}Order`));
    const lines = await data.list(model(`${C}ContractLineItem`));
    let discounts = 0;
    for (const order of orders) {
      const mine = rowsOf(lines, 'contractId', order.id);
      for (const line of mine) {
        expect(line.taxRate).toBe(DEFAULT_SAMPLE_TAX_RATE);
        expect(Number.isInteger(line.amount)).toBe(true);
      }
      if (discounted(order)) {
        discounts += 1;
        expect(Number(mine[0]?.discount)).toBeGreaterThan(0);
      }
      expect(Number(order.taxAmount)).toBeGreaterThan(0);
    }
    expect(discounts).toBeGreaterThan(0);
    expect(discounts).toBeLessThan(orders.length);
  });

  it('leaves out a discount the app hides, and its totals agree', async () => {
    const lineModel = model(`${C}ContractLineItem`);
    const data = createMemoryDataSource({
      defaults: (m) => (m.id === lineModel.id ? { discount: 0 } : {}),
      children: {
        models: catalog.packages.flatMap((p) => p.models),
        links: (id) => childLinks(catalog, recipes, id),
      },
    });
    const orders = await data.list(model(`${C}Order`));
    const lines = await data.list(lineModel);
    expect(lines.every((l) => l.discount === 0)).toBe(true);
    orders.forEach((order, index) => {
      if (index === MISMATCH_ROW) return;
      const mine = rowsOf(lines, 'contractId', order.id);
      expect(order.totalAmount).toBe(totalsOf(mine).totalAmount);
    });
  });

  it('seeds one order whose stored subtotal disagrees with its lines', async () => {
    const data = source();
    const orders = await data.list(model(`${C}Order`));
    const lines = await data.list(model(`${C}ContractLineItem`));
    const off = orders.filter((order) => {
      const mine = rowsOf(lines, 'contractId', order.id);
      return order.subtotal !== totalsOf(mine).subtotal;
    });
    expect(off.map((o) => o.id)).toEqual([orders[MISMATCH_ROW]?.id]);
    // Editing the order recomputes its totals from the lines.
    const stale = off[0];
    if (!stale) throw new Error('no stale order');
    await data.update(model(`${C}Order`), stale.id, { notes: 'checked' });
    const fixed = await data.get(model(`${C}Order`), stale.id);
    const mine = rowsOf(lines, 'contractId', stale.id);
    expect(fixed?.totalAmount).toBe(totalsOf(mine).totalAmount);
  });

  it('balances a journal', async () => {
    const data = source();
    const entries = await data.list(
      model('@happyvertical/smrt-ledgers:JournalEntry'),
    );
    for (const journal of await data.list(
      model('@happyvertical/smrt-ledgers:Journal'),
    )) {
      const mine = rowsOf(entries, 'journalId', journal.id);
      const sum = (key: string) => mine.reduce((t, r) => t + Number(r[key]), 0);
      expect(sum('debit')).toBe(sum('credit'));
    }
  });
});
