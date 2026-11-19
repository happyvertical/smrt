/** App model editor guards: installed-model identity, scoped reconciliation, history bounds. */

import type { Cookbook } from '@happyvertical/smrt-types';
import type { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../../../tenancy/src/context.js';
import {
  disableTenancy,
  enableTenancy,
} from '../../../tenancy/src/interceptor.js';
import {
  type ActivationManifest,
  createActivationCoordinator,
} from '../activation.js';
import { planAppEdit } from '../cookbook/app-tool-edits.js';
import { createCookbookEngine } from '../cookbook/engine/engine.js';
import {
  type AppModelEdit,
  type AppModelEditorOptions,
  type AppModelEditReceipt,
  type AppModelSnapshot,
  createAppModelEditor,
  migrateAppModelStorage,
} from '../cookbook/model-editor.js';
import {
  type AppModelHistoryStore,
  abandonAppModelRevision,
  createAppModelHistory,
} from '../cookbook/model-history.js';
import { journalReader } from '../cookbook/model-history-readers.js';
import { fitsStorageIdentifier, storageColumns } from '../cookbook/models.js';
import { COOKBOOK_SCHEMA_URL } from '../cookbook/validate.js';
import { field } from '../decorators/index.js';
import { APIGenerator } from '../generators/rest.js';
import { migrateSmrtSchemas } from '../migrations/orchestrate.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import {
  getRuntimeModelReadiness,
  hasRuntimeExposureGate,
  isRuntimeModelEnabled,
  setRuntimeExposureGate,
  setRuntimeModelOwner,
} from '../runtime-exposure.js';
import { runtimeListTableName } from '../runtime-list-table.js';
import { registerRuntimeModel } from '../runtime-model.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import { toSnakeCase } from '../utils/naming.js';

const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
const engine = databaseType === 'pglite' ? 'postgres' : 'sqlite';

const APP = '@fixture/editor-guards-app';
const LEDGER_PKG = '@fixture/editor-guards-ledger';
const LEDGER = `${LEDGER_PKG}:GuardLedger`;
const LEDGER_TABLE = 'guard_ledgers';
const TENANT = '33333333-3333-4333-8333-333333333333';

const book = (): Cookbook => ({
  $schema: COOKBOOK_SCHEMA_URL,
  version: 1,
  recipes: [],
  features: [],
  policies: [],
});
const catalog = {
  recipes: [
    {
      id: 'guards.ledger',
      label: 'Ledger',
      models: [LEDGER],
      nav: [],
      requires: [],
    },
  ],
  models: [
    {
      id: LEDGER,
      name: 'GuardLedger',
      packageId: 'editor-guards-ledger',
      exposed: true,
      fields: [{ name: 'title' }],
    },
  ],
};
const loadLedger = async () => {
  if (ObjectRegistry.getClass(LEDGER)) return;
  class GuardLedger extends SmrtObject {
    title = '';
  }
  field({ type: 'text' })(GuardLedger.prototype, 'title');
  ObjectRegistry.register(GuardLedger, {
    packageName: LEDGER_PKG,
    tableName: LEDGER_TABLE,
    tenantScoped: true,
    api: true,
    mcp: true,
  });
};
/** A list whose derived table is exactly the ledger's table. */
const SAME_TABLE_LIST = 'GuardLedgers';
const listDefinition = {
  label: 'Ledgers',
  icon: 'receipt',
  displayField: 'title',
  fields: { title: { type: 'text' }, note: { type: 'text' } },
} as const;

describe('app model editor: installed model names and tables', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    enableTenancy();
  });
  afterEach(async () => {
    setRuntimeExposureGate(undefined);
    globalThis.__smrtModelReadiness?.clear();
    disableTenancy();
    await db.close?.();
    restore();
  });
  const editorOptions = (
    extra: Partial<AppModelEditorOptions> = {},
  ): AppModelEditorOptions => ({
    db,
    application: 'editor-guards',
    tenantId: TENANT,
    packageName: APP,
    cookbook: book(),
    catalog,
    authorize: (c) => c.actor === 'owner',
    ...extra,
  });
  const editorFor = (extra: Partial<AppModelEditorOptions> = {}) =>
    createAppModelEditor({
      db,
      application: 'editor-guards',
      tenantId: TENANT,
      packageName: APP,
      cookbook: book(),
      catalog,
      authorize: (c) => c.actor === 'owner',
      ...extra,
    });
  const applier =
    (e: Awaited<ReturnType<typeof editorFor>>) => (value: AppModelEdit) =>
      e.apply(value, {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: e.snapshot().revision,
        requestId: `req-${crypto.randomUUID()}`,
      });
  const e2eColumns = async (table: string) =>
    (
      await db.query(
        engine === 'postgres'
          ? `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}'`
          : `PRAGMA table_info(${table})`,
      )
    ).rows.map((row) => String(row.name));
  const tableNames = async () =>
    (
      await db.query(
        engine === 'postgres'
          ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'guard_%'"
          : "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'guard_%'",
      )
    ).rows.map((row) => String(row.name));

  it('refuses a list named like an installed model that is not loaded, or on a loaded model table', async () => {
    expect(runtimeListTableName(SAME_TABLE_LIST)).toBe(LEDGER_TABLE);
    const e = await editorFor();
    const apply = applier(e);
    // The catalog names the installed model even while its recipe is off.
    expect(ObjectRegistry.getClass(LEDGER)).toBeUndefined();
    await expect(
      apply({ type: 'create_list', name: 'GuardLedger', list: listDefinition }),
    ).rejects.toThrow(
      /MODEL_NAME_COLLISION: GuardLedger is the name of the installed model/,
    );
    await loadLedger();
    await expect(
      apply({
        type: 'create_list',
        name: SAME_TABLE_LIST,
        list: listDefinition,
      }),
    ).rejects.toThrow(/MODEL_TABLE_COLLISION: guard_ledgers/);
    expect(await e.history()).toEqual([]);
    await apply({
      type: 'create_list',
      name: 'GuardNotes',
      list: listDefinition,
    });
    expect(await tableNames()).toContain('guard_notes');
  });

  it('refuses a list whose table the database keeps for a disabled model', async () => {
    // The recipe was on once: its table and a row stay after it is disabled.
    await loadLedger();
    await migrateSmrtSchemas({ db, packageName: APP, engineHint: engine });
    await db.query(
      `INSERT INTO ${LEDGER_TABLE} (id, slug, context, title, tenant_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'kept', '', 'kept row', '${TENANT}')`,
    );
    // Restart with the recipe off: the model is not loaded.
    ObjectRegistry.clear();
    const e = await editorFor();
    await expect(
      applier(e)({
        type: 'create_list',
        name: SAME_TABLE_LIST,
        list: listDefinition,
      }),
    ).rejects.toThrow(
      /MODEL_TABLE_COLLISION: guard_ledgers already exists in the database/,
    );
    const columns = (
      await db.query(
        engine === 'postgres'
          ? `SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${LEDGER_TABLE}'`
          : `PRAGMA table_info(${LEDGER_TABLE})`,
      )
    ).rows.map((row) => String(row.name));
    expect(columns).not.toContain('note');
    expect(await e.history()).toEqual([]);
  });

  it('keeps a journalled list editable when a model on its table is loaded beside it', async () => {
    const e = await editorFor();
    const apply = applier(e);
    await apply({
      type: 'create_list',
      name: SAME_TABLE_LIST,
      list: listDefinition,
    });
    // A model that shares the table loads later (state from before these checks).
    await loadLedger();
    await apply({
      type: 'relabel_list',
      name: SAME_TABLE_LIST,
      label: 'Books',
    });
    await apply({ type: 'remove_list', name: SAME_TABLE_LIST });
    expect(e.snapshot().revision).toBe(3);
  });

  it('journals an initial cookbook as a tracked revision and never adopts an installed model table on a fresh boot', async () => {
    const withList = (
      name: string,
      fields: Record<string, unknown> = listDefinition.fields,
    ): Cookbook => ({
      ...book(),
      features: [`${APP}:${name}`],
      models: {
        version: 1,
        packageName: APP,
        lists: {
          [name]: { ...structuredClone(listDefinition), fields } as never,
        },
        fields: {},
      },
    });
    // A disabled recipe's retained table, its model not loaded (lazy host).
    await loadLedger();
    await migrateSmrtSchemas({ db, packageName: APP, engineHint: engine });
    ObjectRegistry.clear();
    const lazy = {
      manifest: {
        version: 1 as const,
        modules: {
          ledger: { specifier: 'fixture', models: [LEDGER], dependencies: [] },
        },
        models: {
          [LEDGER]: {
            module: 'ledger',
            effective: LEDGER,
            table: LEDGER_TABLE,
            dependencies: [],
          },
        },
        tables: { [LEDGER_TABLE]: { owners: [LEDGER], dependencies: [] } },
      },
      activate: async () => {},
    };
    await expect(
      editorFor({ cookbook: withList(SAME_TABLE_LIST), activation: lazy }),
    ).rejects.toThrow(
      /MODEL_TABLE_COLLISION: guard_ledgers is the table of the installed model/,
    );
    // Eager host: the model is loaded.
    await loadLedger();
    await expect(
      editorFor({ cookbook: withList(SAME_TABLE_LIST) }),
    ).rejects.toThrow(
      /MODEL_TABLE_COLLISION: guard_ledgers is the table of the installed model/,
    );
    expect(await e2eColumns(LEDGER_TABLE)).not.toContain('note');
    ObjectRegistry.clear();

    // A free table: boot runs no DDL, so the list's table must first be
    // created by the operator's storage migration.
    await expect(
      editorFor({ cookbook: withList('GuardNotes') }),
    ).rejects.toThrow(
      /MODEL_MIGRATION_REQUIRED: storage does not match the app models \(missing guard_notes\)/,
    );
    expect(await tableNames()).not.toContain('guard_notes');
    ObjectRegistry.clear();
    const first = await migrateAppModelStorage(
      editorOptions({ cookbook: withList('GuardNotes') }),
    );
    expect(
      (await first.history()).map((row) => [
        row.revision,
        row.status,
        row.actor,
      ]),
    ).toEqual([[1, 'applied', 'system']]);
    ObjectRegistry.clear();
    const again = await editorFor({ cookbook: withList('GuardNotes') });
    expect(again.snapshot().revision).toBe(1);
    // Undoing revision 1 leaves no enabled list without a declaration.
    await applier(again)({ type: 'undo' });
    expect(again.snapshot().cookbook.features).not.toContain(
      `${APP}:GuardNotes`,
    );
    expect(again.snapshot().cookbook.models?.lists ?? {}).toEqual({});
  });

  it('still boots a startup cookbook whose own declarations predate the name checks', async () => {
    // Declarations that booted before this release: a list named like an
    // installed catalog model, a reserved field name and an over-long name.
    const startup: Cookbook = {
      ...book(),
      features: [`${APP}:GuardLedger`],
      models: {
        version: 1,
        packageName: APP,
        lists: {
          GuardLedger: {
            label: 'Ledgers',
            icon: 'receipt',
            displayField: 'title',
            fields: {
              title: { type: 'text' },
              metrics: { type: 'text' },
              // PostgreSQL would truncate it, so only SQLite booted it before.
              ...(engine === 'sqlite'
                ? {
                    nameOfThePersonWhoSignedOffOnTheLastFireInspectionHere: {
                      type: 'text' as const,
                    },
                  }
                : {}),
            },
          },
        },
        fields: {},
      },
    };
    // Its table exists from earlier boots; the operator migration journals it.
    await migrateAppModelStorage(editorOptions({ cookbook: startup }));
    ObjectRegistry.clear();
    const e = await editorFor({ cookbook: startup });
    expect(e.snapshot().revision).toBe(1);
    // New declarations are still checked.
    await expect(
      applier(e)({
        type: 'add_field',
        model: 'GuardLedger',
        name: 'usage',
        field: { type: 'text' },
      }),
    ).rejects.toThrow(/FIELD_NAME_RESERVED/);
  });

  it.skipIf(engine !== 'postgres')(
    'checks a new table again under the shared lock, so another journal claiming it first wins',
    async () => {
      const base = await createAppModelHistory({
        db,
        application: 'editor-guards',
        tenantId: TENANT,
      });
      let raced = false;
      const store: AppModelHistoryStore = {
        ...base,
        // Another process (another journal) creates the table after this
        // editor validated and before it takes the lock.
        transaction: async (work) => {
          if (!raced) {
            raced = true;
            await db.query(
              'CREATE TABLE guard_notes (id UUID PRIMARY KEY, title TEXT)',
            );
          }
          return base.transaction!(work);
        },
      };
      const e = await editorFor({ store });
      await expect(
        applier(e)({
          type: 'create_list',
          name: 'GuardNotes',
          list: listDefinition,
        }),
      ).rejects.toThrow(/MODEL_TABLE_COLLISION: guard_notes already exists/);
      expect(await e.history()).toEqual([]);
      expect(await e2eColumns('guard_notes')).toEqual(['id', 'title']);
    },
  );
});

