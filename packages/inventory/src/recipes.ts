/**
 * Declared recipes for smrt-inventory (#3590, #3604): user-facing units of
 * functionality an app, agent or planner can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { InventoryLocation } from './models/InventoryLocation.js';
import { StockLevel } from './models/StockLevel.js';
import { StockMovement } from './models/StockMovement.js';

/** Inventory: Keep count of how many of each product you have. */
export class StockRecipe extends SmrtRecipe {
  static id = 'inventory.stock';
  static help = './stock.recipe.md';
  static label = 'Inventory';
  static summary = 'Keep count of how many of each product you have.';
  static synonyms = ['stock', 'quantity', 'on hand'];
  static section = {
    id: 'catalog',
    label: 'Catalog',
    icon: 'package',
    description: 'Products, ingredients and the stock you hold.',
  };
  static models = [StockLevel, InventoryLocation, StockMovement];
  static nav = [
    {
      label: 'Stock levels',
      model: StockLevel,
      icon: 'archive',
      description: 'How much of each item you have on hand right now.',
      noun: 'stock entry',
    },
    {
      label: 'Locations',
      model: InventoryLocation,
      icon: 'home',
      description: 'The places you keep stock, like shelves, rooms or vans.',
    },
    {
      label: 'Stock movements',
      model: StockMovement,
      icon: 'truck',
      description: 'Every time stock came in, went out or moved.',
    },
  ];
  static requiresAny = [['products.simple', 'products.clothing']];
  static options = {
    StockLevel: {
      fields: {
        reorderPoint: { visibility: 'hidden' },
        reorderQuantity: { visibility: 'hidden' },
      },
    },
    InventoryLocation: {
      fields: {
        placeId: { visibility: 'hidden' },
        active: { visibility: 'hidden' },
      },
    },
    StockMovement: {
      fields: {
        sourceType: { visibility: 'hidden' },
        sourceId: { visibility: 'hidden' },
        actorProfileId: { visibility: 'hidden' },
      },
    },
  } as const;
}
