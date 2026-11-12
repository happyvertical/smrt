/** A4 contract: real registry, generated REST/MCP, tracked migrations and durable history. */

import type { Cookbook, CookbookModelField } from '@happyvertical/smrt-types';
import type { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActivationCoordinator } from '../activation.js';
import { createCookbookEngine } from '../cookbook/engine/engine.js';
import {
  type AppModelEdit,
  createAppModelEditor,
} from '../cookbook/model-editor.js';
import {
  createAppModelHistory,
  createSqliteAppModelHistory,
} from '../cookbook/model-history.js';
import { COOKBOOK_SCHEMA_URL, validateCookbook } from '../cookbook/validate.js';
import { field } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { toProviderToolSchema } from '../generators/provider-tool-schema.js';
import { APIGenerator } from '../generators/rest.js';
import { migrateSmrtSchemas } from '../migrations/orchestrate.js';
import { MigrationTracker } from '../migrations/tracker.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import {
  createCookbookRuntimeExposure,
  getRuntimeModelReadiness,
  setRuntimeExposureGate,
  setRuntimeModelReadiness,
} from '../runtime-exposure.js';
import { registerRuntimeModel } from '../runtime-model.js';
import { inspectTableSchema } from '../schema/inspection.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
const engine = databaseType === 'pglite' ? 'postgres' : 'sqlite';

const APP = '@fixture/a4-editor';
const CUSTOMER = '@fixture/a4-upstream:Customer';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const book = (): Cookbook => ({
  $schema: COOKBOOK_SCHEMA_URL,
  version: 1,
  recipes: [],
  features: [CUSTOMER],
  policies: [],
});
const catalog = {
  recipes: [],
  models: [
    {
      id: CUSTOMER,
      name: 'Customer',
      packageId: 'a4-upstream',
      exposed: true,
      fields: [{ name: 'name' }],
    },
  ],
};
const list = {
  label: 'Loaner mats',
  icon: 'layers',
  displayField: 'size',
  fields: {
    size: { type: 'text' },
    condition: { type: 'choice', choices: ['new', 'used'] },
    customerId: { type: 'reference', target: CUSTOMER },
  },
} as const;

import { withTenant } from '../../../tenancy/src/context.js';
// Imported from the owning tenancy module, not a test-only implementation of isolation.
import {
  disableTenancy,
  enableTenancy,
} from '../../../tenancy/src/interceptor.js';

