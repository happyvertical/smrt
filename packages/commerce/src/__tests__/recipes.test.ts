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
});
