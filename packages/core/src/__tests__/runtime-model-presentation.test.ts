/** A4 prerequisites: reuse the runtime model, migration and presentation rails. */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCPGenerator } from '../generators/mcp.js';
import { toProviderToolSchema } from '../generators/provider-tool-schema.js';
import { APIGenerator } from '../generators/rest.js';
import { migrateSmrtSchemas } from '../migrations/orchestrate.js';
import { ObjectRegistry } from '../registry.js';
import {
  type RuntimeModelDefinition,
  registerRuntimeModel,
  runtimeModelEntry,
} from '../runtime-model.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { buildWebFieldDefinitions } from '../vite-plugin/web-collections.js';

const definition: RuntimeModelDefinition = {
  packageName: '@fixture/a4-app',
  name: 'LoanerMat',
  tableName: 'a4_mats',
  display: { label: 'size' },
  ui: { label: 'Loaner mats', icon: 'layers' },
  fields: {
    size: { type: 'text' },
    condition: { type: 'text', enum: ['new', 'used'] },
    notes: { type: 'text', ui: { widget: 'textarea' } },
    count: { type: 'integer' },
    thickness: { type: 'decimal' },
    price: { type: 'integer', ui: { format: 'money' } },
    currency: { type: 'text', ui: { widget: 'currency' } },
    purchasedOn: { type: 'datetime', ui: { format: 'date' } },
    inspectedAt: { type: 'datetime', ui: { format: 'datetime' } },
    available: { type: 'boolean' },
    customerId: {
      type: 'crossPackageRef',
      related: '@fixture/a4-provider:Customer',
    },
  },
};