describe('durable app model editor', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  const upstream = (sti = false) => {
    class Customer extends SmrtObject {
      name = '';
      greeting() {
        return 'upstream behavior';
      }
    }
    field({ type: 'text' })(Customer.prototype, 'name');
    ObjectRegistry.register(Customer, {
      packageName: '@fixture/a4-upstream',
      tableName: 'customers',
      ...(sti ? { tableStrategy: 'sti' as const } : {}),
      tenantScoped: true,
      api: true,
      mcp: true,
    });
  };
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    upstream();
    enableTenancy();
    await migrateSmrtSchemas({ db, packageName: APP, engineHint: engine });
  });
  afterEach(async () => {
    setRuntimeExposureGate(undefined);
    globalThis.__smrtModelReadiness?.clear();
    disableTenancy();
    await db.close?.();
    restore();
  });
  const owner = { actor: 'owner', tenantId: TENANT };
  async function editor(
    publish?: Parameters<typeof createAppModelEditor>[0]['publish'],
  ) {
    return createAppModelEditor({
      db,
      application: 'fixture-app',
      tenantId: TENANT,
      packageName: APP,
      cookbook: book(),
      catalog,
      authorize: (context) => context.actor === 'owner',
      publish,
    });
  }
  async function edit(
    e: Awaited<ReturnType<typeof editor>>,
    value: AppModelEdit,
  ) {
    return e.apply(value, {
      ...owner,
      expectedRevision: e.snapshot().revision,
      requestId: `request-${e.snapshot().revision + 1}`,
    });
  }
  const request = (method: string, path: string, value?: unknown) =>
    new Request(`http://fixture/api/${path}`, {
      method,
      ...(value === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(value),
          }),
    });
  function api(tenant = TENANT) {
    const handler = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db, tenantId: tenant },
    ).generateHandler();
    return (req: Request) =>
      withTenant({ tenantId: tenant }, () => handler(req));
  }

  it('adds all field types to the same CTI table and the already-running REST/MCP surfaces', async () => {
    registerRuntimeModel({
      name: 'Unused',
      packageName: '@fixture/unused',
      tableName: 'a4_unused',
      fields: { title: { type: 'text' } },
    });
    const e = await editor();
    const handler = api();
    expect((await handler(request('GET', 'customers'))).status).toBe(200);
    const warmed = await ObjectRegistry.getCollection(CUSTOMER, { db });
    await withTenant({ tenantId: TENANT }, () => warmed.list({}));
    const mcp = new MCPGenerator({}, { db, tenantId: TENANT });
    const types: Record<string, CookbookModelField> = {
      preferredInstructor: { type: 'text' },
      notes: { type: 'longText' },
      visits: { type: 'integer' },
      confidence: { type: 'decimal' },
      fee: { type: 'money', currency: 'CAD' },
      birthday: { type: 'date' },
      nextVisit: { type: 'datetime' },
      paid: { type: 'boolean' },
      level: { type: 'choice', choices: ['beginner', 'advanced'] },
    };
    const timings: Record<string, number> = {};
    for (const [name, field] of Object.entries(types))
      timings[name] = (
        await edit(e, { type: 'add_field', model: CUSTOMER, name, field })
      ).elapsedMs;
    expect(ObjectRegistry.getClass(CUSTOMER)?.qualifiedName).toBe(
      `${APP}:Customer`,
    );
    expect(ObjectRegistry.getTableName(CUSTOMER)).toBe('customers');
    const data = {
      name: 'Maya',
      preferredInstructor: 'Ada',
      notes: 'Long\nnotes',
      visits: 2 ** 31 + 3,
      confidence: 0.75,
      fee: 2500,
      feeCurrency: 'CAD',
      birthday: '2000-03-04T00:00:00.000Z',
      nextVisit: '2026-11-11T12:30:00.000Z',
      paid: true,
      level: 'advanced',
    };
    await withTenant({ tenantId: TENANT }, async () => {
      const direct = await warmed.create({
        ...data,
        name: 'Warmed collection',
      });
      expect(direct.toJSON()).toMatchObject({
        preferredInstructor: 'Ada',
        fee: 2500,
      });
    });
    const response = await handler(request('POST', 'customers', data));
    const created = (await response.json()) as Record<string, unknown>;
    expect(response.status, JSON.stringify(created)).toBe(201);
    expect(created).toMatchObject(data);
    expect(
      (await api(OTHER)(request('GET', `customers/${created.id}`))).status,
    ).toBe(404);
    for (const invalid of [
      { fee: 1.5 },
      { feeCurrency: 'not-a-currency' },
      { visits: 'many' },
      { level: 'unknown' },
    ]) {
      expect(
        (await handler(request('POST', 'customers', { ...data, ...invalid })))
          .status,
      ).not.toBe(201);
    }
    const get = await handler(request('GET', `customers/${created.id}`));
    expect(await get.json()).toMatchObject(data);
    const tool = (await mcp.generateTools()).find(
      (tool) => tool.name === 'customer_create',
    );
    expect(toProviderToolSchema(tool?.inputSchema).properties).toMatchObject({
      preferredInstructor: { type: 'string' },
      fee: { type: 'integer' },
      level: { enum: ['beginner', 'advanced'] },
    });
    expect(
      e.snapshot().webDefinitions.find((def) => def.className === 'Customer')
        ?.fields,
    ).toHaveProperty('preferredInstructor');
    expect(ObjectRegistry.getAllClasses().has(CUSTOMER)).toBe(false);
    expect(
      (
        await db.query(
          databaseType === 'pglite'
            ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'a4_unused'"
            : "SELECT name FROM sqlite_master WHERE name = 'a4_unused'",
        )
      ).rows,
    ).toHaveLength(0);
    console.log('A4 field activation milliseconds', JSON.stringify(timings));
  });

  it('creates a live custom list with both reference directions and tenant isolation', async () => {
    let engine = createCookbookEngine({ catalog, cookbook: book() });
    const gate = createCookbookRuntimeExposure({
      catalog,
      engineFor: ({ tenantId }) => (tenantId === TENANT ? engine : null),
    });
    const activation = createActivationCoordinator({
      scope: `a4-editor-${crypto.randomUUID()}`,
      db,
      packageName: APP,
      manifest: {
        version: 1,
        modules: {
          customer: {
            specifier: 'fixture',
            models: [CUSTOMER],
            dependencies: [],
          },
        },
        models: {
          [CUSTOMER]: {
            module: 'customer',
            effective: CUSTOMER,
            table: 'customers',
            dependencies: [],
          },
        },
        tables: { customers: { owners: [CUSTOMER], dependencies: [] } },
      },
      loaders: { customer: async () => {} },
      readEnabled: async () => [CUSTOMER],
    });
    await activation.boot();
    expect(activation.isReady(`${APP}:LoanerMat`)).toBe(false);
    setRuntimeExposureGate(activation.gate(gate));
    const e = await editor((snapshot) => {
      engine = createCookbookEngine({ catalog, cookbook: snapshot.cookbook });
    });
    const handler = api();
    expect((await handler(request('GET', 'loaner_mats'))).status).toBe(404);
    const createdList = await edit(e, {
      type: 'create_list',
      name: 'LoanerMat',
      list: structuredClone(list) as unknown as NonNullable<
        Cookbook['models']
      >['lists'][string],
    });
    await edit(e, {
      type: 'add_field',
      model: CUSTOMER,
      name: 'preferredMatId',
      field: { type: 'reference', target: 'LoanerMat' },
    });
    const customerResponse = await handler(
      request('POST', 'customers', { name: 'Maya' }),
    );
    const customer = (await customerResponse.json()) as { id: string };
    expect(customerResponse.status, JSON.stringify(customer)).toBe(201);
    const matResponse = await handler(
      request('POST', 'loaner_mats', {
        size: 'large',
        condition: 'used',
        customerId: customer.id,
      }),
    );
    const mat = (await matResponse.json()) as { id: string };
    expect(matResponse.status, JSON.stringify(mat)).toBe(201);
    expect(
      (
        await handler(
          request('PATCH', `customers/${customer.id}`, {
            preferredMatId: mat.id,
          }),
        )
      ).status,
    ).toBe(200);
    await withTenant({ tenantId: TENANT }, async () => {
      const customers = await ObjectRegistry.getCollection(CUSTOMER, { db });
      expect(
        (
          await (await customers.get(customer.id))!.loadRelated(
            'preferredMatId',
          )
        )?.id,
      ).toBe(mat.id);
      const mats = await ObjectRegistry.getCollection(`${APP}:LoanerMat`, {
        db,
      });
      expect(
        (await (await mats.get(mat.id))!.loadRelated('customerId'))?.id,
      ).toBe(customer.id);
    });
    // Another tenant can't edit the schema; its cookbook gate also denies the custom list.
    await expect(
      e.apply(
        { type: 'remove_list', name: 'LoanerMat' },
        {
          ...owner,
          tenantId: OTHER,
          expectedRevision: 2,
          requestId: 'wrong-tenant',
        },
      ),
    ).rejects.toThrow('FORBIDDEN');
    expect(
      (await api(OTHER)(request('GET', `loaner_mats/${mat.id}`))).status,
    ).toBe(404);
    const relabel = await edit(e, {
      type: 'relabel_list',
      name: 'LoanerMat',
      label: 'Studio mats',
      icon: 'box',
    });
    expect(
      ObjectRegistry.getClass(`${APP}:LoanerMat`)?.config.ui,
    ).toMatchObject({ label: 'Studio mats', icon: 'box' });
    expect(activation.isReady(`${APP}:LoanerMat`)).toBe(true);
    const removed = await edit(e, { type: 'remove_list', name: 'LoanerMat' });
    expect(activation.isReady(`${APP}:LoanerMat`)).toBe(false);
    expect((await handler(request('GET', 'loaner_mats'))).status).toBe(404);
    expect(
      (await db.query('SELECT COUNT(*) AS n FROM loaner_mats')).rows[0].n,
    ).toBe(1);
    await edit(e, { type: 'undo' });
    expect(
      (await handler(request('GET', `loaner_mats/${mat.id}`))).status,
    ).toBe(200);
    console.log(
      'A4 list activation/relabel/removal milliseconds',
      createdList.elapsedMs,
      relabel.elapsedMs,
      removed.elapsedMs,
    );
    gate.dispose();
  });

  it('relabels/hides/removes fields through policies and undoes durably after a registry restart', async () => {
    let e = await editor();
    await edit(e, {
      type: 'add_field',
      model: CUSTOMER,
      name: 'preferredInstructor',
      field: { type: 'text' },
    });
    const created = await api()(
      request('POST', 'customers', {
        name: 'Maya',
        preferredInstructor: 'Ada',
      }),
    );
    const row = (await created.json()) as { id: string };
    const label = await edit(e, {
      type: 'label_field',
      model: CUSTOMER,
      name: 'preferredInstructor',
      label: 'Your teacher',
    });
    expect(label.path).toBe('policy');
    const hide = await edit(e, {
      type: 'hide_field',
      model: CUSTOMER,
      name: 'preferredInstructor',
      hidden: true,
    });
    expect(hide.cookbook.policies).toContainEqual(
      expect.objectContaining({ label: 'Your teacher', visibility: 'hidden' }),
    );
    await edit(e, {
      type: 'hide_field',
      model: CUSTOMER,
      name: 'preferredInstructor',
      hidden: false,
    });
    const remove = await edit(e, {
      type: 'remove_field',
      model: CUSTOMER,
      name: 'preferredInstructor',
    });
    const exported = e.export();
    expect(validateCookbook(JSON.parse(exported)).ok).toBe(true);
    ObjectRegistry.clear();
    upstream();
    const boot = performance.now();
    e = await editor();
    const bootMs = performance.now() - boot;
    expect(e.snapshot().revision).toBe(5);
    const undo = await edit(e, { type: 'undo' });
    expect(e.snapshot().cookbook.policies).toContainEqual(
      expect.objectContaining({ label: 'Your teacher', visibility: 'basic' }),
    );
    expect(
      await (await api()(request('GET', `customers/${row.id}`))).json(),
    ).toMatchObject({ preferredInstructor: 'Ada' });
    const imported = await edit(e, {
      type: 'import',
      cookbook: JSON.parse(exported),
    });
    expect(imported.cookbook.policies).toEqual(remove.cookbook.policies);
    expect((await e.history()).map((row) => row.revision)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    console.log(
      'A4 policy milliseconds',
      label.elapsedMs,
      hide.elapsedMs,
      remove.elapsedMs,
    );
    console.log(
      'A4 boot/undo/import milliseconds',
      bootMs,
      undo.elapsedMs,
      imported.elapsedMs,
    );
  });

  it.each([
    'name',
    'save',
    'greeting',
    'constructor',
    'tenantId',
    'displayLabel',
    '__proto__',
    'bad-name',
    'select',
    'order',
    'group',
    'from',
    'to',
  ])('refuses protected names or collisions: %s', async (name) => {
    const e = await editor();
    const action = e.apply(
      { type: 'add_field', model: CUSTOMER, name, field: { type: 'text' } },
      { ...owner, expectedRevision: 0, requestId: 'bad' },
    );
    await expect(action).rejects.toThrow();
    expect(await e.history()).toHaveLength(0);
  });

  it('refuses a field inherited from an upstream ancestor', async () => {
    await db.close?.();
    ObjectRegistry.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    class CustomerBase extends SmrtObject {
      ancestorCode = '';
    }
    field({ type: 'text' })(CustomerBase.prototype, 'ancestorCode');
    ObjectRegistry.register(CustomerBase, {
      packageName: '@fixture/a4-upstream',
    });
    class Customer extends CustomerBase {
      name = '';
    }
    field({ type: 'text' })(Customer.prototype, 'name');
    ObjectRegistry.register(Customer, {
      packageName: '@fixture/a4-upstream',
      tableName: 'customers',
      tenantScoped: true,
      api: true,
    });
    await migrateSmrtSchemas({
      db,
      packageName: APP,
      name: 'inherited_fixture',
      engineHint: engine,
      ...(databaseType === 'pglite'
        ? { atomic: true, postgresSafe: false, useConcurrentIndexes: false }
        : {}),
    });
    const e = await editor();
    await expect(
      edit(e, {
        type: 'add_field',
        model: CUSTOMER,
        name: 'ancestorCode',
        field: { type: 'text' },
      }),
    ).rejects.toThrow('FIELD_NAME_COLLISION');
    expect(await e.history()).toHaveLength(0);
  });

  it('extends an STI provider in its existing table without losing sibling fields', async () => {
    await db.close?.();
    ObjectRegistry.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    upstream(true);
    const base = ObjectRegistry.getClass(CUSTOMER)!
      .constructor as typeof SmrtObject;
    class Student extends base {
      grade = '';
    }
    field({ type: 'text' })(Student.prototype, 'grade');
    ObjectRegistry.register(Student, {
      packageName: '@fixture/a4-upstream',
      tenantScoped: true,
    });
    await migrateSmrtSchemas({
      db,
      packageName: APP,
      name: 'fixture_sti',
      engineHint: engine,
      ...(databaseType === 'pglite'
        ? { atomic: true, postgresSafe: false, useConcurrentIndexes: false }
        : {}),
    });
    const e = await editor();
    await edit(e, {
      type: 'add_field',
      model: CUSTOMER,
      name: 'customNote',
      field: { type: 'text' },
    });
    expect(ObjectRegistry.getTableName(CUSTOMER)).toBe('customers');
    const schema = ObjectRegistry.getAllSchemasAsDefinitions().customers;
    expect(schema.columns).toHaveProperty('custom_note');
    expect(schema.columns).toHaveProperty('grade');
    const response = await api()(
      request('POST', 'customers', { name: 'Maya', customNote: 'STI' }),
    );
    const created = (await response.json()) as { id: string };
    expect(response.status, JSON.stringify(created)).toBe(201);
    expect(
      await (await api()(request('GET', `customers/${created.id}`))).json(),
    ).toMatchObject({ customNote: 'STI' });
  });

  it('keeps money companions hidden on undo and imports portable models into a fresh app database', async () => {
    let e = await editor();
    await edit(e, {
      type: 'add_field',
      model: CUSTOMER,
      name: 'fee',
      field: { type: 'money', currency: 'CAD' },
    });
    const portable = e.export();
    const removed = await edit(e, {
      type: 'remove_field',
      model: CUSTOMER,
      name: 'fee',
    });
    expect(
      removed.cookbook.policies
        .filter((p) => p.visibility === 'hidden')
        .map((p) => p.fieldName)
        .sort(),
    ).toEqual(['fee', 'feeCurrency']);
    await edit(e, { type: 'undo' });
    const undone = await edit(e, { type: 'undo' });
    expect(
      undone.cookbook.policies
        .filter((p) => p.visibility === 'hidden')
        .map((p) => p.fieldName)
        .sort(),
    ).toEqual(['fee', 'feeCurrency']);
    expect(
      (
        await db.query(
          databaseType === 'pglite'
            ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'customers'"
            : 'PRAGMA table_info(customers)',
        )
      ).rows.some((r) => r.name === 'fee'),
    ).toBe(true);
    await db.close?.();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    upstream();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    await migrateSmrtSchemas({ db, packageName: APP, engineHint: engine });
    expect(ObjectRegistry.getFields(CUSTOMER).has('fee')).toBe(false);
    e = await editor();
    expect(e.snapshot().cookbook.models).toBeUndefined();
    const imported = await edit(e, {
      type: 'import',
      cookbook: JSON.parse(portable),
    });
    expect(imported.cookbook.models?.fields[CUSTOMER].fee.type).toBe('money');
    const response = await api()(
      request('POST', 'customers', {
        name: 'Maya',
        fee: 1500,
        feeCurrency: 'CAD',
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      fee: 1500,
      feeCurrency: 'CAD',
    });
  });

  it('extends an existing same-name app subclass and keeps its upstream behavior', async () => {
    const base = ObjectRegistry.getClass(CUSTOMER)!
      .constructor as typeof SmrtObject;
    class AppCustomer extends base {}
    ObjectRegistry.register(AppCustomer, {
      name: 'Customer',
      packageName: APP,
    });
    const e = await editor();
    await edit(e, {
      type: 'add_field',
      model: CUSTOMER,
      name: 'customNote',
      field: { type: 'text' },
    });
    const created = await api()(
      request('POST', 'customers', { name: 'Maya', customNote: 'retained' }),
    );
    const row = (await created.json()) as { id: string };
    expect(created.status, JSON.stringify(row)).toBe(201);
    await withTenant({ tenantId: TENANT }, async () => {
      const record = await (
        await ObjectRegistry.getCollection(CUSTOMER, { db })
      ).get(row.id);
      expect((record as unknown as { greeting(): string }).greeting()).toBe(
        'upstream behavior',
      );
    });
  });

  it('fences concurrent editors before the losing edit can change registry or storage', async () => {
    const first = await editor();
    const second = await editor();
    const command = (name: string) =>
      ({
        type: 'add_field',
        model: CUSTOMER,
        name,
        field: { type: 'text' },
      }) as const;
    const results = await Promise.allSettled([
      first.apply(command('firstField'), {
        ...owner,
        expectedRevision: 0,
        requestId: 'first-editor',
      }),
      second.apply(command('secondField'), {
        ...owner,
        expectedRevision: 0,
        requestId: 'second-editor',
      }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { message: 'MODEL_EDIT_CONFLICT' },
    });
    const history = await first.history();
    expect(history.map((row) => [row.revision, row.status])).toEqual([
      [1, 'applied'],
    ]);
    const schema = await inspectTableSchema(db, 'customers', engine);
    expect(schema?.columns).toHaveProperty('first_field');
    expect(schema?.columns).not.toHaveProperty('second_field');
    expect(ObjectRegistry.getFields(CUSTOMER).has('secondField')).toBe(false);
    const reopened = await editor();
    expect(reopened.snapshot().revision).toBe(1);
    expect(createSqliteAppModelHistory).toBe(createAppModelHistory);
    if (engine === 'postgres') {
      const journal = await inspectTableSchema(
        db,
        '_smrt_app_model_changes',
        engine,
      );
      expect(journal?.columns.tenant_id.type).toBe('uuid');
      expect(journal?.columns.revision.type).toBe('bigint');
    }
  });

  it.runIf(databaseType === 'pglite')(
    'restores staged boot registrations when the enclosing DDL commit fails',
    async () => {
      const store = await createAppModelHistory({
        db,
        application: 'fixture-app',
        tenantId: TENANT,
      });
      const initial = {
        ...book(),
        models: {
          version: 1 as const,
          packageName: APP,
          lists: {},
          fields: { [CUSTOMER]: { bootTag: { type: 'text' as const } } },
        },
      };
      const publish = vi.fn();
      const open = () =>
        createAppModelEditor({
          db,
          application: 'fixture-app',
          tenantId: TENANT,
          packageName: APP,
          cookbook: initial,
          catalog,
          store,
          authorize: () => true,
          publish,
        });
      setRuntimeModelReadiness([CUSTOMER], true);
      expect(getRuntimeModelReadiness(`${APP}:Customer`)).toBeUndefined();
      const begin = db.beginTransaction!.bind(db);
      const failure = vi
        .spyOn(db, 'beginTransaction')
        .mockImplementation(async () => {
          const tx = await begin();
          vi.spyOn(tx, 'commit').mockRejectedValueOnce(
            new Error('injected commit failure'),
          );
          return tx;
        });
      await expect(open()).rejects.toThrow('injected commit failure');
      failure.mockRestore();
      expect(getRuntimeModelReadiness(CUSTOMER)).toBe(true);
      expect(getRuntimeModelReadiness(`${APP}:Customer`)).toBeUndefined();
      expect(publish).not.toHaveBeenCalled();
      expect(
        (await inspectTableSchema(db, 'customers', engine))?.columns,
      ).not.toHaveProperty('boot_tag');
      expect(ObjectRegistry.getFields(CUSTOMER).has('bootTag')).toBe(false);
      expect(await store.read()).toEqual([]);
      const recovered = await open();
      expect(
        recovered.snapshot().cookbook.models?.fields[CUSTOMER].bootTag.type,
      ).toBe('text');
    },
  );

  it.runIf(databaseType === 'pglite')(
    'rolls back field DDL, registry, history and markers together, then retries the same request',
    async () => {
      const publish = vi.fn();
      const e = await editor(publish);
      await edit(e, {
        type: 'add_field',
        model: CUSTOMER,
        name: 'stableField',
        field: { type: 'text' },
      });
      const markers = (
        await db.query(
          'SELECT name, status FROM _smrt_schema_migrations ORDER BY name',
        )
      ).rows;
      const publications = publish.mock.calls.length;
      const original = MigrationTracker.prototype.apply;
      let fail = true;
      const injection = vi
        .spyOn(MigrationTracker.prototype, 'apply')
        .mockImplementation(function (
          this: MigrationTracker,
          definition,
          options,
        ) {
          if (fail && definition.id.startsWith('app_models_')) {
            fail = false;
            return original.call(
              this,
              {
                ...definition,
                up: [
                  ...definition.up,
                  'SELECT * FROM _smrt_injected_missing_relation',
                ],
              },
              options,
            );
          }
          return original.call(this, definition, options);
        });
      const command = {
        type: 'add_field',
        model: CUSTOMER,
        name: 'retryField',
        field: { type: 'text' },
      } as const;
      const context = {
        ...owner,
        expectedRevision: 1,
        requestId: 'retry-after-ddl',
      };
      await expect(e.apply(command, context)).rejects.toThrow('does not exist');
      injection.mockRestore();
      expect(publish.mock.calls).toHaveLength(publications);
      expect(e.snapshot().revision).toBe(1);
      expect((await e.history()).map((row) => row.revision)).toEqual([1]);
      expect(
        (
          await db.query(
            'SELECT name, status FROM _smrt_schema_migrations ORDER BY name',
          )
        ).rows,
      ).toEqual(markers);
      expect(
        (await inspectTableSchema(db, 'customers', engine))?.columns,
      ).not.toHaveProperty('retry_field');
      expect(ObjectRegistry.getFields(CUSTOMER).has('stableField')).toBe(true);
      expect(ObjectRegistry.getFields(CUSTOMER).has('retryField')).toBe(false);
      await e.apply(command, context);
      expect(
        (await e.history()).map((row) => [row.revision, row.status]),
      ).toEqual([
        [1, 'applied'],
        [2, 'applied'],
      ]);
      expect(ObjectRegistry.getFields(CUSTOMER).has('retryField')).toBe(true);
    },
  );

  it.runIf(databaseType === 'pglite')(
    'rechecks revision CAS inside the DDL transaction after a competing writer commits',
    async () => {
      const store = await createAppModelHistory({
        db,
        application: 'fixture-app',
        tenantId: TENANT,
      });
      const read = store.read.bind(store);
      let race = false;
      store.read = async () => {
        const observed = await read();
        if (race) {
          race = false;
          await store.transaction!(async (scoped, tx) => {
            await scoped.append(
              {
                revision: 1,
                requestId: 'other-process',
                actor: 'owner',
                command: 'remote',
                before: book(),
                after: book(),
                status: 'pending',
              },
              0,
            );
            await tx.query(
              'ALTER TABLE customers ADD COLUMN remote_field TEXT',
            );
            await scoped.complete(1, 1);
          });
        }
        return observed;
      };
      const e = await createAppModelEditor({
        db,
        application: 'fixture-app',
        tenantId: TENANT,
        packageName: APP,
        cookbook: book(),
        catalog,
        store,
        authorize: () => true,
      });
      race = true;
      await expect(
        e.apply(
          {
            type: 'add_field',
            model: CUSTOMER,
            name: 'losingField',
            field: { type: 'text' },
          },
          { ...owner, expectedRevision: 0, requestId: 'loser' },
        ),
      ).rejects.toThrow('MODEL_EDIT_CONFLICT');
      expect((await read()).map((row) => row.requestId)).toEqual([
        'other-process',
      ]);
      expect(
        (await inspectTableSchema(db, 'customers', engine))?.columns,
      ).not.toHaveProperty('losing_field');
      expect(ObjectRegistry.getFields(CUSTOMER).has('losingField')).toBe(false);
    },
  );

  it('refuses stale revisions, another owner, and request-id content reuse; replays a committed retry', async () => {
    const e = await editor();
    const command = {
      type: 'add_field',
      model: CUSTOMER,
      name: 'tag',
      field: { type: 'text' },
    } as const;
    const context = { ...owner, expectedRevision: 0, requestId: 'once' };
    await e.apply(command, context);
    expect((await e.apply(command, context)).replayed).toBe(true);
    await expect(
      e.apply({ ...command, name: 'other' }, context),
    ).rejects.toThrow('REUSED');
    await expect(
      e.apply(
        { ...command, name: 'other' },
        { ...context, requestId: 'stale' },
      ),
    ).rejects.toThrow('CONFLICT');
    await expect(
      e.apply(command, { ...context, actor: 'reader', requestId: 'reader' }),
    ).rejects.toThrow('FORBIDDEN');
    expect(await e.history()).toHaveLength(1);
  });
});

describe('app model activation recovery', () => {
  it('persists to disk, recovers a failed publication, and preserves a pending revision gate', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { isRuntimeModelEnabled } = await import('../runtime-exposure.js');
    const restore = snapshotObjectRegistryState();
    const directory = await mkdtemp(join(tmpdir(), 'a4-history-'));
    let db = await getTestDatabase({
      type: databaseType,
      url: join(directory, 'app.sqlite'),
      classes: [],
      includeSystemTables: false,
    });
    try {
      ObjectRegistry.clear();
      globalThis.__smrtModelReadiness?.clear();
      const register = () =>
        registerRuntimeModel({
          name: 'Customer',
          packageName: '@fixture/a4-upstream',
          fields: { name: { type: 'text' } },
        });
      register();
      let fail = false;
      const options = () => ({
        db,
        application: 'recovery-app',
        tenantId: TENANT,
        packageName: APP,
        cookbook: book(),
        catalog,
        authorize: () => true,
        publish: () => {
          if (fail) throw new Error('publication unavailable');
        },
      });
      let e = await createAppModelEditor(options());
      fail = true;
      await expect(
        e.apply(
          {
            type: 'add_field',
            model: CUSTOMER,
            name: 'tag',
            field: { type: 'text' },
          },
          {
            actor: 'owner',
            tenantId: TENANT,
            requestId: 'recover',
            expectedRevision: 0,
          },
        ),
      ).rejects.toThrow('publication unavailable');
      expect((await e.history())[0].status).toBe('pending');
      expect(
        isRuntimeModelEnabled(ObjectRegistry.getExposureModel(CUSTOMER), {
          surface: 'rest',
          tenantId: TENANT,
        }),
      ).toBe(false);
      expect(() => e.snapshot()).toThrow('PENDING');
      await db.close?.();
      ObjectRegistry.clear();
      register();
      fail = false;
      db = await getTestDatabase({
        type: databaseType,
        url: join(directory, 'app.sqlite'),
        classes: [],
        includeSystemTables: false,
      });
      e = await createAppModelEditor(options());
      expect(e.snapshot().revision).toBe(1);
      expect((await e.history())[0].status).toBe('applied');
      expect(ObjectRegistry.getFields(CUSTOMER).has('tag')).toBe(true);
      expect(
        isRuntimeModelEnabled(ObjectRegistry.getExposureModel(CUSTOMER), {
          surface: 'rest',
          tenantId: TENANT,
        }),
      ).toBe(true);
      const exported = JSON.parse(e.export());
      expect(exported.models.fields[CUSTOMER].tag).toEqual({ type: 'text' });
      await e.apply(
        { type: 'undo' },
        {
          actor: 'owner',
          tenantId: TENANT,
          requestId: 'undo',
          expectedRevision: 1,
        },
      );
      expect(e.snapshot().cookbook.policies).toContainEqual(
        expect.objectContaining({ fieldName: 'tag', visibility: 'hidden' }),
      );
      expect(
        (
          await db.query(
            databaseType === 'pglite'
              ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'customers'"
              : 'PRAGMA table_info(customers)',
          )
        ).rows.map((row) => row.name),
      ).toContain('tag');
    } finally {
      await db.close?.();
      ObjectRegistry.clear();
      globalThis.__smrtModelReadiness?.clear();
      restore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
