import { describe, expect, it } from 'vitest';
import { catalog, getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { blankChild, rowsOf } from '../src/lib/data/columns.ts';
import { totalsOf } from '../src/lib/data/derived.ts';
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
    for (const record of await a.list(invoice)) {
      const mine = rowsOf(first, 'invoiceId', record.id);
      // Totals follow the commerce semantics: the amounts before tax, and the
      // lines' own (taxed) amounts for the total.
      expect(record.subtotal).toBe(totalsOf(mine).subtotal);
      expect(record.totalAmount).toBe(
        mine.reduce((total, r) => total + Number(r.amount), 0),
      );
    }
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