describe('runtime model presentation and references (A4 prerequisites)', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });
  afterEach(async () => {
    await db.close?.();
    restore();
  });

  it('carries existing presentation contracts into manifest, registry and web definitions', async () => {
    const entry = runtimeModelEntry(definition);
    expect(entry.displayLabelField).toBe('size');
    expect(entry.decoratorConfig.ui).toEqual(definition.ui);
    expect(entry.decoratorConfig.display).toEqual({ label: 'size' });
    expect(entry.fields.notes._meta?.ui).toEqual({ widget: 'textarea' });
    expect(buildWebFieldDefinitions(entry)).toMatchObject({
      notes: { type: 'text', ui: { widget: 'textarea' } },
      price: { type: 'integer', ui: { format: 'money' } },
      currency: { type: 'text', ui: { widget: 'currency' } },
      purchasedOn: { type: 'datetime', ui: { format: 'date' } },
      inspectedAt: { type: 'datetime', ui: { format: 'datetime' } },
    });
    const key = registerRuntimeModel(definition);
    expect(ObjectRegistry.getClass(key)?.config.ui).toEqual(definition.ui);
    expect(
      (await ObjectRegistry.getAllFields(key)).get('notes')?._meta?.ui,
    ).toEqual({ widget: 'textarea' });
  });

  it('does not retain mutable presentation or enum inputs', () => {
    const input = structuredClone(definition);
    const entry = runtimeModelEntry(input);
    input.ui!.label = 'changed';
    input.display!.label = 'condition';
    input.fields!.notes.ui!.widget = 'email';
    input.fields!.condition.enum!.push('broken');
    expect(entry.decoratorConfig.ui?.label).toBe('Loaner mats');
    expect(entry.decoratorConfig.display?.label).toBe('size');
    expect(entry.fields.notes._meta?.ui?.widget).toBe('textarea');
    expect(entry.fields.condition.enum).toEqual(['new', 'used']);
  });

  it('retains inherited visibility and UI metadata when resolving display labels', () => {
    const parent = runtimeModelEntry({
      packageName: '@fixture/a4-provider',
      name: 'PrivateParent',
      fields: {
        name: { type: 'text' },
        title: { type: 'text', ui: { widget: 'textarea' } },
      },
    });
    parent.fields.name._meta = { sensitive: true };
    ObjectRegistry.registerFromManifest(parent.qualifiedName!, parent);
    const child = runtimeModelEntry({
      packageName: '@fixture/a4-app',
      name: 'PrivateChild',
      extends: parent.qualifiedName,
    });
    expect(child.fields.name._meta?.sensitive).toBe(true);
    expect(child.displayLabelField).toBe('title');
    expect(child.fields.title._meta?.ui?.widget).toBe('textarea');
    child.fields.title._meta!.ui!.widget = 'email';
    expect(
      ObjectRegistry.getFields(parent.qualifiedName!).get('title')?._meta?.ui
        ?.widget,
    ).toBe('textarea');
    expect(() =>
      runtimeModelEntry({
        packageName: '@fixture/a4-app',
        name: 'PrivateChild',
        extends: parent.qualifiedName,
        display: { label: 'name' },
      }),
    ).toThrow('sensitive');
  });

  it('uses the shared ancestor rule for runtime CTI copies and same-name replacements', () => {
    const ancestor = runtimeModelEntry({
      packageName: '@fixture/a4-provider',
      name: 'Ancestor',
      fields: {
        title: { type: 'text', required: true, ui: { widget: 'textarea' } },
        kind: { type: 'text', enum: ['base'], description: 'Base kind' },
      },
    });
    ObjectRegistry.registerFromManifest(ancestor.qualifiedName!, ancestor);
    // An unmerged provider manifest is a real lazy-loading input: it carries
    // only its own declarations, not a pre-expanded copy of its ancestors.
    const parent = {
      ...runtimeModelEntry({
        packageName: '@fixture/a4-provider',
        name: 'Provider',
        fields: {
          kind: { type: 'text', enum: ['near'], description: 'Near kind' },
        },
      }),
      extends: 'Ancestor',
      extendsQualified: ancestor.qualifiedName,
    };
    ObjectRegistry.registerFromManifest(parent.qualifiedName!, parent);
    for (const replaces of [false, true]) {
      const child = runtimeModelEntry({
        packageName: '@fixture/a4-app',
        name: replaces ? 'Provider' : 'Independent',
        extends: parent.qualifiedName,
        replaces,
        fields: { extra: { type: 'integer' } },
      });
      expect(child.fields.title.required).toBe(replaces);
      expect(child.fields.title._meta?.ui?.widget).toBe('textarea');
      expect(child.fields.kind._meta).toMatchObject({
        enum: ['near'],
        description: 'Near kind',
      });
      expect(child.schema?.columns.title?.notNull).toBe(replaces);
      expect(child.schema?.columns.extra).toBeDefined();
      expect(child.schema?.tableName).toBe(
        replaces ? 'providers' : 'independents',
      );
      child.fields.title._meta!.ui!.widget = 'email';
      expect(ancestor.fields.title._meta?.ui?.widget).toBe('textarea');
    }
  });

  it.each([
    { type: 'decimal', ui: { format: 'money' } },
    { type: 'boolean', ui: { widget: 'textarea' } },
    { type: 'text', ui: { format: 'date' } },
    { type: 'text', ui: { widget: 'unknown' } },
    { type: 'integer', ui: { format: 'unknown' } },
    { type: 'foreignKey' },
    { type: 'crossPackageRef' },
    { type: 'foreignKey', related: 'unqualified' },
    { type: 'crossPackageRef', related: '' },
    { type: 'foreignKey', related: '@fixture/other:Customer' },
  ])('rejects invalid field metadata before registration: %j', (field) => {
    expect(() =>
      registerRuntimeModel({
        ...definition,
        fields: {
          broken: field as NonNullable<
            RuntimeModelDefinition['fields']
          >[string],
        },
      }),
    ).toThrow();
    expect(
      ObjectRegistry.getClass('@fixture/a4-app:LoanerMat'),
    ).toBeUndefined();
  });

  it.each([
    'missing',
    'customerId',
  ])('rejects an invalid display label: %s', (label) => {
    expect(() =>
      runtimeModelEntry({ ...definition, display: { label } }),
    ).toThrow('display.label');
  });

  it('preserves an upstream linked display label during same-name runtime replacement', async () => {
    const customer = registerRuntimeModel({
      name: 'Customer',
      packageName: '@fixture/a4-provider',
      fields: { name: { type: 'text' } },
    });
    const projection = { via: 'customerId', field: 'name', fallback: 'Mat' };
    const parent = registerRuntimeModel({
      ...definition,
      display: { label: projection },
    });
    const replacement = {
      name: 'LoanerMat',
      packageName: '@fixture/a4-custom',
      extends: parent,
      replaces: true,
      fields: { inspector: { type: 'text' as const } },
    };
    expect(runtimeModelEntry(replacement)).toMatchObject({
      displayLabelField: 'displayLabel',
      displayLabelProjection: projection,
      decoratorConfig: { display: { label: projection } },
    });
    const effective = registerRuntimeModel(replacement, { refresh: true });
    await migrateSmrtSchemas({
      db,
      packageName: '@fixture/a4-custom',
      name: 'a4_projected_override',
      engineHint: 'sqlite',
    });
    const person = await (
      await ObjectRegistry.getCollection(customer, { db })
    ).create({ name: 'Maya' });
    const mats = await ObjectRegistry.getCollection(effective, { db });
    const mat = await mats.create({
      size: 'large',
      customerId: person.id,
      inspector: 'Ada',
    });
    const api = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (r) => r },
      { db },
    );
    api.registerCollection('mats', mats);
    const response = await api.generateHandler()(
      new Request(`http://x/api/mats/${mat.id}`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      inspector: 'Ada',
      displayLabel: 'Maya',
    });
  });

  it('refuses a physical FK before its target is registered', () => {
    expect(() =>
      registerRuntimeModel({
        packageName: '@fixture/a4-app',
        name: 'MissingTarget',
        fields: {
          matId: { type: 'foreignKey', related: '@fixture/a4-app:Unknown' },
        },
      }),
    ).toThrow('must be registered first');
    expect(
      ObjectRegistry.getClass('@fixture/a4-app:MissingTarget'),
    ).toBeUndefined();
  });

  it('round-trips every scalar field and both reference directions through REST after tracked migrations', async () => {
    const customerKey = registerRuntimeModel({
      name: 'Customer',
      packageName: '@fixture/a4-provider',
      fields: { name: { type: 'text' } },
    });
    const matKey = registerRuntimeModel(definition);
    const appCustomerKey = registerRuntimeModel({
      name: 'AppCustomer',
      packageName: '@fixture/a4-app',
      extends: customerKey,
      fields: { preferredMatId: { type: 'foreignKey', related: matKey } },
    });
    const migration = await migrateSmrtSchemas({
      db,
      packageName: '@fixture/a4-app',
      name: 'a4_runtime_fields',
      engineHint: 'sqlite',
    });
    expect(migration.applied).toBe(true);
    expect(migration.hasManualDrift).toBe(false);
    expect(migration.results.every((r) => r.success)).toBe(true);
    expect(
      (
        await migrateSmrtSchemas({
          db,
          packageName: '@fixture/a4-app',
          engineHint: 'sqlite',
        })
      ).applied,
    ).toBe(false);
    const customers = await ObjectRegistry.getCollection(customerKey, { db });
    const customer = await customers.create({ name: 'Maya' });
    const mats = await ObjectRegistry.getCollection(matKey, { db });
    const appCustomers = await ObjectRegistry.getCollection(appCustomerKey, {
      db,
    });
    const api = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (r) => r },
      { db },
    );
    api.registerCollection('mats', mats);
    api.registerCollection('app_customers', appCustomers);
    const handler = api.generateHandler();
    const values = {
      size: 'large',
      condition: 'used',
      notes: 'Wash\nafter use',
      count: 2,
      thickness: 4.5,
      price: 2500,
      currency: 'CAD',
      available: true,
      purchasedOn: '2026-11-10T00:00:00.000Z',
      inspectedAt: '2026-11-10T17:22:00.000Z',
      customerId: customer.id,
    };
    const create = await handler(
      new Request('http://x/api/mats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      }),
    );
    const created = (await create.json()) as {
      id: string;
      data?: { id: string };
    };
    expect(create.status, JSON.stringify(created)).toBe(201);
    const id = created.id ?? created.data?.id;
    expect(id).toBeTypeOf('string');
    const get = await handler(new Request(`http://x/api/mats/${id}`));
    const read = (await get.json()) as Record<string, unknown>;
    expect(get.status).toBe(200);
    expect(read.data ?? read).toMatchObject(values);
    const appCreate = await handler(
      new Request('http://x/api/app_customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Aya', preferredMatId: id }),
      }),
    );
    const appCreated = (await appCreate.json()) as {
      id: string;
      data?: { id: string; preferredMatId: string };
    };
    expect(appCreate.status, JSON.stringify(appCreated)).toBe(201);
    expect(appCreated.data ?? appCreated).toMatchObject({ preferredMatId: id });
    const mat = await mats.get(id);
    expect((await mat!.loadRelated('customerId'))?.id).toBe(customer.id);
    const appCustomer = await appCustomers.get(
      appCreated.id ?? appCreated.data?.id,
    );
    expect((await appCustomer!.loadRelated('preferredMatId'))?.id).toBe(id);
    const foreignKeys = await db.query(
      'PRAGMA foreign_key_list(app_customers)',
    );
    expect(foreignKeys.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'a4_mats', from: 'preferred_mat_id' }),
      ]),
    );
    const mcp = new MCPGenerator({ classNames: [matKey] }, { db });
    const createTool = (await mcp.generateTools()).find(
      (t) => t.name === 'loanermat_create',
    );
    expect(
      toProviderToolSchema(createTool?.inputSchema).properties,
    ).toMatchObject({
      customerId: { type: 'string' },
      condition: { enum: ['new', 'used'] },
      price: { type: 'integer' },
    });
    const rows = await db.query(
      'SELECT name FROM _smrt_schema_migrations WHERE name = ?',
      ['a4_runtime_fields'],
    );
    expect(rows.rows).toHaveLength(1);
  });
});
