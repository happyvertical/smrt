/**
 * Tests for the mcp-advisor generate-collection tool.
 *
 * Pure generator: returns a `ToolResponse` whose `data` is a SmrtCollection
 * subclass. Covers imports, the required `_itemClass`, optional custom methods,
 * and PascalCase validation errors for both class names.
 */

import { describe, expect, it } from 'vitest';
import { generateCollection } from './generate-collection.js';

describe('mcp-advisor: generateCollection', () => {
  it('generates a minimal collection with imports and _itemClass', async () => {
    const result = await generateCollection({
      collectionName: 'ProductCollection',
      itemClassName: 'Product',
      itemClassPath: './product.js',
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
    const code = result.data as string;
    expect(code).toContain(
      "import { SmrtCollection } from '@happyvertical/smrt-core';",
    );
    expect(code).toContain("import { Product } from './product.js';");
    expect(code).toContain(
      'export class ProductCollection extends SmrtCollection<Product> {',
    );
    expect(code).toContain('static readonly _itemClass = Product;');
    // No custom methods by default
    expect(code).not.toContain('findByCriteria');
    expect(code).not.toContain('getOrCreate');
  });

  it('includes placeholder custom methods when requested', async () => {
    const result = await generateCollection({
      collectionName: 'OrderCollection',
      itemClassName: 'Order',
      itemClassPath: './order.js',
      includeCustomMethods: true,
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain(
      'async findByCriteria(criteria: any): Promise<Order[]> {',
    );
    expect(code).toContain(
      'async getOrCreate(data: any, defaults: any = {}): Promise<Order> {',
    );
    expect(code).toContain('return this.getOrUpsert(data, defaults);');
  });

  it('rejects a non-PascalCase collectionName', async () => {
    const result = await generateCollection({
      collectionName: 'productCollection',
      itemClassName: 'Product',
      itemClassPath: './product.js',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/collectionName must be in PascalCase/);
  });

  it('rejects a non-PascalCase itemClassName', async () => {
    const result = await generateCollection({
      collectionName: 'ProductCollection',
      itemClassName: 'product',
      itemClassPath: './product.js',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/itemClassName must be in PascalCase/);
  });
});