const MEMBER_PKG = '@fixture/editor-guards-members';
const MEMBER = `${MEMBER_PKG}:GuardMember`;
const MEMBER_TABLE = 'guard_members';
const memberBook = (): Cookbook => ({ ...book(), features: [MEMBER] });
const memberCatalog = {
  recipes: [],
  models: [
    {
      id: MEMBER,
      name: 'GuardMember',
      packageId: 'editor-guards-members',
      exposed: true,
      fields: [{ name: 'name' }],
    },
  ],
};
const registerMember = (upgraded = false) => {
  class GuardMember extends SmrtObject {
    name = '';
    visits = 0;
  }
  field({ type: 'text' })(GuardMember.prototype, 'name');
  field({ type: 'integer' })(GuardMember.prototype, 'visits');
  if (upgraded) field({ type: 'text' })(GuardMember.prototype, 'loyaltyTier');
  ObjectRegistry.register(GuardMember, {
    packageName: MEMBER_PKG,
    tableName: MEMBER_TABLE,
    tenantScoped: true,
    api: true,
    mcp: true,
  });
};
const mats = {
  label: 'Loaner mats',
  icon: 'layers',
  displayField: 'size',
  fields: { size: { type: 'text' } },
} as const;

describe('app model editor: reconciliation scope and pending revisions', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    registerMember();
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
  const editorFor = (extra: Partial<AppModelEditorOptions> = {}) =>
    createAppModelEditor({
      db,
      application: 'editor-guards-scope',
      tenantId: TENANT,
      packageName: APP,
      cookbook: memberBook(),
      catalog: memberCatalog,
      authorize: (c) => c.actor === 'owner',
      ...extra,
    });
  const applier =
    (e: Awaited<ReturnType<typeof editorFor>>) =>
    (value: AppModelEdit, requestId = `req-${crypto.randomUUID()}`) =>
      e.apply(value, {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: e.snapshot().revision,
        requestId,
      });
  const columns = async (table: string) =>
    (
      await db.query(
        engine === 'postgres'
          ? `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}'`
          : `PRAGMA table_info(${table})`,
      )
    ).rows.map((row) => String(row.name));
  /** Out-of-band drift: `visits` stored as REAL while declared integer. */
  const driftVisits = async () => {
    if (engine === 'postgres')
      await db.query(
        `ALTER TABLE ${MEMBER_TABLE} ALTER COLUMN visits TYPE REAL`,
      );
    else {
      await db.query(`ALTER TABLE ${MEMBER_TABLE} DROP COLUMN visits`);
      await db.query(`ALTER TABLE ${MEMBER_TABLE} ADD COLUMN visits REAL`);
    }
  };
  const repairVisits = async () => {
    if (engine === 'postgres')
      await db.query(
        `ALTER TABLE ${MEMBER_TABLE} ALTER COLUMN visits TYPE BIGINT`,
      );
    else {
      await db.query(`ALTER TABLE ${MEMBER_TABLE} DROP COLUMN visits`);
      await db.query(`ALTER TABLE ${MEMBER_TABLE} ADD COLUMN visits INTEGER`);
    }
  };

  it('edits that change no storage of a drifted table apply; an edit of that table is refused without a pending revision', async () => {
    const e = await editorFor();
    const apply = applier(e);
    await apply({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    await driftVisits();

    // Label, list and policy edits of other models do not inspect the drifted table.
    await apply({ type: 'relabel_list', name: 'GuardMat', label: 'Mats' });
    await apply({
      type: 'add_field',
      model: 'GuardMat',
      name: 'colour',
      field: { type: 'text' },
    });
    await apply({
      type: 'label_field',
      model: MEMBER,
      name: 'vip',
      label: 'Very important',
    });
    expect(e.snapshot().revision).toBe(5);

    // A storage change on the drifted table is refused before the journal.
    await expect(
      apply({
        type: 'add_field',
        model: MEMBER,
        name: 'nickname',
        field: { type: 'text' },
      }),
    ).rejects.toThrow(/MODEL_MIGRATION_REQUIRED|Migrate stopped/);
    expect((await e.history()).map((row) => row.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    expect(await columns(MEMBER_TABLE)).not.toContain('nickname');
    expect(() => e.snapshot()).not.toThrow();
    await expect(
      ObjectRegistry.getAllFields(`${APP}:GuardMember`).then((fields) =>
        fields.has('nickname'),
      ),
    ).resolves.toBe(false);

    // After the operator repairs the drift the same editor edits that table again.
    await repairVisits();
    await apply({
      type: 'add_field',
      model: MEMBER,
      name: 'nickname',
      field: { type: 'text' },
    });
    expect(await columns(MEMBER_TABLE)).toContain('nickname');
  });
  it('a pending revision that cannot complete can be abandoned and is never replayed', async () => {
    let failPublish = false;
    const publish = () => {
      if (failPublish) throw new Error('host publication unavailable');
    };
    const e = await editorFor({ publish });
    const apply = applier(e);
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    failPublish = true;
    await expect(
      apply(
        {
          type: 'add_field',
          model: 'GuardMat',
          name: 'colour',
          field: { type: 'text' },
        },
        'req-stuck',
      ),
    ).rejects.toThrow(/host publication unavailable/);
    expect((await e.history()).at(-1)).toMatchObject({
      revision: 2,
      status: 'pending',
    });
    await expect(editorFor({ publish })).rejects.toThrow(
      /host publication unavailable.*abandonAppModelRevision\(\{ revision: 2 \}\)/,
    );

    await abandonAppModelRevision({
      db,
      application: 'editor-guards-scope',
      tenantId: TENANT,
      revision: 2,
      actor: 'operator',
      reason: 'publication target retired',
    });
    await expect(
      abandonAppModelRevision({
        db,
        application: 'editor-guards-scope',
        tenantId: TENANT,
        revision: 2,
        actor: 'operator',
      }),
    ).rejects.toThrow(/MODEL_ABANDON_NOT_PENDING/);
    failPublish = false;
    const reopened = await editorFor({ publish });
    expect(reopened.snapshot().revision).toBe(2);
    expect(
      reopened.snapshot().cookbook.models?.lists.GuardMat.fields,
    ).not.toHaveProperty('colour');
    expect((await reopened.history()).at(-1)).toMatchObject({
      revision: 2,
      status: 'applied',
      abandoned: true,
    });
    // A retry of the abandoned request is refused, not replayed as success.
    await expect(
      applier(reopened)(
        {
          type: 'add_field',
          model: 'GuardMat',
          name: 'colour',
          field: { type: 'text' },
        },
        'req-stuck',
      ),
    ).rejects.toThrow(/MODEL_REVISION_ABANDONED/);
    // Undo skips the abandoned revision and reverses the list creation.
    await applier(reopened)({ type: 'undo' });
    expect(reopened.snapshot().cookbook.features).not.toContain(
      `${APP}:GuardMat`,
    );
    expect((await reopened.history()).at(-1)?.undoes).toBe(1);
  });

  it('an abandoned pending undo reverses nothing: the next undo still targets the original edit', async () => {
    let failPublish = false;
    const publish = () => {
      if (failPublish) throw new Error('host publication unavailable');
    };
    const e = await editorFor({ publish });
    const apply = applier(e);
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    failPublish = true;
    await expect(apply({ type: 'undo' })).rejects.toThrow(
      /host publication unavailable/,
    );
    await abandonAppModelRevision({
      db,
      application: 'editor-guards-scope',
      tenantId: TENANT,
      revision: 2,
      actor: 'operator',
    });
    failPublish = false;
    const reopened = await editorFor({ publish });
    expect(reopened.snapshot().cookbook.features).toContain(`${APP}:GuardMat`);
    await applier(reopened)({ type: 'undo' });
    expect(reopened.snapshot().cookbook.features).not.toContain(
      `${APP}:GuardMat`,
    );
    expect((await reopened.history()).at(-1)?.undoes).toBe(1);
  });

  it('a completion that loses to an operator abandon is refused, not reported as committed', async () => {
    const base = await createAppModelHistory({
      db,
      application: 'editor-guards-scope',
      tenantId: TENANT,
    });
    const store: AppModelHistoryStore = {
      ...base,
      async complete(revision, elapsedMs, receipt, result) {
        if (revision === 2)
          await abandonAppModelRevision({
            db,
            application: 'editor-guards-scope',
            tenantId: TENANT,
            revision: 2,
            actor: 'operator',
          });
        return base.complete(revision, elapsedMs, receipt, result);
      },
    };
    const e = await editorFor({ store });
    const apply = applier(e);
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    await expect(
      apply({
        type: 'add_field',
        model: 'GuardMat',
        name: 'colour',
        field: { type: 'text' },
      }),
    ).rejects.toThrow(/MODEL_EDIT_CONFLICT: revision 2 was not completed/);
    expect(() => e.snapshot()).toThrow(/MODEL_ACTIVATION_PENDING/);
    ObjectRegistry.clear();
    registerMember();
    const reopened = await editorFor();
    expect(
      reopened.snapshot().cookbook.models?.lists.GuardMat.fields,
    ).not.toHaveProperty('colour');
  });

  it('boot of an applied journal runs no DDL and keeps a model with missing storage closed until the operator migrates', async () => {
    const e = await editorFor();
    await applier(e)({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    // A provider upgrade adds a field; the process restarts with it.
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    registerMember(true);
    await expect(editorFor()).rejects.toThrow(
      /MODEL_MIGRATION_REQUIRED: storage does not match the app models \(missing guard_members\.loyalty_tier\)/,
    );
    expect(await columns(MEMBER_TABLE)).not.toContain('loyalty_tier');
    expect(getRuntimeModelReadiness(MEMBER)).toBe(false);
    expect(getRuntimeModelReadiness(`${APP}:GuardMember`)).toBe(false);

    // The operator migration adds the column; the editor reopens and CRUD works.
    await migrateSmrtSchemas({
      db,
      packageName: APP,
      engineHint: engine,
      tables: [MEMBER_TABLE],
      name: 'operator_provider_upgrade',
    });
    const reopened = await editorFor();
    expect(getRuntimeModelReadiness(`${APP}:GuardMember`)).toBe(true);
    expect(reopened.snapshot().revision).toBe(1);
    const created = await withTenant({ tenantId: TENANT }, async () => {
      const members = await ObjectRegistry.getCollection(MEMBER, { db });
      const row = await members.create({
        name: 'Ada',
        vip: true,
        loyaltyTier: 'gold',
      } as never);
      return members.get((row as { id: string }).id);
    });
    expect(created).toMatchObject({ vip: true, loyaltyTier: 'gold' });
  });

  it('reopens with drift on a customised table that the boot no longer migrates', async () => {
    const e = await editorFor();
    await applier(e)({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    await driftVisits();
    ObjectRegistry.clear();
    registerMember();
    expect((await editorFor()).snapshot().revision).toBe(1);
  });

  const scopeOptions = (): AppModelEditorOptions => ({
    db,
    application: 'editor-guards-scope',
    tenantId: TENANT,
    packageName: APP,
    cookbook: memberBook(),
    catalog: memberCatalog,
    authorize: (c) => c.actor === 'owner',
  });

  it('boot runs no DDL for a pending storage edit; the operator storage migration applies it', async () => {
    const e = await editorFor();
    await applier(e)({ type: 'create_list', name: 'GuardMat', list: mats });
    // A pending revision whose DDL never ran (written, then the process died).
    const before = e.snapshot().cookbook;
    const after = structuredClone(before);
    after.models!.lists.GuardMat.fields.colour = { type: 'text' };
    const store = await createAppModelHistory({
      db,
      application: 'editor-guards-scope',
      tenantId: TENANT,
    });
    await store.append(
      {
        revision: 2,
        requestId: 'req-pending-ddl',
        actor: 'owner',
        command: JSON.stringify({
          type: 'add_field',
          model: 'GuardMat',
          name: 'colour',
          field: { type: 'text' },
        }),
        before,
        after,
        status: 'pending',
      },
      1,
    );
    ObjectRegistry.clear();
    registerMember();
    await expect(editorFor()).rejects.toThrow(
      /MODEL_MIGRATION_REQUIRED: storage does not match.*guard_mats\.colour/,
    );
    expect(await columns('guard_mats')).not.toContain('colour');
    ObjectRegistry.clear();
    registerMember();
    const repaired = await migrateAppModelStorage(scopeOptions());
    expect(await columns('guard_mats')).toContain('colour');
    expect((await repaired.history()).at(-1)).toMatchObject({
      revision: 2,
      status: 'applied',
    });
  });

  it('the operator storage migration recreates a lost custom column on a cold boot', async () => {
    const e = await editorFor();
    await applier(e)({ type: 'create_list', name: 'GuardMat', list: mats });
    await applier(e)({
      type: 'add_field',
      model: 'GuardMat',
      name: 'colour',
      field: { type: 'text' },
    });
    // A restored database lost the custom column.
    await db.query('ALTER TABLE guard_mats DROP COLUMN colour');
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    registerMember();
    await expect(editorFor()).rejects.toThrow(/missing guard_mats\.colour/);
    expect(getRuntimeModelReadiness(`${APP}:GuardMat`)).toBe(false);
    ObjectRegistry.clear();
    registerMember();
    const repaired = await migrateAppModelStorage(scopeOptions());
    expect(getRuntimeModelReadiness(`${APP}:GuardMat`)).toBe(true);
    const row = await withTenant({ tenantId: TENANT }, async () => {
      const list = await ObjectRegistry.getCollection(`${APP}:GuardMat`, {
        db,
      });
      const created = await list.create({ size: 'L', colour: 'red' } as never);
      return list.get((created as { id: string }).id);
    });
    expect(row).toMatchObject({ size: 'L', colour: 'red' });
    expect(repaired.snapshot().revision).toBe(2);
  });
});

/** identifier('Name Of The Person Who Signed Off On The Last Fire Inspection Here'): a 66-byte column. */
const LONG_FIELD = 'nameOfThePersonWhoSignedOffOnTheLastFireInspectionHere';
/** A 61-byte column whose money companion is 70 bytes. */
const LONG_MONEY = 'dateOfLastInspectionByTheFireMarshalForThisLocation';

describe('app model editor: storage identifier length', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    registerMember();
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
  const application = 'editor-guards-identifiers';
  const editorFor = () =>
    createAppModelEditor({
      db,
      application,
      tenantId: TENANT,
      packageName: APP,
      cookbook: memberBook(),
      catalog: memberCatalog,
      authorize: (c) => c.actor === 'owner',
    });
  const applier =
    (e: Awaited<ReturnType<typeof editorFor>>) => (value: AppModelEdit) =>
      e.apply(value, {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: e.snapshot().revision,
        requestId: `req-${crypto.randomUUID()}`,
      });

  it('refuses derived tables and columns over 63 bytes, money companions included', async () => {
    const e = await editorFor();
    const apply = applier(e);
    await expect(
      apply({
        type: 'add_field',
        model: MEMBER,
        name: LONG_FIELD,
        field: { type: 'text' },
      }),
    ).rejects.toThrow(
      /INVALID_MODEL_EDIT: .*name_of_the_person_who_signed_off_on_the_last_fire_inspection_here" \(66 bytes\); PostgreSQL allows 63/,
    );
    await expect(
      apply({
        type: 'add_field',
        model: MEMBER,
        name: LONG_MONEY,
        field: { type: 'money', currency: 'CAD' },
      }),
    ).rejects.toThrow(/INVALID_MODEL_EDIT: .*_currency" \(70 bytes\)/);
    await expect(
      apply({
        type: 'create_list',
        name: 'GuardAnExceptionallyLongListNameThatNoPostgresTableCouldEverHold',
        list: mats,
      }),
    ).rejects.toThrow(/INVALID_MODEL_EDIT: models\.lists\..* stores as table/);
    expect(await e.history()).toEqual([]);
    // The same 61-byte name is fine as a plain field.
    await apply({
      type: 'add_field',
      model: MEMBER,
      name: LONG_MONEY,
      field: { type: 'date' },
    });
  });

  it('the assistant derives names that fit from long labels', async () => {
    const e = await editorFor();
    const snapshot = e.snapshot();
    const field = planAppEdit(
      'app.addField',
      {
        list: MEMBER,
        label: 'Date Of Last Inspection By The Fire Marshal For This Location',
        kind: 'money',
        currency: 'CAD',
        expectedRevision: 0,
      },
      snapshot,
      memberCatalog,
    );
    const name = (field.edit as { name: string }).name;
    expect(
      storageColumns(name, { type: 'money' }).every(fitsStorageIdentifier),
    ).toBe(true);
    await applier(e)(field.edit);
    const list = planAppEdit(
      'app.addList',
      {
        label:
          'Equipment Loaned Out To Members During The Winter Season Every Year',
        nameField: 'Item',
        fields: [{ label: 'Item', kind: 'text' }],
        expectedRevision: 1,
      },
      e.snapshot(),
      memberCatalog,
    );
    const listName = (list.edit as { name: string }).name;
    expect(fitsStorageIdentifier(runtimeListTableName(listName))).toBe(true);
    await applier(e)(list.edit);
  });

  it('an editor holding an over-long declaration from before the check still opens and edits other models', async () => {
    const e = await editorFor();
    await applier(e)({ type: 'create_list', name: 'GuardMat', list: mats });
    // Journal the over-long field the way an unchecked editor did.
    const before = e.snapshot().cookbook;
    const after = structuredClone(before);
    after.models!.fields[MEMBER] = { [LONG_FIELD]: { type: 'text' } };
    const store = await createAppModelHistory({
      db,
      application,
      tenantId: TENANT,
    });
    await store.append(
      {
        revision: 2,
        requestId: 'req-before-check',
        actor: 'owner',
        command: JSON.stringify({
          type: 'add_field',
          model: MEMBER,
          name: LONG_FIELD,
          field: { type: 'text' },
        }),
        before,
        after,
        status: 'pending',
      },
      1,
    );
    // PostgreSQL stores the column truncated to 63 bytes.
    await db.query(
      `ALTER TABLE ${MEMBER_TABLE} ADD COLUMN ${toSnakeCase(LONG_FIELD)} TEXT`,
    );
    await store.complete(2, 0);

    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    registerMember();
    const reopened = await editorFor();
    expect(reopened.snapshot().revision).toBe(2);
    const apply = applier(reopened);
    await apply({ type: 'relabel_list', name: 'GuardMat', label: 'Mats' });
    await apply({
      type: 'add_field',
      model: 'GuardMat',
      name: 'colour',
      field: { type: 'text' },
    });
    await apply({
      type: 'label_field',
      model: MEMBER,
      name: LONG_FIELD,
      label: 'Signed off by',
    });
    const addToSameModel = apply({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    if (engine === 'postgres')
      await expect(addToSameModel).rejects.toThrow(
        /MODEL_MIGRATION_REQUIRED: guard_members\.name_of_the_person.* cannot take new fields/,
      );
    else await addToSameModel;
    expect(
      (await reopened.history()).every((row) => row.status === 'applied'),
    ).toBe(true);
  });
});

describe('app model editor: reserved field names', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    registerMember();
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
  const editorFor = () =>
    createAppModelEditor({
      db,
      application: 'editor-guards-reserved',
      tenantId: TENANT,
      packageName: APP,
      cookbook: memberBook(),
      catalog: memberCatalog,
      authorize: (c) => c.actor === 'owner',
    });
  const applier =
    (e: Awaited<ReturnType<typeof editorFor>>) => (value: AppModelEdit) =>
      e.apply(value, {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: e.snapshot().revision,
        requestId: `req-${crypto.randomUUID()}`,
      });

  it('refuses constructor options and instance members as custom field names', async () => {
    const e = await editorFor();
    const apply = applier(e);
    for (const name of ['options', 'db', 'ai', 'signals', 'persistence'])
      await expect(
        apply({
          type: 'add_field',
          model: MEMBER,
          name,
          field: { type: 'choice', choices: ['red', 'blue'] },
        }),
        name,
      ).rejects.toThrow(/FIELD_NAME_RESERVED/);
    await expect(
      apply({
        type: 'create_list',
        name: 'GuardMat',
        list: {
          ...mats,
          fields: { ...mats.fields, options: { type: 'text' } },
        },
      }),
    ).rejects.toThrow(/FIELD_NAME_RESERVED: options/);
    // Prototype members stay refused, and ordinary names still work.
    await expect(
      apply({
        type: 'add_field',
        model: MEMBER,
        name: 'loadRelated',
        field: { type: 'text' },
      }),
    ).rejects.toThrow(/FIELD_NAME_RESERVED/);
    await apply({
      type: 'add_field',
      model: MEMBER,
      name: 'optionsNote',
      field: { type: 'text' },
    });
    expect(await e.history()).toHaveLength(1);
  });

  it('the assistant derives a safe name from a reserved label', async () => {
    const e = await editorFor();
    const planned = planAppEdit(
      'app.addField',
      {
        list: MEMBER,
        label: 'Options',
        kind: 'choice',
        options: ['red', 'blue'],
        expectedRevision: 0,
      },
      e.snapshot(),
      memberCatalog,
    );
    expect((planned.edit as { name: string }).name).toBe('customOptions');
    await applier(e)(planned.edit);
  });
});

describe('app model editor: one customised registry per process', () => {
  const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    registerMember();
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
  const editorFor = (tenantId: string, application = 'editor-guards-slot') =>
    createAppModelEditor({
      db,
      application,
      tenantId,
      packageName: APP,
      cookbook: memberBook(),
      catalog: memberCatalog,
      authorize: (c) => c.actor === 'owner',
    });
  const applier =
    (e: Awaited<ReturnType<typeof editorFor>>, tenantId: string) =>
    (value: AppModelEdit) =>
      e.apply(value, {
        actor: 'owner',
        tenantId,
        expectedRevision: e.snapshot().revision,
        requestId: `req-${crypto.randomUUID()}`,
      });

  it('refuses a second tenant editor once the first has customised the registry', async () => {
    const first = await editorFor(TENANT);
    await applier(
      first,
      TENANT,
    )({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    await expect(editorFor(OTHER_TENANT)).rejects.toThrow(
      /MODEL_EDIT_CONFLICT: this process already holds/,
    );
    await expect(editorFor(TENANT, 'editor-guards-other-app')).rejects.toThrow(
      /MODEL_EDIT_CONFLICT: this process already holds/,
    );
    // The same journal reopens, and the first editor keeps working.
    expect((await editorFor(TENANT)).snapshot().revision).toBe(1);
    await applier(
      first,
      TENANT,
    )({
      type: 'create_list',
      name: 'GuardMat',
      list: mats,
    });
    const fields = await ObjectRegistry.getAllFields(`${APP}:GuardMember`);
    expect([...fields.keys()]).toContain('vip');
  });

  it('refuses the later edit when two uncustomised editors were opened first', async () => {
    const first = await editorFor(TENANT);
    const second = await editorFor(OTHER_TENANT);
    await applier(
      second,
      OTHER_TENANT,
    )({
      type: 'add_field',
      model: MEMBER,
      name: 'loyalty',
      field: { type: 'text' },
    });
    await expect(
      first.apply(
        {
          type: 'add_field',
          model: MEMBER,
          name: 'vip',
          field: { type: 'boolean' },
        },
        {
          actor: 'owner',
          tenantId: TENANT,
          expectedRevision: 0,
          requestId: 'req-later',
        },
      ),
    ).rejects.toThrow(/MODEL_EDIT_CONFLICT: this process already holds/);
    const fields = await ObjectRegistry.getAllFields(`${APP}:GuardMember`);
    expect([...fields.keys()]).not.toContain('vip');
    expect(await first.history()).toEqual([]);
  });

  it('refuses one of two populated journals constructed at the same time', async () => {
    const populate = async (tenantId: string, name: string) => {
      const e = await editorFor(tenantId);
      await applier(
        e,
        tenantId,
      )({
        type: 'add_field',
        model: MEMBER,
        name,
        field: { type: 'text' },
      });
      // A process restart: a fresh registry.
      ObjectRegistry.clear();
      globalThis.__smrtModelReadiness?.clear();
      registerMember();
    };
    await populate(TENANT, 'vip');
    await populate(OTHER_TENANT, 'loyalty');
    const results = await Promise.allSettled([
      editorFor(TENANT),
      editorFor(OTHER_TENANT),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const refused = results.find((result) => result.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    expect(String(refused?.reason)).toMatch(
      /MODEL_EDIT_CONFLICT: this process already holds/,
    );
    const fields = [
      ...(await ObjectRegistry.getAllFields(`${APP}:GuardMember`)).keys(),
    ];
    // Exactly one journal's field is registered, never both.
    expect(fields.includes('vip') !== fields.includes('loyalty')).toBe(true);
  });

  it('a pre-opened editor never projects another journal customisation', async () => {
    const first = await editorFor(TENANT);
    const second = await editorFor(OTHER_TENANT);
    await applier(
      second,
      OTHER_TENANT,
    )({
      type: 'add_field',
      model: MEMBER,
      name: 'loyalty',
      field: { type: 'text' },
    });
    expect(() => first.snapshot()).toThrow(
      /MODEL_EDIT_CONFLICT: this process already holds/,
    );
    expect(() => second.snapshot()).not.toThrow();
  });

  it('serves a customised provider over REST only to the tenant whose journal owns it', async () => {
    await editorFor(TENANT);
    const second = await editorFor(OTHER_TENANT);
    await applier(
      second,
      OTHER_TENANT,
    )({
      type: 'add_field',
      model: MEMBER,
      name: 'loyalty',
      field: { type: 'text' },
    });
    const get = (tenantId: string) => {
      const handler = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req) => req },
        { db, tenantId },
      ).generateHandler();
      return withTenant({ tenantId }, () =>
        handler(new Request('http://fixture/api/guardmembers')),
      );
    };
    expect((await get(OTHER_TENANT)).status).toBe(200);
    expect((await get(TENANT)).status).toBe(404);
  });

  it('serves its own customised list to a generator built without a tenant', async () => {
    const e = await editorFor(TENANT);
    await applier(
      e,
      TENANT,
    )({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    // One generator for the host, tenancy resolved per request.
    const handler = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db },
    ).generateHandler();
    const response = await withTenant({ tenantId: TENANT }, () =>
      handler(new Request('http://fixture/api/guardmembers')),
    );
    expect(response.status).toBe(200);
  });

  it('denies a string-form ownership claim to another tenant and counts it as an exposure gate', async () => {
    globalThis.__smrtModelReadiness?.clear();
    globalThis.__smrtModelOwners?.clear();
    expect(hasRuntimeExposureGate()).toBe(false);
    setRuntimeModelOwner(['@fixture/claims:Thing'], TENANT);
    try {
      expect(hasRuntimeExposureGate()).toBe(true);
      // A registration entry carries its own constructor; the claim has none.
      class Thing {}
      const entry = {
        qualifiedName: '@fixture/claims:Thing',
        constructor: Thing,
      };
      expect(
        isRuntimeModelEnabled(entry, {
          surface: 'rest',
          tenantId: OTHER_TENANT,
        }),
      ).toBe(false);
      expect(
        isRuntimeModelEnabled(entry, { surface: 'rest', tenantId: TENANT }),
      ).toBe(true);
      // Pruning on a new editor never drops a claim made without a class.
      await editorFor(TENANT);
      expect(
        isRuntimeModelEnabled(entry, {
          surface: 'rest',
          tenantId: OTHER_TENANT,
        }),
      ).toBe(false);
    } finally {
      setRuntimeModelOwner(['@fixture/claims:Thing'], undefined);
    }
  });

  it('treats the same application and tenant on another database as another journal', async () => {
    const first = await editorFor(TENANT);
    await applier(
      first,
      TENANT,
    )({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    const other = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    try {
      await expect(
        createAppModelEditor({
          db: other,
          application: 'editor-guards-slot',
          tenantId: TENANT,
          packageName: APP,
          cookbook: memberBook(),
          catalog: memberCatalog,
          authorize: (c) => c.actor === 'owner',
        }),
      ).rejects.toThrow(/MODEL_EDIT_CONFLICT: this process already holds/);
    } finally {
      await other.close?.();
    }
  });

  it.skipIf(engine !== 'sqlite')(
    'reopens the same journal through a new handle to the same database',
    async () => {
      const file = `${process.env.TMPDIR ?? '/tmp'}/editor-guards-${crypto.randomUUID()}.sqlite`;
      const handle = () =>
        getTestDatabase({
          type: 'sqlite',
          url: file,
          classes: [],
          includeSystemTables: false,
        });
      const first = await handle();
      await migrateSmrtSchemas({
        db: first,
        packageName: APP,
        engineHint: engine,
      });
      const open = (on: typeof first) =>
        createAppModelEditor({
          db: on,
          application: 'editor-guards-handles',
          tenantId: TENANT,
          packageName: APP,
          cookbook: memberBook(),
          catalog: memberCatalog,
          authorize: (c) => c.actor === 'owner',
        });
      const e = await open(first);
      await applier(
        e,
        TENANT,
      )({
        type: 'add_field',
        model: MEMBER,
        name: 'vip',
        field: { type: 'boolean' },
      });
      // A reconnect: a new handle to the same database, same process.
      const second = await handle();
      try {
        const reopened = await open(second);
        expect(reopened.snapshot().revision).toBe(1);
      } finally {
        await second.close?.();
        await first.close?.();
      }
    },
  );

  it('keeps database identities unique across loaded copies of the editor module', async () => {
    const first = await editorFor(TENANT);
    await applier(
      first,
      TENANT,
    )({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    vi.resetModules();
    const copy = await import('../cookbook/model-editor.js');
    const other = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    try {
      await expect(
        copy.createAppModelEditor({
          db: other,
          application: 'editor-guards-slot',
          tenantId: TENANT,
          packageName: APP,
          cookbook: memberBook(),
          catalog: memberCatalog,
          authorize: (c) => c.actor === 'owner',
        }),
      ).rejects.toThrow(/MODEL_EDIT_CONFLICT: this process already holds/);
    } finally {
      await other.close?.();
    }
  });

  it('a rolled-back customisation of a pre-existing app subclass leaves no ownership behind', async () => {
    const base = ObjectRegistry.getClass(MEMBER)!
      .constructor as typeof SmrtObject;
    class AppGuardMember extends base {}
    ObjectRegistry.register(AppGuardMember, {
      name: 'GuardMember',
      packageName: APP,
    });
    const recipe = {
      ...memberCatalog,
      recipes: [
        {
          id: 'guards.members',
          label: 'Members',
          models: [MEMBER],
          nav: [],
          requires: [],
        },
      ],
    };
    const open = (tenantId: string) =>
      createAppModelEditor({
        db,
        application: 'editor-guards-slot',
        tenantId,
        packageName: APP,
        cookbook: { ...book(), recipes: ['guards.members'] },
        catalog: recipe,
        authorize: (c) => c.actor === 'owner',
      });
    const e = await open(TENANT);
    // A refused edit (a reserved name fails after registration would not; a
    // migration refusal does): drift on the provider table.
    await db.query(
      engine === 'postgres'
        ? `ALTER TABLE ${MEMBER_TABLE} ALTER COLUMN visits TYPE REAL`
        : `ALTER TABLE ${MEMBER_TABLE} DROP COLUMN visits`,
    );
    if (engine !== 'postgres')
      await db.query(`ALTER TABLE ${MEMBER_TABLE} ADD COLUMN visits REAL`);
    await expect(
      applier(
        e,
        TENANT,
      )({
        type: 'add_field',
        model: MEMBER,
        name: 'vip',
        field: { type: 'boolean' },
      }),
    ).rejects.toThrow();
    // Nothing of tenant A's remains claimed: tenant B opens.
    await expect(open(OTHER_TENANT)).resolves.toBeDefined();
  });

  it('a disabled customisation of a pre-existing app subclass leaves no ownership behind', async () => {
    const base = ObjectRegistry.getClass(MEMBER)!
      .constructor as typeof SmrtObject;
    class AppGuardMember extends base {}
    ObjectRegistry.register(AppGuardMember, {
      name: 'GuardMember',
      packageName: APP,
    });
    const recipe = {
      ...memberCatalog,
      recipes: [
        {
          id: 'guards.members',
          label: 'Members',
          models: [MEMBER],
          nav: [],
          requires: [],
        },
      ],
    };
    const open = (tenantId: string) =>
      createAppModelEditor({
        db,
        application: 'editor-guards-slot',
        tenantId,
        packageName: APP,
        cookbook: { ...book(), recipes: ['guards.members'] },
        catalog: recipe,
        authorize: (c) => c.actor === 'owner',
      });
    const e = await open(TENANT);
    await applier(
      e,
      TENANT,
    )({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    const staged = createCookbookEngine({
      catalog: recipe,
      cookbook: e.snapshot().cookbook,
    });
    staged.run({ name: 'remove_recipes', input: { ids: ['guards.members'] } });
    await applier(e, TENANT)({ type: 'import', cookbook: staged.cookbook() });
    await expect(open(OTHER_TENANT)).resolves.toBeDefined();
  });

  it('a pre-opened editor refused by another journal activates nothing for an import', async () => {
    const calls: string[][] = [];
    const first = await createAppModelEditor({
      db,
      application: 'editor-guards-slot',
      tenantId: TENANT,
      packageName: APP,
      cookbook: memberBook(),
      catalog: memberCatalog,
      authorize: (c) => c.actor === 'owner',
      activation: {
        activate: async (ids) => {
          calls.push([...ids]);
        },
      },
    });
    const second = await editorFor(OTHER_TENANT);
    await applier(
      second,
      OTHER_TENANT,
    )({
      type: 'add_field',
      model: MEMBER,
      name: 'loyalty',
      field: { type: 'text' },
    });
    await expect(
      first.apply(
        { type: 'import', cookbook: memberBook() },
        {
          actor: 'owner',
          tenantId: TENANT,
          expectedRevision: 0,
          requestId: 'req-foreign',
        },
      ),
    ).rejects.toThrow(/MODEL_EDIT_CONFLICT: this process already holds/);
    expect(calls).toEqual([]);
  });
});

describe('app model editor: provider fields across recipe disable', () => {
  const RECIPE = 'guards.members';
  const recipeCatalog = {
    ...memberCatalog,
    recipes: [
      { id: RECIPE, label: 'Members', models: [MEMBER], nav: [], requires: [] },
    ],
  };
  const recipeBook = (): Cookbook => ({ ...book(), recipes: [RECIPE] });
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    registerMember();
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
  const editorFor = () =>
    createAppModelEditor({
      db,
      application: 'editor-guards-disable',
      tenantId: TENANT,
      packageName: APP,
      cookbook: recipeBook(),
      catalog: recipeCatalog,
      authorize: (c) => c.actor === 'owner',
    });
  const applier =
    (e: Awaited<ReturnType<typeof editorFor>>) => (value: AppModelEdit) =>
      e.apply(value, {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: e.snapshot().revision,
        requestId: `req-${crypto.randomUUID()}`,
      });
  /** The cookbook engine's own recipe removal, as recipes.disable stages it. */
  const withoutRecipe = (cookbook: Cookbook) => {
    const staged = createCookbookEngine({ catalog: recipeCatalog, cookbook });
    const result = staged.run({
      name: 'remove_recipes',
      input: { ids: [RECIPE] },
    });
    if (!result.ok) throw new Error(result.error.message);
    return staged.cookbook();
  };

  it('disables the last recipe of a customised provider and restores its fields on re-enable', async () => {
    const e = await editorFor();
    const apply = applier(e);
    await apply({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    const disabled = withoutRecipe(e.snapshot().cookbook);
    expect(disabled.models?.fields[MEMBER]).toHaveProperty('vip');
    await apply({ type: 'import', cookbook: disabled });
    expect(e.snapshot().cookbook.recipes).toEqual([]);
    // The replacement leaves the registry: nothing projects its fields.
    expect(ObjectRegistry.getClass(`${APP}:GuardMember`)).toBeUndefined();
    expect([
      ...(await ObjectRegistry.getAllFields(MEMBER)).keys(),
    ]).not.toContain('vip');

    // New fields on a model outside the app stay refused.
    await expect(
      apply({
        type: 'add_field',
        model: MEMBER,
        name: 'tier',
        field: { type: 'text' },
      }),
    ).rejects.toThrow(/MODEL_NOT_IN_APP/);

    // Restart with the recipe off: a lazy host does not load the provider.
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    const cold = await editorFor();
    expect(cold.snapshot().revision).toBe(2);

    // Enabling the recipe again (the provider loads first) restores the field.
    registerMember();
    const staged = createCookbookEngine({
      catalog: recipeCatalog,
      cookbook: cold.snapshot().cookbook,
    });
    expect(
      staged.run({ name: 'add_recipes', input: { ids: [RECIPE] } }).ok,
    ).toBe(true);
    await applier(cold)({ type: 'import', cookbook: staged.cookbook() });
    const enabled = structuredClone(cold.snapshot().cookbook);
    expect(enabled.recipes).toEqual([RECIPE]);
    expect(enabled.models?.fields[MEMBER]).toHaveProperty('vip');
    const fields = await ObjectRegistry.getAllFields(`${APP}:GuardMember`);
    expect([...fields.keys()]).toContain('vip');
  });

  it('disabling through a reopened editor of the same journal takes the replacement out', async () => {
    const e = await editorFor();
    await applier(e)({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    const reopened = await editorFor();
    await applier(reopened)({
      type: 'import',
      cookbook: withoutRecipe(reopened.snapshot().cookbook),
    });
    expect(ObjectRegistry.getClass(`${APP}:GuardMember`)).toBeUndefined();
    expect([
      ...(await ObjectRegistry.getAllFields(MEMBER)).keys(),
    ]).not.toContain('vip');
  });

  it('keeps a journalled reference field of an inactive provider through disable and cold reopen', async () => {
    const e = await editorFor();
    await applier(e)({
      type: 'add_field',
      model: MEMBER,
      name: 'referredById',
      field: { type: 'reference', target: MEMBER },
    });
    await applier(e)({
      type: 'import',
      cookbook: withoutRecipe(e.snapshot().cookbook),
    });
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    const cold = await editorFor();
    expect(cold.snapshot().revision).toBe(2);
    expect(cold.snapshot().cookbook.models?.fields[MEMBER]).toHaveProperty(
      'referredById',
    );
  });
});

describe('app model editor: history reads and completion', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    registerMember();
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
  const application = 'editor-guards-history';
  const open = (
    store?: AppModelEditorOptions['store'],
    publish?: AppModelEditorOptions['publish'],
  ) =>
    createAppModelEditor({
      db,
      application,
      tenantId: TENANT,
      packageName: APP,
      cookbook: memberBook(),
      catalog: memberCatalog,
      authorize: (c) => c.actor === 'owner',
      ...(store ? { store } : {}),
      ...(publish ? { publish } : {}),
    });
  const applyTo =
    (e: Awaited<ReturnType<typeof open>>) =>
    (value: AppModelEdit, requestId: string = crypto.randomUUID()) =>
      e.apply(value, {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: e.snapshot().revision,
        requestId,
      });

  it('an edit reads single journal rows, never the whole history or its receipts', async () => {
    const e = await open();
    const apply = applyTo(e);
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    const statements: string[] = [];
    const query = db.query.bind(db);
    db.query = ((sql: string, ...rest: unknown[]) => {
      if (/_smrt_app_model_changes/.test(sql) && /^\s*SELECT/i.test(sql))
        statements.push(sql);
      return (query as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof db.query;
    for (let i = 0; i < 4; i++)
      await apply({
        type: 'relabel_list',
        name: 'GuardMat',
        label: `Mats ${i}`,
      });
    const receipt = await apply(
      { type: 'relabel_list', name: 'GuardMat', label: 'Final' },
      'req-final',
    );
    db.query = query;
    expect(receipt.revision).toBe(6);
    expect(statements.length).toBeGreaterThan(0);
    // Every journal read during edits is a single-row read.
    for (const sql of statements)
      expect(sql).toMatch(/LIMIT 1|request_id = \?/);
    // A committed retry still replays its stored receipt.
    const replayed = await e.apply(
      { type: 'relabel_list', name: 'GuardMat', label: 'Final' },
      {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: 5,
        requestId: 'req-final',
      },
    );
    expect(replayed).toMatchObject({ revision: 6, replayed: true });
    expect((await open()).snapshot().revision).toBe(6);
  });

  it('adopts the journal receipt when another process completed the revision first', async () => {
    const base = await createAppModelHistory({
      db,
      application,
      tenantId: TENANT,
    });
    let foreign: AppModelEditReceipt | undefined;
    const store: AppModelHistoryStore = {
      ...base,
      // Another process's boot recovery completes the pending revision first.
      async complete(revision, elapsedMs, receipt, result) {
        if (receipt && revision === 2) {
          foreign = {
            ...structuredClone(receipt),
            elapsedMs: 4242,
            cookbook: { ...structuredClone(receipt.cookbook), name: 'Winner' },
          };
          await base.complete(revision, 4242, foreign, result);
        }
        return base.complete(revision, elapsedMs, receipt, result);
      },
    };
    const e = await open(store);
    const seen: AppModelSnapshot[] = [];
    e.subscribe((snapshot) => seen.push(snapshot));
    const apply = applyTo(e);
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    const receipt = await apply({
      type: 'relabel_list',
      name: 'GuardMat',
      label: 'Mats',
    });
    expect(receipt.elapsedMs).toBe(4242);
    expect(receipt.cookbook.name).toBe('Winner');
    expect(seen.at(-1)?.cookbook.name).toBe('Winner');
  });

  it('refuses to report success when the revision was not completed as this edit', async () => {
    const base = await createAppModelHistory({
      db,
      application,
      tenantId: TENANT,
    });
    const store: AppModelHistoryStore = {
      ...base,
      // The completion is lost: the row is still pending afterwards.
      async complete(revision, elapsedMs, receipt, result) {
        if (revision === 2) return;
        return base.complete(revision, elapsedMs, receipt, result);
      },
    };
    const e = await open(store);
    const apply = applyTo(e);
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    await expect(
      apply({ type: 'relabel_list', name: 'GuardMat', label: 'Mats' }),
    ).rejects.toThrow(/MODEL_EDIT_CONFLICT: revision 2 was not completed/);
    expect(() => e.snapshot()).toThrow(/MODEL_ACTIVATION_PENDING/);
  });

  it('opens and undoes a journal whose stored document holds a label that is not text', async () => {
    const e = await open();
    await applyTo(e)({ type: 'create_list', name: 'GuardMat', list: mats });
    // A row written before labels were validated.
    const before = e.snapshot().cookbook;
    const after = {
      ...structuredClone(before),
      layout: {
        version: 1,
        items: { 'editor-guards-app:guardmat': { label: 5 } },
      },
    } as unknown as Cookbook;
    const store = await createAppModelHistory({
      db,
      application,
      tenantId: TENANT,
    });
    await store.append(
      {
        revision: 2,
        requestId: 'req-legacy-label',
        actor: 'owner',
        command: JSON.stringify({ type: 'import', cookbook: after }),
        before,
        after,
        status: 'pending',
      },
      1,
    );
    await store.complete(2, 0);
    ObjectRegistry.clear();
    registerMember();
    const reopened = await open();
    expect(reopened.snapshot().revision).toBe(2);
    await applyTo(reopened)({ type: 'undo' });
    expect(reopened.snapshot().revision).toBe(3);
  });

  /** A store whose completions of `revision` lose to another process's. */
  const losingStore = async (revision: number) => {
    const base = await createAppModelHistory({
      db,
      application,
      tenantId: TENANT,
    });
    const store: AppModelHistoryStore = {
      ...base,
      async complete(at, elapsedMs, receipt, result) {
        if (receipt && at === revision)
          await base.complete(
            at,
            4242,
            {
              ...structuredClone(receipt),
              elapsedMs: 4242,
              cookbook: {
                ...structuredClone(receipt.cookbook),
                name: 'Winner',
              },
            },
            result,
          );
        return base.complete(at, elapsedMs, receipt, result);
      },
    };
    return store;
  };

  it('installs a winning completion through the host before opening, and serves it', async () => {
    const published: AppModelSnapshot[] = [];
    const e = await open(await losingStore(2), (snapshot) => {
      published.push(snapshot);
    });
    const apply = applyTo(e);
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    await apply({ type: 'relabel_list', name: 'GuardMat', label: 'Mats' });
    expect(published.at(-1)?.cookbook.name).toBe('Winner');
    expect(e.snapshot().cookbook.name).toBe('Winner');
  });

  it('stays closed when installing the winning completion fails', async () => {
    let calls = 0;
    const e = await open(await losingStore(2), () => {
      calls += 1;
      // boot, revision 1, revision 2 local; the winner's install throws.
      if (calls === 4) throw new Error('host publication unavailable');
    });
    const apply = applyTo(e);
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    await expect(
      apply({ type: 'relabel_list', name: 'GuardMat', label: 'Mats' }),
    ).rejects.toThrow(/host publication unavailable/);
    expect(() => e.snapshot()).toThrow(/MODEL_ACTIVATION_PENDING/);
  });

  it('a pending boot recovery that loses its completion installs and serves the winner', async () => {
    let failPublish = false;
    const e = await open(undefined, () => {
      if (failPublish) throw new Error('host publication unavailable');
    });
    const apply = applyTo(e);
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    failPublish = true;
    await expect(
      apply({ type: 'relabel_list', name: 'GuardMat', label: 'Mats' }),
    ).rejects.toThrow(/host publication unavailable/);
    ObjectRegistry.clear();
    registerMember();
    const published: AppModelSnapshot[] = [];
    const reopened = await open(await losingStore(2), (snapshot) => {
      published.push(snapshot);
    });
    expect(published.at(-1)?.cookbook.name).toBe('Winner');
    expect(reopened.snapshot().cookbook.name).toBe('Winner');
    expect((await reopened.history()).at(-1)?.status).toBe('applied');
  });

  it('refuses an import whose navigation cannot be projected before journalling it, and an existing such pending row can be abandoned', async () => {
    const e = await open();
    const apply = applyTo(e);
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    const item = 'editor-guards-app:guardmat';
    const bad = {
      ...structuredClone(e.snapshot().cookbook),
      layout: { version: 1, items: { [item]: { label: 5 } } },
    };
    await expect(apply({ type: 'import', cookbook: bad })).rejects.toThrow(
      /INVALID_MODEL_EDIT/,
    );
    expect((await e.history()).map((row) => row.status)).toEqual(['applied']);

    // A pending row written that way before: abandon it, then reopen.
    const store = await createAppModelHistory({
      db,
      application,
      tenantId: TENANT,
    });
    await store.append(
      {
        revision: 2,
        requestId: 'req-stuck-label',
        actor: 'owner',
        command: JSON.stringify({ type: 'import', cookbook: bad }),
        before: e.snapshot().cookbook,
        after: bad as unknown as Cookbook,
        status: 'pending',
      },
      1,
    );
    await abandonAppModelRevision({
      db,
      application,
      tenantId: TENANT,
      revision: 2,
      actor: 'operator',
    });
    ObjectRegistry.clear();
    registerMember();
    const reopened = await open();
    expect(reopened.snapshot().revision).toBe(2);
    expect(reopened.snapshot().cookbook.layout?.items?.[item]).toBeUndefined();
  });

  it('classifies abandoned rows by one predicate in light and full reads', async () => {
    const store = await createAppModelHistory({
      db,
      application,
      tenantId: TENANT,
    });
    const row = (revision: number) => ({
      revision,
      requestId: `req-predicate-${revision}`,
      actor: 'owner',
      command: JSON.stringify({ type: 'relabel_list' }),
      before: memberBook(),
      after: memberBook(),
      status: 'pending' as const,
    });
    // Ordinary results that merely contain an `abandoned` key.
    await store.append(row(1), 0);
    await store.complete(1, 1, undefined, { abandoned: false, ok: true });
    await store.append(row(2), 1);
    await store.complete(2, 1, undefined, { ok: true, abandoned: true });
    // An operator abandon.
    await store.append(row(3), 2);
    await abandonAppModelRevision({
      db,
      application,
      tenantId: TENANT,
      revision: 3,
      actor: 'operator',
    });
    const full = await store.read();
    const light = await journalReader(store)!.light();
    for (const rows of [full, light])
      expect(rows.map((entry) => entry.abandoned === true)).toEqual([
        false,
        false,
        true,
      ]);
  });
});

describe('app model editor: undo and import activate restored recipes', () => {
  const RECIPE = 'guards.members';
  const recipeCatalog = {
    ...memberCatalog,
    recipes: [
      { id: RECIPE, label: 'Members', models: [MEMBER], nav: [], requires: [] },
    ],
  };
  const memberManifest: ActivationManifest = {
    version: 1,
    modules: {
      members: { specifier: 'fixture', models: [MEMBER], dependencies: [] },
    },
    models: {
      [MEMBER]: {
        module: 'members',
        effective: MEMBER,
        table: MEMBER_TABLE,
        dependencies: [],
      },
    },
    tables: { [MEMBER_TABLE]: { owners: [MEMBER], dependencies: [] } },
  };
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let enabled: string[];
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    db = await getTestDatabase({
      type: databaseType,
      classes: [],
      includeSystemTables: false,
    });
    enableTenancy();
    enabled = [MEMBER];
  });
  afterEach(async () => {
    setRuntimeExposureGate(undefined);
    globalThis.__smrtModelReadiness?.clear();
    disableTenancy();
    await db.close?.();
    restore();
  });
  /** A process start: a fresh registry and coordinator that loads only enabled models. */
  const boot = async () => {
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    const activation = createActivationCoordinator({
      scope: `editor-guards-undo-${crypto.randomUUID()}`,
      db,
      packageName: APP,
      manifest: memberManifest,
      loaders: {
        members: async () => {
          if (!ObjectRegistry.getClass(MEMBER)) registerMember();
        },
      },
      readEnabled: async () => enabled,
    });
    await activation.boot();
    return activation;
  };
  const editorFor = (
    activation?: AppModelEditorOptions['activation'],
    cookbook: Cookbook = { ...book(), recipes: [RECIPE] },
  ) =>
    createAppModelEditor({
      db,
      application: 'editor-guards-undo',
      tenantId: TENANT,
      packageName: APP,
      cookbook,
      catalog: recipeCatalog,
      authorize: (c) => c.actor === 'owner',
      ...(activation ? { activation } : {}),
    });
  const applier =
    (e: Awaited<ReturnType<typeof editorFor>>) => (value: AppModelEdit) =>
      e.apply(value, {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: e.snapshot().revision,
        requestId: `req-${crypto.randomUUID()}`,
      });
  const disable = (cookbook: Cookbook) => {
    const staged = createCookbookEngine({ catalog: recipeCatalog, cookbook });
    staged.run({ name: 'remove_recipes', input: { ids: [RECIPE] } });
    return staged.cookbook();
  };

  it('undo of a recipe disable after a restart loads, migrates and opens the recipe', async () => {
    let activation = await boot();
    let e = await editorFor(activation);
    await applier(e)({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    await applier(e)({
      type: 'import',
      cookbook: disable(e.snapshot().cookbook),
    });

    // Restart with the recipe off: the provider is not loaded.
    enabled = [];
    activation = await boot();
    expect(ObjectRegistry.getClass(MEMBER)).toBeUndefined();
    e = await editorFor(activation);
    expect(activation.isReady(MEMBER)).toBe(false);

    await applier(e)({ type: 'undo' });
    expect(e.snapshot().cookbook.recipes).toEqual([RECIPE]);
    expect(ObjectRegistry.getClass(MEMBER)).toBeDefined();
    expect(activation.isReady(MEMBER)).toBe(true);
    const fields = await ObjectRegistry.getAllFields(`${APP}:GuardMember`);
    expect([...fields.keys()]).toContain('vip');
    // A further undo is not blocked.
    await applier(e)({ type: 'undo' });
    expect(e.snapshot().cookbook.models?.fields[MEMBER]).toBeUndefined();
  });

  it('import of a cookbook that enables a recipe activates it first', async () => {
    enabled = [];
    const activation = await boot();
    const e = await editorFor(activation, book());
    await applier(e)({
      type: 'import',
      cookbook: { ...book(), recipes: [RECIPE] },
    });
    expect(activation.isReady(MEMBER)).toBe(true);
    expect(e.snapshot().cookbook.recipes).toEqual([RECIPE]);
  });
  it('loads nothing for a refused, stale or replayed import or undo', async () => {
    enabled = [];
    const activation = await boot();
    const calls: string[][] = [];
    const counting = {
      manifest: activation.manifest,
      activate: async (ids: Iterable<string>) => {
        calls.push([...ids]);
        return activation.activate(ids);
      },
    };
    const e = await editorFor(counting, book());
    const enable = {
      type: 'import',
      cookbook: { ...book(), recipes: [RECIPE] },
    } as const;
    // Another actor (refused by authorize) and another tenant.
    await expect(
      e.apply(enable, {
        actor: 'intruder',
        tenantId: TENANT,
        expectedRevision: 0,
        requestId: 'r-1',
      }),
    ).rejects.toThrow(/MODEL_EDIT_FORBIDDEN/);
    await expect(
      e.apply(enable, {
        actor: 'owner',
        tenantId: '66666666-6666-4666-8666-666666666666',
        expectedRevision: 0,
        requestId: 'r-2',
      }),
    ).rejects.toThrow(/MODEL_EDIT_FORBIDDEN/);
    // A stale revision.
    await expect(
      e.apply(enable, {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: 7,
        requestId: 'r-3',
      }),
    ).rejects.toThrow(/MODEL_EDIT_CONFLICT/);
    expect(calls).toEqual([]);
    expect(ObjectRegistry.getClass(MEMBER)).toBeUndefined();
    // The real request activates once; its retry replays without activation.
    const context = {
      actor: 'owner',
      tenantId: TENANT,
      expectedRevision: 0,
      requestId: 'r-4',
    };
    await e.apply(enable, context);
    expect(calls).toHaveLength(1);
    expect(await e.apply(enable, context)).toMatchObject({ replayed: true });
    expect(calls).toHaveLength(1);
  });

  it('refuses a new list on the table of an installed model whose recipe is off', async () => {
    enabled = [];
    const activation = await boot();
    expect(ObjectRegistry.getClass(MEMBER)).toBeUndefined();
    const e = await editorFor(activation, book());
    await expect(
      applier(e)({ type: 'create_list', name: 'GuardMembers', list: mats }),
    ).rejects.toThrow(
      /MODEL_TABLE_COLLISION: guard_members is the table of the installed model/,
    );
    expect(await e.history()).toEqual([]);
    // The provider was never loaded and its table never created.
    const { rows } = await db.query(
      engine === 'postgres'
        ? "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'guard_members'"
        : "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guard_members'",
    );
    expect(rows).toEqual([]);
  });

  it('refuses a list that takes the identity of an installed app model that is not loaded', async () => {
    const own = `${APP}:GuardDesk`;
    const e = await editorFor(
      {
        manifest: {
          version: 1,
          modules: {
            desk: { specifier: 'fixture', models: [own], dependencies: [] },
          },
          models: {
            [own]: {
              module: 'desk',
              effective: own,
              table: 'guard_desk_items',
              dependencies: [],
            },
          },
          tables: { guard_desk_items: { owners: [own], dependencies: [] } },
        },
        activate: async () => {},
      },
      book(),
    );
    await expect(
      applier(e)({ type: 'create_list', name: 'GuardDesk', list: mats }),
    ).rejects.toThrow(/MODEL_NAME_COLLISION: GuardDesk is the installed model/);
  });
  it('refuses to load a recipe onto a table a standalone run-time list holds, before importing it', async () => {
    enabled = [];
    const activation = await boot();
    const e = await editorFor(undefined, book());
    await applier(e)({ type: 'create_list', name: 'GuardMembers', list: mats });
    await expect(activation.activate([MEMBER])).rejects.toThrow(
      /Activation table guard_members is already used by the run-time model/,
    );
    expect(ObjectRegistry.getClass(MEMBER)).toBeUndefined();
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).not.toThrow();
  });

  it('still activates a closure whose table a run-time subclass of a model shares', async () => {
    enabled = [];
    const activation = await boot();
    // The provider as a single-table family, and a run-time subclass of it.
    class GuardMember extends SmrtObject {
      name = '';
      visits = 0;
    }
    field({ type: 'text' })(GuardMember.prototype, 'name');
    field({ type: 'integer' })(GuardMember.prototype, 'visits');
    ObjectRegistry.register(GuardMember, {
      packageName: MEMBER_PKG,
      tableName: MEMBER_TABLE,
      tableStrategy: 'sti',
      tenantScoped: true,
    });
    registerRuntimeModel({
      packageName: '@fixture/editor-guards-extension',
      name: 'GuardPatron',
      extends: MEMBER,
      tableName: MEMBER_TABLE,
      fields: { patronLevel: { type: 'text' } },
    });
    await activation.activate([MEMBER]);
    expect(activation.isReady(MEMBER)).toBe(true);
  });
});
