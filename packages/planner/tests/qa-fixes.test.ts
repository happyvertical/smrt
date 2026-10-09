import { describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { navNoun } from '../src/lib/data/format.ts';
import { getLibraryCookbook } from '../src/lib/library/index.ts';
import { recipeNav, recipes } from '../src/lib/recipes/index.ts';
import {
  isDiscriminatorField,
  resolveFields,
  viewFields,
} from '../src/lib/recipes/policy.ts';

const C = '@happyvertical/smrt-commerce:';
const model = (id: string) => {
  const found = getModelByQualifiedName(id);
  if (!found) throw new Error(id);
  return found.model;
};

describe('STI discriminators', () => {
  it('are never offered in a form, and default to the model', () => {
    const po = model(`${C}ProductionOrder`);
    const field = po.fields.find((f) => f.name === 'contractType');
    if (!field) throw new Error('contractType missing');
    expect(isDiscriminatorField(po, field)).toBe(true);
    const resolved = resolveFields(po, undefined);
    expect(viewFields(resolved).map((f) => f.name)).not.toContain(
      'contractType',
    );
    const entry = resolved.find((r) => r.field.name === 'contractType');
    expect(entry).toMatchObject({
      visibility: 'hidden',
      locked: true,
      default: 'production_order',
    });
  });

  it('leaves ordinary enumerations alone', () => {
    const level = model('@happyvertical/smrt-inventory:StockLevel');
    const state = level.fields.find((f) => f.name === 'state');
    if (!state) throw new Error('state missing');
    expect(isDiscriminatorField(level, state)).toBe(false);
  });
});

describe('Bakery batches', () => {
  it('hide customer, vendor, expiry and channel', () => {
    const bakery = getLibraryCookbook('bakery');
    const po = model(`${C}ProductionOrder`);
    const names = viewFields(
      resolveFields(po, undefined, bakery?.document.policies),
    ).map((f) => f.name);
    for (const hidden of [
      'contractType',
      'customerId',
      'vendorId',
      'expiryDate',
      'channelId',
    ]) {
      expect(names).not.toContain(hidden);
    }
  });
});

describe('menu labels and nouns', () => {
  it('writes recipe nav labels in sentence case', () => {
    for (const recipe of recipes) {
      for (const entry of recipe.nav) {
        expect(entry.label, entry.label).not.toMatch(/ [A-Z]/);
      }
    }
  });

  it('uses a declared noun, else the singular label', () => {
    expect(navNoun('Material on hand', 'stock entry')).toBe('stock entry');
    expect(navNoun('Sales orders')).toBe('sales order');
    const stock = recipes
      .flatMap((r) => recipeNav(r))
      .find((e) => e.model.name === 'StockLevel');
    expect(stock?.noun).toBe('stock entry');
  });
});
