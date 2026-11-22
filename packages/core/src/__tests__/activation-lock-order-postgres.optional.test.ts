/**
 * Lazy activation and the app model editor as migrate runs on real
 * PostgreSQL (#5435): they wait at the migration key holding no transaction,
 * plan against what committed while they waited, finish on a pool of one,
 * honour their deadline, refuse a holder's call back into them, and keep
 * table ownership between an installed model and a run-time list.
 *
 * In-process variants: the plan's child-process schedules (A2's editor, A35)
 * are run here with both actors in one process; where the activation queue
 * then serializes them, the case says so.
 */
import type { Cookbook } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../../../tenancy/src/context.js';
import {
  disableTenancy,
  enableTenancy,
} from '../../../tenancy/src/interceptor.js';
import { buildActivationManifest } from '../activation/generate.js';
import { createActivationCoordinator } from '../activation.js';
import { createAppModelEditor } from '../cookbook/model-editor.js';
import { COOKBOOK_SCHEMA_URL } from '../cookbook/validate.js';
import {
  createPgSuite,
  gate,
  holdKey,
  type PgSuite,
  pgUrl,
  until,
} from '../migrations/__tests__/pg-lock-harness.js';
import {
  MigrationLockOrderError,
  MigrationLockTimeoutError,
  withMigrationLock,
} from '../migrations/migration-lock.js';
import { migrateSmrtSchemas } from '../migrations/orchestrate.js';
import { SmrtObject } from '../object.js';
import { manifestEntry } from '../registry/__tests__/helpers/consumer-workspace.js';
import { ObjectRegistry } from '../registry.js';
import { runtimeListTableName } from '../runtime-list-table.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

const PKG = '@po/fixture';
const MODEL = `${PKG}:PoThing`;
const TABLE = 'po_things';
const TENANT = '55555555-5555-4555-8555-555555555555';
/** A list whose run-time table is the model's table. */
const SAME_TABLE_LIST = 'PoThings';

function activationFixture(
  db: DatabaseInterface,
  extra: Record<string, unknown> = {},
) {
  const entry = manifestEntry({
    className: 'PoThing',
    packageName: PKG,
    filePath: '/po/PoThing.ts',
    tableName: TABLE,
    fields: {},
  });
  entry.schema!.columns = {
    id: { type: 'UUID', primaryKey: true },
    title: { type: 'TEXT' },
    visits: { type: 'INTEGER' },
  };
  entry.fields = { title: { type: 'text' }, visits: { type: 'integer' } };
  entry.decoratorConfig = { tableName: TABLE, api: { public: true } };
  const manifest: SmartObjectManifest = {
    version: '1',
    timestamp: 0,
    packageName: PKG,
    objects: { [MODEL]: entry },
  };
  const graph = buildActivationManifest(manifest, {
    [MODEL]: { specifier: MODEL, models: [MODEL], dependencies: [] },
  } as never);
  const loader = vi.fn(async () => {
    const Class = { PoThing: class extends SmrtObject {} }.PoThing;
    ObjectRegistry.register(Class, {
      ...entry.decoratorConfig,
      name: 'PoThing',
      packageName: PKG,
      _manifest: { ...manifest, objects: { [MODEL]: entry } },
      _manifestKey: MODEL,
    } as never);
  });
  const coordinator = createActivationCoordinator({
    scope: `po-${Math.random().toString(36).slice(2)}`,
    db,
    packageName: '@po/app',
    manifest: graph,
    loaders: { [MODEL]: loader },
    readEnabled: async () => [],
    ...extra,
  } as never);
  return { coordinator, loader };
}

const book = (): Cookbook => ({
  $schema: COOKBOOK_SCHEMA_URL,
  version: 1,
  recipes: [],
  features: [],
  policies: [],
});
const editorFor = (db: DatabaseInterface) =>
  createAppModelEditor({
    db,
    application: 'po-editor',
    tenantId: TENANT,
    packageName: '@po/app',
    cookbook: book(),
    catalog: { recipes: [], models: [] } as never,
    authorize: () => true,
  });
const createList = (
  editor: Awaited<ReturnType<typeof editorFor>>,
  name: string,
) =>
  withTenant({ tenantId: TENANT }, () =>
    editor.apply(
      {
        type: 'create_list',
        name,
        list: {
          label: name,
          icon: 'list',
          displayField: 'title',
          fields: { title: { type: 'text' } },
        },
      } as never,
      {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: editor.snapshot().revision,
        requestId: `req-${crypto.randomUUID()}`,
      },
    ),
  );

