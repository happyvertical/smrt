import { describe, expect, it } from 'vitest';
import {
  assertMcpJsonSchemaSafety,
  buildToolDescriptors,
  buildToolInputSchema,
  fieldTypeToJsonSchema,
  isCrudAction,
  JSON_SCHEMA_2020_12,
  MCP_SCHEMA_LIMITS,
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

  it('keeps an authored description on a foreign key instead of the generic hint (#2046)', () => {
    const schema = fieldTypeToJsonSchema({
      name: 'categoryId',
      type: 'foreignKey',
      related: 'Category',
      description: 'The catalogue category this product ships under',
    });
    expect(schema).toMatchObject({
      type: 'string',
      description: 'The catalogue category this product ships under',
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

  it('uses a nullable type union when metadata permits null', () => {
    expect(
      fieldTypeToJsonSchema({
        name: 'publishedAt',
        type: 'datetime',
        nullable: true,
      }),
    ).toMatchObject({ type: ['string', 'null'], format: 'date-time' });
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

  it('requires id OR slug for get', () => {
    const schema = buildToolInputSchema('get', PRODUCT_FIELDS);
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('slug');
    // A branch-level requirement preserves slug-only lookup support while
    // rejecting an empty argument object before it reaches the handler.
    expect(schema.required).toBeUndefined();
    expect(schema.anyOf).toEqual([
      { required: ['id'] },
      { required: ['slug'] },
    ]);
  });

  it('omits UUID format for text-id CRUD objects', () => {
    for (const action of ['get', 'update', 'delete']) {
      const schema = buildToolInputSchema(
        action,
        PRODUCT_FIELDS,
        undefined,
        'text',
      );
      const properties = schema.properties as Record<string, unknown>;
      expect(properties.id).toEqual(
        expect.objectContaining({ type: 'string' }),
      );
      expect(properties.id).not.toEqual(
        expect.objectContaining({ format: 'uuid' }),
      );
    }
  });

  it('promotes required model fields onto the create schema', () => {
    const schema = buildToolInputSchema('create', PRODUCT_FIELDS);
    expect(schema.required).toEqual(['name']);
    expect(schema.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(schema.$defs).toBeDefined();
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('price');
    expect(props.name).toEqual({ $ref: '#/$defs/field_0' });
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

describe('MCP JSON Schema safety bounds', () => {
  it('rejects external refs without attempting to dereference them', () => {
    expect(() =>
      assertMcpJsonSchemaSafety({ $ref: 'https://example.test/schema.json' }),
    ).toThrow('local #/$defs/ references');
  });

  it('rejects schemas whose composition exceeds the depth bound', () => {
    const schema: Record<string, unknown> = {};
    let cursor = schema;
    for (let index = 0; index <= MCP_SCHEMA_LIMITS.maxDepth; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.allOf = [next];
      cursor = next;
    }

    expect(() => assertMcpJsonSchemaSafety(schema)).toThrow('levels of depth');
  });

  it('rejects schemas whose serialized size exceeds the transport budget', () => {
    expect(() =>
      assertMcpJsonSchemaSafety({
        description: 'x'.repeat(MCP_SCHEMA_LIMITS.maxSerializedBytes),
      }),
    ).toThrow('serialized bytes');
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

  it('emits intrinsic CRUD effects and conservative custom defaults', () => {
    expect(
      descriptors.map(({ action, effect, idempotent, openWorld }) => ({
        action,
        effect,
        idempotent,
        openWorld,
      })),
    ).toEqual([
      { action: 'list', effect: 'read', idempotent: true, openWorld: false },
      { action: 'get', effect: 'read', idempotent: true, openWorld: false },
      {
        action: 'create',
        effect: 'write',
        idempotent: false,
        openWorld: false,
      },
      {
        action: 'update',
        effect: 'write',
        idempotent: true,
        openWorld: false,
      },
      {
        action: 'delete',
        effect: 'destructive',
        idempotent: true,
        openWorld: false,
      },
      {
        action: 'publish',
        effect: 'destructive',
        idempotent: false,
        openWorld: true,
      },
    ]);
  });

  it('honors explicit custom-action semantics', () => {
    const [descriptor] = buildToolDescriptors({
      className: 'Product',
      fields: PRODUCT_FIELDS,
      actions: ['preview'],
      customActions: {
        preview: {
          scope: 'collection',
          idRequired: false,
          isStatic: true,
          effect: 'read',
          idempotent: true,
          openWorld: false,
        },
      },
    });

    expect(descriptor).toMatchObject({
      readOnly: true,
      effect: 'read',
      idempotent: true,
      openWorld: false,
    });
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

  it('propagates text idType to every CRUD descriptor', () => {
    const descriptors = buildToolDescriptors({
      className: 'TextProduct',
      fields: PRODUCT_FIELDS,
      actions: ['get', 'update', 'delete'],
      idType: 'text',
    });

    for (const descriptor of descriptors) {
      const properties = descriptor.inputSchema.properties as Record<
        string,
        unknown
      >;
      expect(properties.id).toEqual(
        expect.objectContaining({ type: 'string' }),
      );
      expect(properties.id).not.toEqual(
        expect.objectContaining({ format: 'uuid' }),
      );
    }
  });
});

describe('isCrudAction', () => {
  it('separates CRUD verbs from custom methods', () => {
    expect(isCrudAction('list')).toBe(true);
    expect(isCrudAction('delete')).toBe(true);
    expect(isCrudAction('publish')).toBe(false);
  });
});
