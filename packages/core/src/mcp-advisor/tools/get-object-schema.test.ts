/**
 * Tests for the mcp-advisor get-object-schema tool.
 *
 * Registry-backed: relies on imported @smrt() fixtures whose fields (and field
 * constraints) are hydrated from the test manifest. Asserts the returned
 * FieldDefinition array, constraint extraction, and each format branch.
 */

import { describe, expect, it } from 'vitest';
import {
  AdvisorBooleanWidget,
  AdvisorRichProduct,
} from '../../__tests__/fixtures/advisor-test-classes.js';
import { getObjectSchema } from './get-object-schema.js';

void AdvisorBooleanWidget;
void AdvisorRichProduct;

describe('mcp-advisor: getObjectSchema', () => {
  it('returns field definitions with types, required flags and constraints', async () => {
    const result = await getObjectSchema({ className: 'AdvisorRichProduct' });

    expect(result.className).toBe('AdvisorRichProduct');
    expect(result.format).toBe('json');
    expect(result.fields).toHaveLength(3);

    const title = result.fields.find((f) => f.name === 'title');
    expect(title).toMatchObject({
      name: 'title',
      type: 'text',
      required: true,
      description: 'Product display name',
    });
    // maxLength is a recognised constraint
    expect(title?.constraints).toMatchObject({ maxLength: 120 });

    const quantity = result.fields.find((f) => f.name === 'quantity');
    expect(quantity?.type).toBe('integer');
    expect(quantity?.required).toBe(false);
    expect(quantity?.constraints).toMatchObject({ min: 0, max: 1000 });
  });

  it('reports fields with no constraints as an empty constraints object', async () => {
    const result = await getObjectSchema({ className: 'AdvisorBooleanWidget' });
    const label = result.fields.find((f) => f.name === 'label');
    expect(label?.required).toBe(true);
    expect(label?.constraints).toEqual({});
  });

  it('accepts the typescript format', async () => {
    const result = await getObjectSchema({
      className: 'AdvisorRichProduct',
      format: 'typescript',
    });
    expect(result.format).toBe('typescript');
    expect(result.fields).toHaveLength(3);
  });

  it('accepts the table format', async () => {
    const result = await getObjectSchema({
      className: 'AdvisorRichProduct',
      format: 'table',
    });
    expect(result.format).toBe('table');
    expect(result.fields.length).toBeGreaterThan(0);
  });

  it('returns an empty field list for an unregistered class', async () => {
    // getFields() returns an empty Map (not undefined) for unknown classes, so
    // the handler resolves with zero fields rather than throwing.
    const result = await getObjectSchema({ className: 'TotallyUnknownClass' });
    expect(result.className).toBe('TotallyUnknownClass');
    expect(result.fields).toEqual([]);
  });
});
