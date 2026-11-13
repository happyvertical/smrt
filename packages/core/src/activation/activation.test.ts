import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActivationCoordinator } from '../activation.js';
import { migrateSmrtSchemas } from '../migrations/orchestrate.js';
import { SmrtObject } from '../object.js';
import { manifestEntry } from '../registry/__tests__/helpers/consumer-workspace.js';
import { ObjectRegistry } from '../registry.js';
import {
  isRuntimeModelEnabled,
  setRuntimeExposureGate,
} from '../runtime-exposure.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { inspectTableSchema } from '../schema/inspection.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import { buildActivationManifest } from './generate.js';
import { activationClosure } from './manifest.js';

const HOST = '@activation/host:Host';
const CUSTOMER = '@activation/customers:Customer';
const APP = '@activation/app:Customer';
const PERSON = '@activation/profiles:Profile';
const STUDENT = '@activation/profiles:Student';
const INVOICE = '@activation/billing:Invoice';
const UNUSED = '@activation/unused:Unused';
let restore: () => void;
let db: DatabaseInterface;
let directory: string;
let sequence = 0;
const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
const engine = databaseType === 'pglite' ? 'postgres' : 'sqlite';
const SAVED = '33333333-3333-4333-8333-333333333333';
beforeEach(async () => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
  directory = mkdtempSync(join(tmpdir(), 'smrt-activation-'));
  db = await getTestDatabase({
    type: databaseType,
    url: join(directory, 'app.sqlite'),
    classes: [],
    includeSystemTables: false,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  setRuntimeExposureGate(undefined);
  await db.close?.();
  restore();
  rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const objects: Record<string, SmartObjectDefinition> = {};
  const define = (id: string, tableName: string, parent?: string) => {
    const [pkg, name] = id.split(':');
    const entry = manifestEntry({
      className: name,
      packageName: pkg,
      filePath: `/fixture/${name}.ts`,
      tableName,
      fields: {},
    });
    entry.schema!.columns = {
      id: { type: 'UUID', primaryKey: true },
      title: { type: 'TEXT' },
      visits: { type: 'INTEGER' },
    };
    entry.fields = { title: { type: 'text' }, visits: { type: 'integer' } };
    entry.decoratorConfig = { tableName, api: { public: true } };
    if (parent) {
      entry.extends = parent.split(':')[1];
      entry.extendsQualified = parent;
    }
    objects[id] = entry;
    return entry;
  };
  define(HOST, 'activation_host');
  define(PERSON, 'activation_profiles').decoratorConfig.tableStrategy = 'sti';
  define(STUDENT, 'activation_profiles', PERSON);
  for (const id of [PERSON, STUDENT])
    objects[id].schema!.columns._meta_type = { type: 'TEXT' };
  const customer = define(CUSTOMER, 'activation_customers');
  customer.fields.profileId = { type: 'crossPackageRef', related: PERSON };
  customer.schema!.columns.profile_id = {
    type: 'UUID',
    foreignKey: { table: 'activation_profiles', column: 'id' },
  };
  const app = define(APP, 'activation_customers', CUSTOMER);
  app.fields = { ...customer.fields, preferredPose: { type: 'text' } };
  app.schema!.columns = {
    ...customer.schema!.columns,
    preferred_pose: { type: 'TEXT' },
  };
  const invoice = define(INVOICE, 'activation_invoices');
  invoice.fields.customerId = { type: 'crossPackageRef', related: CUSTOMER };
  invoice.schema!.columns.customer_id = {
    type: 'UUID',
    foreignKey: { table: 'activation_customers', column: 'id' },
  };
  define(UNUSED, 'activation_unused');
  const manifest: SmartObjectManifest = {
    version: '1',
    timestamp: 0,
    packageName: '@activation/app',
    objects,
  };
  const modules = Object.fromEntries(
    Object.keys(objects).map((id) => [
      id,
      { specifier: id, models: [id], dependencies: [] as string[] },
    ]),
  );
  // An ordinary module import without any relationship must also be activated.
  modules[INVOICE].dependencies.push(HOST);
  const graph = buildActivationManifest(manifest, modules);
  const constructors = new Map<string, typeof SmrtObject>();
  const loaders = Object.fromEntries(
    Object.keys(objects).map((id) => [
      id,
      vi.fn(async () => {
        const entry = objects[id];
        let Parent = SmrtObject;
        if (entry.extendsQualified) {
          await load(entry.extendsQualified);
          Parent = constructors.get(entry.extendsQualified)!;
        }
        const Class =
          constructors.get(id) ??
          { [entry.className]: class extends Parent {} }[entry.className];
        constructors.set(id, Class);
        ObjectRegistry.register(Class, {
          ...entry.decoratorConfig,
          name: entry.className,
          packageName: entry.packageName,
          _manifest: {
            ...manifest,
            packageName: entry.packageName,
            objects: { [id]: entry },
          },
          _manifestKey: id,
        });
      }),
    ]),
  );
  const load = async (id: string) => {
    if (!ObjectRegistry.getClass(id)) await loaders[id]();
  };
  const enabled = new Map<string, Set<string>>([
    ['a', new Set([HOST])],
    ['b', new Set()],
  ]);
  const options = {
    scope: `fixture-${sequence++}`,
    db,
    manifest: graph,
    loaders,
    alwaysOn: [HOST],
    packageName: '@activation/app',
    readEnabled: async () => [...enabled.values()].flatMap((ids) => [...ids]),
  };
  const coordinator = createActivationCoordinator(options);
  setRuntimeExposureGate(
    coordinator.gate({
      isEnabled: (model, context) =>
        !!context.tenantId &&
        !!model.qualifiedName &&
        (enabled.get(context.tenantId)?.has(model.qualifiedName) ?? false),
    }),
  );
  return { coordinator, enabled, loaders, options, graph };
}
async function applicationTables() {
  const { rows } = await db.query(
    databaseType === 'pglite'
      ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'activation_%' ORDER BY table_name"
      : "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'activation_%' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

describe(`${engine} lazy activation`, () => {
  it('boots only the persisted union plus always-on, without registering the disabled superset', async () => {
    const { coordinator, enabled } = fixture();
    enabled.get('b')?.add(UNUSED);
    await coordinator.boot();
    expect(await applicationTables()).toEqual([
      'activation_host',
      'activation_unused',
    ]);
    expect([...ObjectRegistry.getAllClasses().keys()].sort()).toEqual(
      [HOST, UNUSED].sort(),
    );
    expect(
      isRuntimeModelEnabled(UNUSED, { surface: 'rest', tenantId: 'a' }),
    ).toBe(false);
    expect(
      isRuntimeModelEnabled(UNUSED, { surface: 'rest', tenantId: 'b' }),
    ).toBe(true);
    expect(isRuntimeModelEnabled(HOST, { surface: 'rest' })).toBe(false);
  });

  it('activates FK, module, STI and effective app replacement closures before opening the tenant gate', async () => {
    const { coordinator, enabled, graph } = fixture();
    await coordinator.boot();
    // Persisted enablement racing DDL still cannot open readiness early.
    enabled.get('a')?.add(INVOICE);
    expect(
      isRuntimeModelEnabled(INVOICE, { surface: 'rest', tenantId: 'a' }),
    ).toBe(false);
    await coordinator.activate([INVOICE]);
    expect(activationClosure(graph, [INVOICE]).models).toEqual(
      [APP, INVOICE, CUSTOMER, HOST, PERSON, STUDENT].sort(),
    );
    expect(await applicationTables()).toEqual([
      'activation_customers',
      'activation_host',
      'activation_invoices',
      'activation_profiles',
    ]);
    const schema = await inspectTableSchema(db, 'activation_customers', engine);
    expect(schema?.columns).toHaveProperty('preferred_pose');
    const invoiceSchema = await inspectTableSchema(
      db,
      'activation_invoices',
      engine,
    );
    expect(invoiceSchema?.foreignKeys.map((fk) => fk.referencesTable)).toEqual([
      'activation_customers',
    ]);
    if (engine === 'postgres') {
      expect(schema?.columns.id.type).toBe('uuid');
      expect(schema?.columns.visits.type).toBe('bigint');
      expect(invoiceSchema?.columns.customer_id.type).toBe('uuid');
    }
    expect(ObjectRegistry.getClass(APP)?.constructor.name).toBe('Customer');
    expect(coordinator.isReady(CUSTOMER)).toBe(true);
    expect(coordinator.isReady(STUDENT)).toBe(true);
    expect(ObjectRegistry.getClass(UNUSED)).toBeUndefined();
    expect(
      isRuntimeModelEnabled(INVOICE, { surface: 'mcp', tenantId: 'a' }),
    ).toBe(true);
    expect(
      isRuntimeModelEnabled(INVOICE, { surface: 'mcp', tenantId: 'b' }),
    ).toBe(false);
    enabled.get('a')?.delete(INVOICE);
    expect(
      isRuntimeModelEnabled(INVOICE, { surface: 'rest', tenantId: 'a' }),
    ).toBe(false);
    expect(coordinator.isReady(INVOICE)).toBe(true);
    expect(await applicationTables()).toHaveLength(4);
  });

  it('coalesces equal requests and serializes overlapping tenant activations process-wide', async () => {
    const { coordinator, loaders, options } = fixture();
    expect(createActivationCoordinator(options)).toBe(coordinator);
    await coordinator.boot();
    const first = coordinator.activate([INVOICE]);
    expect(coordinator.activate([INVOICE])).toBe(first);
    await Promise.all([
      first,
      coordinator.activate([CUSTOMER]),
      coordinator.activate([INVOICE, UNUSED]),
    ]);
    expect(loaders[INVOICE]).toHaveBeenCalledTimes(1);
    expect(loaders[UNUSED]).toHaveBeenCalledTimes(1);
    const { rows } = await db.query(
      "SELECT COUNT(*) AS count FROM _smrt_schema_migrations WHERE status = 'completed'",
    );
    expect(Number(rows[0].count)).toBe(3); // boot, first closure, unused; overlap no-op
  });

  it('rechecks committed tables for independent coordinators without escaping the migration transaction', async () => {
    const { coordinator, options } = fixture();
    const other = createActivationCoordinator({
      ...options,
      scope: `${options.scope}-other`,
    });
    const forbidden =
      engine === 'postgres'
        ? [
            vi
              .spyOn(db, 'query')
              .mockRejectedValue(
                new Error('pooled executor forbidden during activation'),
              ),
            vi
              .spyOn(db, 'getTableSchema')
              .mockRejectedValue(
                new Error('pooled inspector forbidden during activation'),
              ),
          ]
        : [];
    await Promise.all([
      coordinator.activate([INVOICE]),
      other.activate([INVOICE]),
    ]);
    for (const spy of forbidden) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    expect(coordinator.isReady(INVOICE)).toBe(true);
    expect(other.isReady(INVOICE)).toBe(true);
    expect(await applicationTables()).toHaveLength(4);
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) AS count FROM _smrt_schema_migrations WHERE status = 'completed'",
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  });

  it('rolls back a failed migration, keeps exposure closed, and retries the same loaded closure', async () => {
    const { coordinator, enabled, loaders } = fixture();
    await coordinator.boot();
    enabled.get('a')?.add(INVOICE);
    if (!db.transaction) throw new Error('SQLite transaction support required');
    let failed = false;
    const wrap = (tx: DatabaseInterface): DatabaseInterface => {
      const wrapped = Object.create(tx) as DatabaseInterface;
      wrapped.query = async (...args: Parameters<typeof db.query>) => {
        if (!failed && /CREATE TABLE.*activation_invoices/s.test(args[0])) {
          failed = true;
          throw new Error('Injected DDL failure');
        }
        return tx.query(...args);
      };
      if (tx.transaction)
        wrapped.transaction = (callback) =>
          tx.transaction!((nested) => callback(wrap(nested)));
      return wrapped;
    };
    if (engine === 'postgres' && db.beginTransaction) {
      const begin = db.beginTransaction.bind(db);
      vi.spyOn(db, 'beginTransaction').mockImplementation(
        async () =>
          wrap(await begin()) as Awaited<
            ReturnType<NonNullable<typeof db.beginTransaction>>
          >,
      );
    } else {
      const transaction = db.transaction.bind(db);
      vi.spyOn(db, 'transaction').mockImplementation((callback) =>
        transaction((tx) => callback(wrap(tx))),
      );
    }
    await expect(coordinator.activate([INVOICE])).rejects.toThrow(
      'Injected DDL failure',
    );
    expect(failed).toBe(true);
    expect(await applicationTables()).toEqual(['activation_host']);
    expect(
      isRuntimeModelEnabled(INVOICE, { surface: 'rest', tenantId: 'a' }),
    ).toBe(false);
    await coordinator.activate([INVOICE]);
    expect(
      isRuntimeModelEnabled(INVOICE, { surface: 'rest', tenantId: 'a' }),
    ).toBe(true);
    expect(loaders[INVOICE]).toHaveBeenCalledOnce();
    expect(await applicationTables()).toHaveLength(4);
  });

  it('recovers persisted enablement on a new coordinator, reconciles existing tables and retains rows', async () => {
    const { coordinator, options, enabled } = fixture();
    await coordinator.boot();
    await coordinator.activate([INVOICE]);
    enabled.get('b')?.add(INVOICE);
    await db.query(
      `INSERT INTO activation_invoices (id, slug, context, title) VALUES ('${SAVED}', 'saved', '', 'retained')`,
    );
    if (engine === 'postgres')
      await db.query(
        'ALTER TABLE activation_host ALTER COLUMN visits TYPE INTEGER',
      );
    ObjectRegistry.clear(); // a fresh process's registry
    const restarted = createActivationCoordinator({
      ...options,
      scope: `${options.scope}-restart`,
    });
    await restarted.boot();
    expect(restarted.isReady(INVOICE)).toBe(true);
    expect(await applicationTables()).toHaveLength(4);
    if (engine === 'postgres')
      expect(
        (await inspectTableSchema(db, 'activation_host', engine))?.columns
          .visits.type,
      ).toBe('integer');
    expect(
      (
        await db.query(
          `SELECT title FROM activation_invoices WHERE id = '${SAVED}'`,
        )
      ).rows[0].title,
    ).toBe('retained');
  });

  it('refuses unsupported engines before importing or migrating and rejects bad graph edges', () => {
    const { options, graph, loaders } = fixture();
    expect(() =>
      createActivationCoordinator({
        ...options,
        db: { url: 'duckdb://example' } as DatabaseInterface,
      }),
    ).toThrow(/SQLite and PostgreSQL only.*eager/);
    expect(() => activationClosure(graph, ['@unknown/pkg:Missing'])).toThrow(
      /Unknown activation model/,
    );
    expect(() =>
      createActivationCoordinator({ ...options, loaders: {} }),
    ).toThrow(/Missing activation loader/);
    expect(loaders[HOST]).not.toHaveBeenCalled();
  });

  it('keeps a failed persisted-state read closed and recovers on the next boot', async () => {
    const { options } = fixture();
    let readable = false;
    const coordinator = createActivationCoordinator({
      ...options,
      scope: `${options.scope}-read-failure`,
      readEnabled: async () => {
        if (!readable) throw new Error('Cookbook store unavailable');
        return [UNUSED];
      },
    });
    await expect(coordinator.boot()).rejects.toThrow(
      'Cookbook store unavailable',
    );
    expect(coordinator.isReady(UNUSED)).toBe(false);
    expect(await applicationTables()).toEqual([]);
    readable = true;
    await coordinator.boot();
    expect(coordinator.isReady(UNUSED)).toBe(true);
  });

  it('refuses undeclared registration side effects on every retry without migrating them', async () => {
    const { options, loaders } = fixture();
    const coordinator = createActivationCoordinator({
      ...options,
      scope: `${options.scope}-undeclared`,
      loaders: {
        ...loaders,
        [UNUSED]: async () => {
          class Surprise extends SmrtObject {}
          ObjectRegistry.register(Surprise, {
            packageName: '@activation/surprise',
            tableName: 'activation_surprise',
          });
          await loaders[UNUSED]();
        },
      },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(coordinator.activate([UNUSED])).rejects.toThrow(
        /undeclared model.*Surprise/,
      );
      expect(coordinator.isReady(UNUSED)).toBe(false);
      expect(await applicationTables()).toEqual([]);
    }
  });

  it('keeps eager non-opt-in migration behavior and adds an explicit table subset only when requested', async () => {
    const { loaders } = fixture();
    await loaders[HOST]();
    await loaders[UNUSED]();
    await migrateSmrtSchemas({
      db,
      packageName: '@activation/app',
      engineHint: engine,
      name: 'subset',
      tables: ['activation_host'],
    });
    expect(await applicationTables()).toEqual(['activation_host']);
    await migrateSmrtSchemas({
      db,
      packageName: '@activation/app',
      engineHint: engine,
      name: 'eager',
    });
    expect(await applicationTables()).toEqual([
      'activation_host',
      'activation_unused',
    ]);
    setRuntimeExposureGate(undefined);
    expect(isRuntimeModelEnabled(UNUSED, { surface: 'rest' })).toBe(true);
  });
});