describe.skipIf(!pgUrl)('activation and the editor as migrate runs', () => {
  let suite: PgSuite;
  let restore: () => void;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    enableTenancy();
    suite = await createPgSuite('smrt_po');
  });
  afterEach(async () => {
    disableTenancy();
    await suite?.close();
    restore();
  });

  it('activation and then an editor boot finish on a pool of one (A7, A36)', async () => {
    const one = await suite.pool({ max: 1 });
    const { coordinator } = activationFixture(one);
    await coordinator.activate([MODEL]);
    expect(coordinator.isReady(MODEL)).toBe(true);
    const editor = await editorFor(one);
    await createList(editor, 'PoNotes');
    expect(editor.snapshot().revision).toBe(1);
  }, 60_000);

  it('an activation and a whole-schema run both wait at an old-release holder, issue no DDL, then finish (A2, in-process)', async () => {
    const holderPool = await suite.pool();
    const activationPool = await suite.pool();
    const runPool = await suite.pool();
    const holder = await holdKey(holderPool);
    const { coordinator } = activationFixture(activationPool);
    const activation = coordinator.activate([MODEL]);
    const run = migrateSmrtSchemas({
      db: runPool,
      packageName: '@po/app',
      engineHint: 'postgres',
    });
    await until(
      async () => (await suite.running(/pg_try_advisory_lock/)).length >= 2,
      15_000,
      'both runs to poll the key',
    );
    expect(
      (
        await suite.sql(
          `SELECT 1 FROM information_schema.tables WHERE table_name = '${TABLE}'`,
        )
      ).length,
    ).toBe(0);
    await holder.release();
    await activation;
    await run;
    expect(coordinator.isReady(MODEL)).toBe(true);
  }, 60_000);

  it('an activation that waited under a repeatable read role default plans against a column committed meanwhile (A18)', async () => {
    await suite.sql(
      `ALTER DATABASE ${suite.name} SET default_transaction_isolation = 'repeatable read'`,
    );
    const pool = await suite.pool();
    const other = await suite.pool();
    await other.query(
      `CREATE TABLE ${TABLE} (id uuid PRIMARY KEY, title text)`,
    );
    const holder = await holdKey(other);
    const { coordinator } = activationFixture(pool);
    const activation = coordinator.activate([MODEL]);
    await until(
      async () => (await suite.running(/pg_try_advisory_lock/)).length > 0,
    );
    await other.query(`ALTER TABLE ${TABLE} ADD COLUMN visits integer`);
    await holder.release();
    await expect(activation).resolves.toBeUndefined();
  }, 60_000);

  it('honours migrationLockTimeout while another run holds the key, and in the checkout of a pool of one (A42, A60)', async () => {
    const holder = await holdKey(await suite.pool());
    const pool = await suite.pool();
    const started = Date.now();
    const { coordinator } = activationFixture(pool, {
      migrationLockTimeout: 400,
    });
    const failure = await coordinator
      .activate([MODEL])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationLockTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    await holder.release();

    const one = await suite.pool({ max: 1 });
    const slot = await one.acquireSession!();
    try {
      const { coordinator: blocked } = activationFixture(one, {
        migrationLockTimeout: 300,
      });
      const checkout = await blocked
        .activate([MODEL])
        .catch((error: unknown) => error);
      expect(checkout).toBeInstanceOf(MigrationLockTimeoutError);
      expect((checkout as MigrationLockTimeoutError).phase).toBe('checkout');
    } finally {
      await slot.release();
    }
  }, 60_000);

  it('refuses a holder joining a pending activation, which then finishes after the holder (A34, A55)', async () => {
    const pool = await suite.pool();
    const holderPool = await suite.pool();
    const { coordinator } = activationFixture(pool, {
      migrationLockTimeout: 0,
    });
    const hold = gate();
    const holder = withMigrationLock(holderPool, async () => {
      await until(
        async () => (await suite.running(/pg_try_advisory_lock/)).length > 0,
      );
      expect(() => coordinator.activate([MODEL])).toThrow(
        MigrationLockOrderError,
      );
      await hold.promise;
    });
    await until(async () => (await suite.holderPid()) !== undefined);
    const pending = coordinator.activate([MODEL]);
    setTimeout(() => hold.open(), 300);
    await holder;
    await pending;
    expect(coordinator.isReady(MODEL)).toBe(true);
  }, 60_000);

  it('a holder building an index concurrently finishes while an activation waits, and neither gets a deadlock (A50)', async () => {
    const holderPool = await suite.pool();
    const pool = await suite.pool();
    const { coordinator } = activationFixture(pool);
    const hold = gate();
    const holder = withMigrationLock(holderPool, async (lock) => {
      await hold.promise;
      await lock.db.query(
        `CREATE TABLE po_index_target (id int PRIMARY KEY, a int)`,
      );
      await lock.db.query(
        'CREATE INDEX CONCURRENTLY po_index_target_a ON po_index_target (a)',
      );
    });
    await until(async () => (await suite.holderPid()) !== undefined);
    const activation = coordinator.activate([MODEL]);
    await until(
      async () => (await suite.running(/pg_try_advisory_lock/)).length > 0,
    );
    hold.open();
    await expect(holder).resolves.toBeUndefined();
    await expect(activation).resolves.toBeUndefined();
    const [index] = await suite.sql(
      "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'po_index_target_a'",
    );
    expect(index.indisvalid).toBe(true);
  }, 60_000);

  it('refuses activation of a model whose table a committed list owns, before any loader, and a whole-schema run leaves it alone (A66)', async () => {
    const pool = await suite.pool();
    expect(runtimeListTableName(SAME_TABLE_LIST)).toBe(TABLE);
    const editor = await editorFor(pool);
    await createList(editor, SAME_TABLE_LIST);
    const before = new Set(ObjectRegistry.getAllClasses().keys());
    // A fresh process stand-in: no run-time registration of the list here.
    const restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    try {
      const other = await suite.pool();
      const { coordinator, loader } = activationFixture(other);
      await expect(coordinator.activate([MODEL])).rejects.toThrow(
        /already used by the run-time model/,
      );
      expect(loader).not.toHaveBeenCalled();
      expect(ObjectRegistry.getClass(MODEL)).toBeUndefined();
      const columns = async () =>
        (
          await suite.sql(
            `SELECT column_name FROM information_schema.columns WHERE table_name = '${TABLE}' ORDER BY column_name`,
          )
        ).map((row) => String(row.column_name));
      const shape = await columns();
      await migrateSmrtSchemas({
        db: other,
        packageName: '@po/app',
        engineHint: 'postgres',
      });
      expect(await columns()).toEqual(shape);
    } finally {
      restoreRegistry();
    }
    expect(before.size).toBeGreaterThan(0);
  }, 60_000);

  it('with an application schema first in search_path, activation still refuses a table a list in public owns (A61, activation half)', async () => {
    const pool = await suite.pool();
    const editor = await editorFor(pool);
    await createList(editor, SAME_TABLE_LIST);
    await suite.sql('CREATE SCHEMA app');
    await suite.sql(`GRANT USAGE, CREATE ON SCHEMA app TO PUBLIC`);
    await suite.sql(
      `ALTER DATABASE ${suite.name} SET search_path = app, public`,
    );
    const restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    try {
      const fresh = await suite.pool();
      const { coordinator, loader } = activationFixture(fresh);
      await expect(coordinator.activate([MODEL])).rejects.toThrow(
        /already used by the run-time model/,
      );
      expect(loader).not.toHaveBeenCalled();
    } finally {
      restoreRegistry();
    }
  }, 60_000);

  it('an edit for a table an activation is loading waits, and the table never gets both owners (A35, in-process)', async () => {
    const pool = await suite.pool();
    const pause = gate();
    const atLoader = gate();
    const { coordinator, loader } = activationFixture(pool);
    loader.mockImplementationOnce(async () => {
      atLoader.open();
      await pause.promise;
      throw new Error('stop at the loader');
    });
    const editor = await editorFor(pool);
    const activation = coordinator.activate([MODEL]).catch(() => 'refused');
    await atLoader.promise;
    let editSettled = false;
    const edit = createList(editor, SAME_TABLE_LIST)
      .then(() => 'committed')
      .catch(() => 'refused')
      .finally(() => {
        editSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(editSettled).toBe(false);
    expect(
      await suite.sql(
        'SELECT 1 FROM public._smrt_app_model_changes WHERE revision > 0',
      ),
    ).toHaveLength(0);
    pause.open();
    await activation;
    expect(await edit).toBe('committed');
    expect(coordinator.isReady(MODEL)).toBe(false);
  }, 60_000);
});
