import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFieldRefs } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { Order, PurchaseOrder } from '../models/Contract.js';
import { Customer } from '../models/Customer.js';
import { Vendor } from '../models/Vendor.js';
import {
  CustomersRecipe,
  PurchasesRecipe,
  SalesRecipe,
  VendorsRecipe,
} from '../recipes.js';
import { ContractType } from '../types/index.js';

describe('commerce recipes (#3590)', () => {
  const recipes = [
    CustomersRecipe,
    VendorsRecipe,
    SalesRecipe,
    PurchasesRecipe,
  ];

  it('declares the four minimal recipes with unique ids', () => {
    expect(recipes.map((recipe) => recipe.id)).toEqual([
      'commerce.customers',
      'commerce.vendors',
      'commerce.sales',
      'commerce.purchases',
    ]);
  });

  it('maps each recipe to its model, nav entry, and prerequisite', () => {
    expect(CustomersRecipe.models).toEqual([Customer]);
    expect(VendorsRecipe.models).toEqual([Vendor]);
    expect(SalesRecipe.models).toEqual([Order]);
    expect(PurchasesRecipe.models).toEqual([PurchaseOrder]);
    expect(SalesRecipe.nav).toEqual([{ label: 'Sales Orders', model: Order }]);
    expect(PurchasesRecipe.nav).toEqual([
      { label: 'Purchase Orders', model: PurchaseOrder },
    ]);
    expect(CustomersRecipe.requires).toEqual([]);
    expect(VendorsRecipe.requires).toEqual([]);
    expect(SalesRecipe.requires).toEqual(['commerce.customers']);
    expect(PurchasesRecipe.requires).toEqual(['commerce.vendors']);
  });

  it('hides and locks the discriminator and the other party', () => {
    expect(SalesRecipe.options.Order.fields.contractType).toEqual({
      default: ContractType.ORDER,
      visibility: 'hidden',
      locked: true,
    });
    expect(PurchasesRecipe.options.PurchaseOrder.fields.contractType).toEqual({
      default: ContractType.PURCHASE_ORDER,
      visibility: 'hidden',
      locked: true,
    });
  });

  it('only requires recipes that exist', () => {
    const ids = new Set(recipes.map((recipe) => recipe.id));
    for (const recipe of recipes) {
      for (const required of recipe.requires)
        expect(ids.has(required)).toBe(true);
    }
  });

  describe('user-facing help (#3591)', () => {
    const models = [
      [CustomersRecipe, { Customer: new Customer() }],
      [VendorsRecipe, { Vendor: new Vendor() }],
      [SalesRecipe, { Order: new Order() }],
      [PurchasesRecipe, { PurchaseOrder: new PurchaseOrder() }],
    ] as const;

    it.each(models)('%s points at a help file beside recipes.ts', (recipe) => {
      expect(recipe.help).toMatch(/^\.\/[a-z]+\.recipe\.md$/);
      const markdown = readFileSync(
        fileURLToPath(new URL(`../${recipe.help}`, import.meta.url)),
        'utf-8',
      );
      expect(markdown).toContain('## Overview');
      expect(markdown).toContain('## Tasks');
    });

    it.each(
      models,
    )('%s names only fields its model declares', (recipe, byName) => {
      const markdown = readFileSync(
        fileURLToPath(new URL(`../${recipe.help}`, import.meta.url)),
        'utf-8',
      );
      const [instance] = Object.values(byName);
      for (const ref of extractFieldRefs(markdown)) {
        expect(ref in (instance as object), ref).toBe(true);
      }
    });
  });
});
