import { describe, expect, it } from 'vitest';
import {
  buildToolDescriptors,
  buildToolInputSchema,
  fieldTypeToJsonSchema,
  isCrudAction,
  type ToolFieldMeta,
} from './tool-schema.js';

// A small fixture model standing in for a `@smrt()` class's public fields.
const PRODUCT_FIELDS: ToolFieldMeta[] = [
  { name: 'name', type: 'text', required: true, maxLength: 120 },
  { name: 'price', type: 'decimal', min: 0 },
  { name: 'stock', type: 'integer', min: 0, default: 0 },
  { name: 'active', type: 'boolean', default: true },
  { name: 'launchAt', type: 'datetime' },
  { name: 'specs', type: 'json' },
  { name: 'categoryId', type: 'foreignKey', related: 'Category' },
];

describe('fieldTypeToJsonSchema', () => {
  it('maps each SMRT field kind to the right JSON-Schema primitive', () => {
    expect(fieldTypeToJsonSchema({ name: 'n', type: 'text' }).type).toBe(
      'string',
    );
    expect(fieldTypeToJsonSchema({ name: 'n', type: 'integer' }).type).toBe(
      'integer',
    );
    expect(fieldTypeToJsonSchema({ name: 'n', type: 'decimal' }).type).toBe(
      'number',
    );
    expect(fieldTypeToJsonSchema({ name: 'n', type: 'boolean' }).type).toBe(
      'boolean',
    );
    expect(fieldTypeToJsonSchema({ name: 'n', type: 'json' }).type).toBe(
      'object',
    );
  });

  it('emits date-time format for datetime fields', () => {
    const schema = fieldTypeToJsonSchema({
      name: 'launchAt',
      type: 'datetime',
    });
    expect(schema).toMatchObject({ type: 'string', format: 'date-time' });
  });

  it('describes a foreign key as the id of the related class', () => {
    const schema = fieldTypeToJsonSchema({
      name: 'categoryId',
      type: 'foreignKey',
      related: 'Category',
    });
    expect(schema).toMatchObject({
      type: 'string',
      description: 'ID of related Category',
    });
  });

  it('carries min/max and default through onto the schema', () => {
    const schema = fieldTypeToJsonSchema({
      name: 'stock',
      type: 'integer',
      min: 0,
      max: 9999,
      default: 0,
    });
    expect(schema).toMatchObject({ minimum: 0, maximum: 9999, default: 0 });
  });
});

describe('buildToolInputSchema', () => {
  it('builds a paginated, filterable list schema', () => {
    const schema = buildToolInputSchema('list', PRODUCT_FIELDS);
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['limit', 'offset', 'orderBy', 'where']),
    );
  });

  it('accepts id OR slug for get (neither required at the schema level)', () => {
    const schema = buildToolInputSchema('get', PRODUCT_FIELDS);
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('slug');
    // Relaxed from the historical required:['id'] so a slug-only call is valid.
    expect(schema.required).toBeUndefined();
  });

  it('promotes required model fields onto the create schema', () => {
    const schema = buildToolInputSchema('create', PRODUCT_FIELDS);
    expect(schema.required).toEqual(['name']);
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('price');
    expect(props).not.toHaveProperty('id'); // server-assigned, never on create
  });

  it('requires id and includes every field on update', () => {
    const schema = buildToolInputSchema('update', PRODUCT_FIELDS);
    expect(schema.required).toEqual(['id']);
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('name');
  });

  it('gives a custom action the id + options shape', () => {
    const schema = buildToolInputSchema('publish', PRODUCT_FIELDS);
    expect(schema.required).toEqual(['id']);
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('options');
  });
});

describe('buildToolDescriptors', () => {
  const descriptors = buildToolDescriptors({
    className: 'Product',
    fields: PRODUCT_FIELDS,
    actions: ['list', 'get', 'create', 'update', 'delete', 'publish'],
  });

  it('names tools <class>_<action>, matching the Node MCP surface', () => {
    expect(descriptors.map((d) => d.name)).toEqual([
      'product_list',
      'product_get',
      'product_create',
      'product_update',
      'product_delete',
      'product_publish',
    ]);
  });

  it('marks only list and get as read-only (WebMCP readOnlyHint)', () => {
    const readOnly = descriptors.filter((d) => d.readOnly).map((d) => d.action);
    expect(readOnly).toEqual(['list', 'get']);
  });

  it('produces a complete, WebMCP-ready descriptor per action', () => {
    for (const d of descriptors) {
      expect(d.name).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('honors an explicit toolPrefix for custom vocabularies', () => {
    const [tool] = buildToolDescriptors({
      className: 'Product',
      fields: [],
      actions: ['list'],
      toolPrefix: 'catalog_item',
    });
    expect(tool.name).toBe('catalog_item_list');
  });
});

describe('isCrudAction', () => {
  it('separates CRUD verbs from custom methods', () => {
    expect(isCrudAction('list')).toBe(true);
    expect(isCrudAction('delete')).toBe(true);
    expect(isCrudAction('publish')).toBe(false);
  });
});
