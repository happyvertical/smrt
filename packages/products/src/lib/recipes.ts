/**
 * Declared recipes for smrt-products (#3590, #3604): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Product } from './models/Product.js';
import { ProductVariant } from './models/ProductVariant.js';
import { Sku } from './models/Sku.js';

/** Simple products: Items with a name, a price and a description. */
export class SimpleProductsRecipe extends SmrtRecipe {
  static id = 'products.simple';
  static help = './simple.recipe.md';
  static label = 'Simple products';
  static summary = 'Items with a name, a price and a description.';
  static synonyms = ['items', 'goods', 'catalog'];
  static group = {
    id: 'products',
    label: 'Products',
    summary:
      'Sell goods: simple items, or clothing that comes in sizes and colors.',
  };
  static section = {
    id: 'catalog',
    label: 'Catalog',
    icon: 'package',
    description: 'Products, ingredients and the stock you hold.',
  };
  static models = [Product];
  static nav = [
    {
      label: 'Products',
      model: Product,
      icon: 'package',
      description: 'What you sell, with prices and details.',
    },
  ];
  static options = {
    Product: {
      fields: {
        productType: { visibility: 'hidden' },
        category: { visibility: 'hidden' },
        manufacturer: { visibility: 'hidden' },
        model: { visibility: 'hidden' },
        inStock: { visibility: 'hidden' },
        specifications: { visibility: 'hidden' },
        tags: { visibility: 'hidden' },
      },
    },
  } as const;
}

/** Clothing: Products that come in sizes and colors, with a stock-keeping unit for each combination. */
export class ClothingProductsRecipe extends SmrtRecipe {
  static id = 'products.clothing';
  static help = './clothing.recipe.md';
  static label = 'Clothing';
  static summary =
    'Products that come in sizes and colors, with a stock-keeping unit for each combination.';
  static synonyms = ['apparel', 'garments', 'sizes', 'variants'];
  static group = {
    id: 'products',
    label: 'Products',
    summary:
      'Sell goods: simple items, or clothing that comes in sizes and colors.',
  };
  static section = {
    id: 'catalog',
    label: 'Catalog',
    icon: 'package',
    description: 'Products, ingredients and the stock you hold.',
  };
  static models = [Product, ProductVariant, Sku];
  static nav = [
    {
      label: 'Products',
      model: Product,
      icon: 'package',
      description: 'What you sell, with prices and details.',
    },
  ];
  static options = {
    Product: {
      fields: {
        productType: { visibility: 'hidden' },
        category: { visibility: 'hidden' },
        manufacturer: { visibility: 'hidden' },
        model: { visibility: 'hidden' },
        inStock: { visibility: 'hidden' },
        specifications: { visibility: 'hidden' },
        tags: { visibility: 'hidden' },
        description: { visibility: 'hidden' },
      },
    },
    ProductVariant: {
      fields: {
        label: { visibility: 'hidden' },
        sortOrder: { visibility: 'hidden' },
      },
    },
    Sku: {
      fields: {
        barcode: { visibility: 'hidden' },
        name: { visibility: 'hidden' },
        weightGrams: { visibility: 'hidden' },
        parentSkuId: { visibility: 'hidden' },
        active: { visibility: 'hidden' },
      },
    },
  } as const;
}

/** Ingredients: Things you buy in to make what you sell, kept as products of the material kind with their own list. */
export class IngredientsRecipe extends SmrtRecipe {
  static id = 'products.ingredients';
  static help = './ingredients.recipe.md';
  static label = 'Ingredients';
  static summary =
    'Things you buy in to make what you sell, kept as products of the material kind with their own list.';
  static synonyms = ['materials', 'raw materials', 'supplies', 'stock items'];
  static group = {
    id: 'products',
    label: 'Products',
    summary:
      'Sell goods: simple items, or clothing that comes in sizes and colors.',
  };
  static section = {
    id: 'catalog',
    label: 'Catalog',
    icon: 'package',
    description: 'Products, ingredients and the stock you hold.',
  };
  static models = [Product];
  static nav = [
    {
      label: 'Ingredients',
      model: Product,
      icon: 'package',
      description: 'What you buy to make what you sell, with what each costs.',
      key: 'ingredients',
      noun: 'ingredient',
      filter: { field: 'productType', value: 'material' },
    },
  ];
  static requires = ['products.simple'];
  static options = {
    Product: {
      fields: {
        productType: { visibility: 'hidden' },
        category: { visibility: 'hidden' },
        manufacturer: { visibility: 'hidden' },
        model: { visibility: 'hidden' },
        inStock: { visibility: 'hidden' },
        specifications: { visibility: 'hidden' },
        tags: { visibility: 'hidden' },
      },
    },
  } as const;
}
