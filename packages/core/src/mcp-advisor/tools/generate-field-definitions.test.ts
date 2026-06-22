/**
 * Tests for the mcp-advisor generate-field-definitions tool.
 *
 * Pure generator: returns a `ToolResponse` whose `data` is field-definition
 * source (decorators + typed properties with defaults). Covers the decorator /
 * no-decorator branches, the full type→TS map, and the empty-input error.
 */

import { describe, expect, it } from 'vitest';
import { generateFieldDefinitions } from './generate-field-definitions.js';

describe('mcp-advisor: generateFieldDefinitions', () => {
  it('generates plain field definitions without a @field decorator when no _meta', async () => {
    const result = await generateFieldDefinitions({
      fields: [{ name: 'title', type: 'text' }],
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
    const code = result.data as string;
    expect(code).toContain("import { field } from '@happyvertical/smrt-core';");
    expect(code).toContain("title: string = '';");
    expect(code).not.toContain('@field(');
  });

  it('emits a @field decorator with serialized _meta options', async () => {
    const result = await generateFieldDefinitions({
      fields: [
        {
          name: 'name',
          type: 'text',
          _meta: { required: true, maxLength: 50 },
        },
      ],
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain('@field({"required":true,"maxLength":50})');
    expect(code).toContain("name: string = '';");
  });

  it('treats an empty _meta object as no decorator', async () => {
    const result = await generateFieldDefinitions({
      fields: [{ name: 'x', type: 'integer', _meta: {} }],
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).not.toContain('@field(');
    expect(code).toContain('x: number = 0;');
  });

  it('maps each field type to the correct TS type and default value', async () => {
    const result = await generateFieldDefinitions({
      fields: [
        { name: 'a', type: 'text' },
        { name: 'b', type: 'integer' },
        { name: 'c', type: 'decimal' },
        { name: 'd', type: 'boolean' },
        { name: 'e', type: 'datetime' },
        { name: 'f', type: 'json' },
        { name: 'g', type: 'foreignKey' },
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
    // foreignKey is not in the local type map → falls through to `any`/`undefined`
    expect(code).toContain('g: any = undefined;');
  });

  it('returns an error for an empty field list', async () => {
    const result = await generateFieldDefinitions({ fields: [] });

    expect(result.success).toBe(false);
    expect(result.error).toBe('At least one field is required');
  });
});
