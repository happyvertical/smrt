import { afterEach, describe, expect, it } from 'vitest';
import { catalog, getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { listColumns } from '../src/lib/data/columns.ts';
import { fakeRecords } from '../src/lib/data/fakes.ts';
import { createNoun, formatValue } from '../src/lib/data/format.ts';
import { relationLabels } from '../src/lib/data/labels.ts';
import { COOKBOOK_PACKS, setSamplePack } from '../src/lib/data/packs.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { catalogModels } from '../src/lib/forms/shared.ts';
import { stockSamples } from '../src/lib/forms/stock.ts';
import { getLibraryCookbook } from '../src/lib/library/index.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { childLinks } from '../src/lib/recipes/plumbing.ts';
import { resolveFields, viewFields } from '../src/lib/recipes/policy.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const C = '@happyvertical/smrt-commerce:';
const E = '@happyvertical/smrt-events:';
const PROFILE = '@happyvertical/smrt-profiles:Profile';
const model = (id: string) => {
  const found = getModelByQualifiedName(id);
  if (!found) throw new Error(id);
  return found.model;
};
const source = () =>
  createMemoryDataSource({
    samples: stockSamples(catalogModels),
    empty: [
      '@happyvertical/smrt-products:ProductVariant',
      '@happyvertical/smrt-profiles:ProfileType',
    ],
    children: {
      models: catalog.packages.flatMap((p) => p.models),
      links: (id) => childLinks(catalog, recipes, id),
    },
  });

afterEach(() => setSamplePack(null));

describe('New button nouns', () => {
  it('use the menu noun when the page has one way to create', () => {
    expect(createNoun('Simple product', 'part', true)).toBe('part');
    expect(createNoun('Customer', 'member', true)).toBe('member');
  });
  it('keep each form’s label when several are offered', () => {
    expect(createNoun('Clothing item', 'product', false)).toBe('clothing item');
    expect(createNoun('Simple product', undefined, true)).toBe(
      'simple product',
    );
  });
});

describe('Member fields', () => {
  it.each([
    ['yoga-studio', ['creditLimit', 'taxExempt', 'customerType', 'taxId']],
    ['mechanic', ['creditLimit', 'customerType']],
  ])('%s hides the wholesale fields of a customer', (id, hidden) => {
    const names = viewFields(
      resolveFields(
        model(`${C}Customer`),
        undefined,
        getLibraryCookbook(id)?.document.policies,
      ),
    ).map((f) => f.name);
    for (const name of hidden) expect(names).not.toContain(name);
  });

  it.each(['yoga-studio', 'mechanic'])('%s customers are retail', (id) => {
    setSamplePack(id);
    const types = fakeRecords(model(`${C}Customer`), 8).map(
      (r) => r.customerType,
    );
    expect(new Set(types)).toEqual(new Set(['retail']));
  });
});

describe('Pack text belongs to its field', () => {
  it('describes classes, series and types, never with a member note', () => {
    setSamplePack('yoga-studio');
    const pack = COOKBOOK_PACKS['yoga-studio'];
    const notes = new Set([
      ...(pack?.notes ?? []),
      ...(pack?.customerNotes ?? []),
    ]);
    for (const name of ['Event', 'EventSeries', 'EventType']) {
      const rows = fakeRecords(model(`${E}${name}`), 8);
      for (const row of rows) {
        expect(notes.has(String(row.description)), name).toBe(false);
      }
    }
    const classes = fakeRecords(model(`${E}Event`), 8);
    expect(classes[1]?.name).toBe('Yin Yoga');
    expect(classes[1]?.description).toBe(
      'Slow, grounding practice with long holds.',
    );
  });

  it('keeps member notes on customers and out of documents', () => {
    setSamplePack('yoga-studio');
    const pack = COOKBOOK_PACKS['yoga-studio'];
    const customers = fakeRecords(model(`${C}Customer`), 8);
    for (const c of customers) {
      expect(pack?.customerNotes).toContain(c.notes);
    }
    for (const o of fakeRecords(model(`${C}Order`), 8)) {
      expect(pack?.customerNotes).not.toContain(o.notes);
    }
  });
});

describe('Organizers and participants', () => {
  it.each([
    'yoga-studio',
    'mechanic',
    'welder',
  ])('%s organizers are instructors, not customers', async (id) => {
    setSamplePack(id);
    const pack = COOKBOOK_PACKS[id];
    const ds = source();
    const series = await ds.list(model(`${E}EventSeries`));
    const labels = await relationLabels(
      ds,
      model(`${E}EventSeries`).fields,
      series,
    );
    for (const row of series) {
      const label = labels.get(`${PROFILE}:${row.organizerId}`);
      expect(pack?.instructors, id).toContain(label);
      expect(pack?.customers, id).not.toContain(label);
    }
  });

  it('sign-ups show a readable profile and an attendee or instructor role', async () => {
    setSamplePack('yoga-studio');
    const pack = COOKBOOK_PACKS['yoga-studio'];
    const ds = source();
    const participant = model(`${E}EventParticipant`);
    const rows = await ds.list(participant);
    expect(rows.length).toBeGreaterThan(0);
    const labels = await relationLabels(ds, participant.fields, rows);
    const people = new Set([
      ...(pack?.customers ?? []),
      ...(pack?.instructors ?? []),
    ]);
    for (const row of rows) {
      expect(['attendee', 'instructor']).toContain(row.role);
      expect(people.has(labels.get(`${PROFILE}:${row.profileId}`) ?? '')).toBe(
        true,
      );
    }
  });

  it('child sign-ups of a class resolve too', async () => {
    setSamplePack('yoga-studio');
    const ds = source();
    const event = model(`${E}Event`);
    const link = childLinks(catalog, recipes, event.id).find((l) =>
      l.model.id.endsWith(':EventParticipant'),
    );
    if (!link) return; // the link only exists while a recipe declares it
    const classes = await ds.list(event);
    const kids = await ds.list(link.model);
    const labels = await relationLabels(ds, link.model.fields, kids);
    expect(classes.length).toBeGreaterThan(0);
    for (const row of kids) {
      expect(labels.has(`${PROFILE}:${row.profileId}`)).toBe(true);
    }
  });
});

describe('Class list', () => {
  it('shows when a class starts, with the time, and no description', () => {
    const event = model(`${E}Event`);
    const columns = listColumns(viewFields(resolveFields(event, undefined)));
    const names = columns.map((c) => c.name);
    expect(names).toContain('startDate');
    expect(names).not.toContain('description');
    const start = columns.find((c) => c.name === 'startDate');
    expect(start?.showTime).toBe(true);
    expect(start && formatValue(start, '2026-03-04T18:00:00.000Z')).toBe(
      '2026-03-04 18:00',
    );
  });

  it('classes start on the hour', () => {
    setSamplePack('yoga-studio');
    for (const c of fakeRecords(model(`${E}Event`), 8)) {
      expect(String(c.startDate)).toMatch(/T\d\d:00:00\.000Z$/);
    }
  });
});

describe('Line quantities', () => {
  it.each(Object.keys(COOKBOOK_PACKS))('%s lines stay in range', async (id) => {
    setSamplePack(id);
    const pack = COOKBOOK_PACKS[id];
    const lines = await source().list(model(`${C}InvoiceLineItem`));
    expect(lines.length).toBeGreaterThan(0);
    for (const row of lines) {
      const line = pack?.lines?.find((l) => l.description === row.description);
      const [low, high] = line?.quantity ?? pack?.lineQuantity ?? [1, 5];
      expect(row.quantity, `${id} ${row.description}`).toBeGreaterThanOrEqual(
        low,
      );
      expect(row.quantity).toBeLessThanOrEqual(high);
    }
  });

  it('sells one membership at a time', async () => {
    setSamplePack('yoga-studio');
    const ds = source();
    const lines = await ds.list(model(`${C}InvoiceLineItem`));
    for (const row of lines) {
      if (row.description === 'Monthly unlimited membership') {
        expect(row.quantity).toBe(1);
      }
    }
  });
});

describe('Data resets', () => {
  it('tell a page that already read rows', async () => {
    const ds = source();
    let calls = 0;
    const stop = ds.onReset?.(() => calls++);
    ds.reset?.();
    expect(calls).toBe(1);
    stop?.();
    ds.reset?.();
    expect(calls).toBe(1);
  });

  it('a cookbook applied before the saved cookbook is read is not undone by it', () => {
    const storage = new Map<string, string>();
    const fake = {
      get length() {
        return storage.size;
      },
      key: (i: number) => [...storage.keys()][i] ?? null,
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
    } as Storage;
    const store = new CookbookStore();
    const cookbook = getLibraryCookbook('mechanic');
    if (!cookbook) throw new Error('mechanic');
    recipeState.clear();
    store.replace(cookbook.document);
    store.hydrate('', fake);
    expect(recipeState.has('commerce.customers')).toBe(true);
    recipeState.clear();
  });
});

describe('Identifier fields', () => {
  it('fills a tax id with a number, never a company name', () => {
    const customer = model(`${C}Customer`);
    for (const row of fakeRecords(customer, 8, 7)) {
      const taxId = (row as Record<string, unknown>).taxId;
      if (taxId !== undefined && taxId !== null) {
        expect(String(taxId)).toMatch(/^\d{2}-\d{7}$/);
      }
    }
  });
});
