/**
 * Tests for the mcp-advisor generate-smrt-class tool.
 *
 * These are pure code-generation handlers: given a class spec they return a
 * `ToolResponse` whose `data` is generated TypeScript source. We assert the
 * generated source contains the right decorator/interface/constructor shapes
 * and that input validation produces structured error responses.
 */

import { describe, expect, it } from 'vitest';
import { generateSmrtClass } from './generate-smrt-class.js';

describe('mcp-advisor: generateSmrtClass', () => {
  it('generates a complete SmrtObject class with interface, decorator and constructor', async () => {
    const result = await generateSmrtClass({
      className: 'Product',
      properties: [
        { name: 'name', type: 'text', required: true },
        { name: 'price', type: 'decimal' },
        { name: 'stock', type: 'integer' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
    const code = result.data as string;

    // Imports + base class
    expect(code).toContain(
      "import { SmrtObject, type SmrtObjectOptions, smrt, field } from '@happyvertical/smrt-core';",
    );
    // Options interface
    expect(code).toContain(
      'export interface ProductOptions extends SmrtObjectOptions {',
    );
    expect(code).toContain('name?: string;');
    expect(code).toContain('price?: number;');
    // Default decorator config (api/mcp/cli all on by default)
    expect(code).toContain('@smrt({');
    expect(code).toContain('api: {');
    expect(code).toContain('mcp: {');
    expect(code).toContain('cli: true');
    expect(code).toContain('export class Product extends SmrtObject {');
    // Required field gets a @field decorator; integer default 0, decimal 0.0
    expect(code).toContain('@field({ required: true })');
    expect(code).toContain("name: string = '';");
    expect(code).toContain('price: number = 0.0;');
    expect(code).toContain('stock: number = 0;');
    // Constructor + super + assignments (required uses truthy, optional uses !== undefined)
    expect(code).toContain('constructor(options: ProductOptions = {}) {');
    expect(code).toContain('super(options);');
    expect(code).toContain('if (options.name) this.name = options.name;');
    expect(code).toContain(
      'if (options.price !== undefined) this.price = options.price;',
    );
  });

  it('honours the SmrtCollection base class', async () => {
    const result = await generateSmrtClass({
      className: 'WidgetCollection',
      baseClass: 'SmrtCollection',
      properties: [{ name: 'label', type: 'text' }],
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain(
      'export class WidgetCollection extends SmrtCollection {',
    );
    expect(code).toContain(
      "import { SmrtCollection, type SmrtObjectOptions, smrt, field } from '@happyvertical/smrt-core';",
    );
  });

  it('emits a bare @smrt() decorator when all config flags are disabled', async () => {
    const result = await generateSmrtClass({
      className: 'Plain',
      properties: [{ name: 'value', type: 'text' }],
      includeApiConfig: false,
      includeMcpConfig: false,
      includeCliConfig: false,
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain('@smrt()');
    expect(code).not.toContain('@smrt({');
  });

  it('maps every supported field type to its TS type and default', async () => {
    const result = await generateSmrtClass({
      className: 'AllTypes',
      properties: [
        { name: 'a', type: 'text' },
        { name: 'b', type: 'integer' },
        { name: 'c', type: 'decimal' },
        { name: 'd', type: 'boolean' },
        { name: 'e', type: 'datetime' },
        { name: 'f', type: 'json' },
      ],
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain("a: string = '';");
    expect(code).toContain('b: number = 0;');
    expect(code).toContain('c: number = 0.0;');
    expect(code).toContain('d: boolean = false;');
    expect(code).toContain('e: Date = new Date();');
    expect(code).toContain('f: Record<string, any> = {};');
  });

  it('rejects a non-PascalCase className with a structured error', async () => {
    const result = await generateSmrtClass({
      className: 'product',
      properties: [{ name: 'name', type: 'text' }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/PascalCase/);
    expect(result.data).toBeUndefined();
  });

  it('rejects an empty className', async () => {
    const result = await generateSmrtClass({
      className: '',
      properties: [{ name: 'name', type: 'text' }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/PascalCase/);
  });

  it('rejects an empty property list', async () => {
    const result = await generateSmrtClass({
      className: 'Empty',
      properties: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('At least one property is required');
  });
});
