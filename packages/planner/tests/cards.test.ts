import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildCards,
  cardLocks,
  mainLockNote,
  subLockNote,
  subSwitchChange,
} from '../src/lib/recipes/cards.ts';
import {
  getSection,
  recipes,
  recipesById,
  sectionId,
  sections,
} from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const products = buildCards(recipes).find((c) => c.id === 'products');
if (!products) throw new Error('no Products card');
const locks = () => cardLocks(products, recipeState.ids, recipesById);

function flip(id: string, on: boolean) {
  const change = subSwitchChange(id, on);
  recipeState.add(...change.add);
  recipeState.remove(...change.remove);
}

describe('Planner card locks', () => {
  beforeEach(() => recipeState.clear());

  it('with Inventory on, only the last remaining product type locks', () => {
    recipeState.add('inventory.stock');
    // Inventory pulled in Simple, the first alternative; it is the last one.
    expect(recipeState.ids).toEqual(['inventory.stock', 'products.simple']);
    expect(locks().main).toEqual(['inventory.stock']);
    expect(locks().subs).toEqual({ 'products.simple': ['inventory.stock'] });

    // Clothing can still be turned on, and then nothing sub-level is locked.
    flip('products.clothing', true);
    expect(recipeState.has('products.clothing')).toBe(true);
    expect(locks().main).toEqual(['inventory.stock']);
    expect(locks().subs).toEqual({});

    // Turn Simple off: Clothing is now the last one and locks instead.
    flip('products.simple', false);
    expect(recipeState.ids).toEqual(['inventory.stock', 'products.clothing']);
    expect(locks().subs).toEqual({ 'products.clothing': ['inventory.stock'] });
  });

  it('locks nothing when nothing needs the card', () => {
    recipeState.add('products.simple', 'products.clothing');
    expect(locks()).toEqual({ main: [], subs: {} });
  });

  it('words the notes around what is needed', () => {
    expect(mainLockNote(products, ['Inventory'])).toBe(
      'Products stays on while Inventory needs at least one Products recipe.',
    );
    expect(subLockNote(products, 'Simple', ['Inventory'])).toBe(
      'Simple is the last Products recipe on, and Inventory needs one.',
    );
    const customers = buildCards(recipes).find(
      (c) => c.id === 'commerce.customers',
    );
    if (!customers) throw new Error('no Customers card');
    expect(mainLockNote(customers, ['Sales orders'])).toBe(
      'Customers stays on while Sales orders needs it.',
    );
  });
});

describe('recipe sections', () => {
  it('group recipes under one section, keyed by group id or recipe id', () => {
    // Feature recipes the overlay does not pin follow these.
    const pinned = [
      'commerce.customers',
      'commerce.purchases',
      'commerce.sales',
      'commerce.vendors',
      'inventory.stock',
      'products',
      'commerce.estimates',
      'commerce.wholesale',
      'billing',
      'agreements',
      'ledgers.bookkeeping',
      'projects.tracker',
      'events.calendar',
      'sales.pipeline',
    ];
    expect(sections.map((s) => s.id).slice(0, pinned.length)).toEqual(pinned);
    expect(getSection('products')?.recipes.map((r) => r.id)).toEqual([
      'products.simple',
      'products.clothing',
      'products.ingredients',
    ]);
    expect(getSection('products.simple')).toBeUndefined();
    expect(sectionId(recipesById.get('products.clothing') ?? recipes[0])).toBe(
      'products',
    );
  });
});
