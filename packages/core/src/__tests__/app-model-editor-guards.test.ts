/** App model editor guards: installed-model identity, scoped reconciliation, history bounds. */

import type { Cookbook } from '@happyvertical/smrt-types';
import type { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disableTenancy,
  enableTenancy,
} from '../../../tenancy/src/interceptor.js';
import {
  type ActivationManifest,
  createActivationCoordinator,
} from '../activation.js';
import { planAppEdit } from '../cookbook/app-tool-edits.js';
import {
  type AppModelEdit,
  type AppModelEditorOptions,
  createAppModelEditor,
} from '../cookbook/model-editor.js';
import {
  abandonAppModelRevision,
  createAppModelHistory,
} from '../cookbook/model-history.js';
import { fitsStorageIdentifier, storageColumns } from '../cookbook/models.js';
import { COOKBOOK_SCHEMA_URL } from '../cookbook/validate.js';
import { field } from '../decorators/index.js';
import { migrateSmrtSchemas } from '../migrations/orchestrate.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import { setRuntimeExposureGate } from '../runtime-exposure.js';
import { runtimeListTableName } from '../runtime-list-table.js';
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
const manifest: ActivationManifest = {
  version: 1,
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
    enabled = [];
  });
  afterEach(async () => {
    setRuntimeExposureGate(undefined);
    globalThis.__smrtModelReadiness?.clear();
    disableTenancy();
    await db.close?.();
    restore();
  });
  const coordinator = () =>
    createActivationCoordinator({
      scope: `editor-guards-${crypto.randomUUID()}`,
      db,
      packageName: APP,
      manifest,
      loaders: { ledger: loadLedger },
      readEnabled: async () => enabled,
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
  const tableNames = async () =>
    (
      await db.query(
        engine === 'postgres'
          ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'guard_%'"
          : "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'guard_%'",
      )
    ).rows.map((row) => String(row.name));

  it('refuses a list whose table belongs to an installed model that is not loaded', async () => {
    expect(runtimeListTableName(SAME_TABLE_LIST)).toBe(LEDGER_TABLE);
    const activation = coordinator();
    await activation.boot();
    expect(ObjectRegistry.getClass(LEDGER)).toBeUndefined();
    const e = await editorFor({ activation });
    const apply = applier(e);
    await expect(
      apply({
        type: 'create_list',
        name: SAME_TABLE_LIST,
        list: listDefinition,
      }),
    ).rejects.toThrow(
      /MODEL_TABLE_COLLISION: guard_ledgers is the table of the installed model/,
    );
    expect(await tableNames()).not.toContain(LEDGER_TABLE);
    expect(e.snapshot().revision).toBe(0);
    expect(await e.history()).toEqual([]);

    // Same name as the installed (unloaded) model, from the catalog alone.
    await expect(
      applier(await editorFor())({
        type: 'create_list',
        name: 'GuardLedger',
        list: listDefinition,
      }),
    ).rejects.toThrow(
      /MODEL_NAME_COLLISION: GuardLedger is the name of the installed model/,
    );

    // The recipe still activates afterwards; another list name works.
    enabled = [LEDGER];
    await activation.activate([LEDGER]);
    expect(ObjectRegistry.getClass(LEDGER)).toBeDefined();
    await apply({
      type: 'create_list',
      name: 'GuardNotes',
      list: listDefinition,
    });
    expect(await tableNames()).toEqual(
      expect.arrayContaining([LEDGER_TABLE, 'guard_notes']),
    );
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).not.toThrow();
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

  it('keeps an existing list editable and refuses to load a recipe onto its table', async () => {
    // A list created before the editor knew the installed graph took the table.
    const activation = coordinator();
    await activation.boot();
    const e = await editorFor();
    const apply = applier(e);
    await apply({
      type: 'create_list',
      name: SAME_TABLE_LIST,
      list: listDefinition,
    });

    // Activation refuses before importing, so the process keeps one family per table.
    await expect(activation.activate([LEDGER])).rejects.toThrow(
      /Activation table guard_ledgers is already used by the run-time model/,
    );
    expect(ObjectRegistry.getClass(LEDGER)).toBeUndefined();
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).not.toThrow();

    // Every edit to the list, and a fresh editor, still work.
    await apply({
      type: 'add_field',
      model: SAME_TABLE_LIST,
      name: 'dueOn',
      field: { type: 'date' },
    });
    await apply({ type: 'remove_list', name: SAME_TABLE_LIST });
    const reopened = await editorFor({ activation });
    expect(reopened.snapshot().revision).toBe(3);
  });
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

    // The editor reopens with the drift still present, and edits again after repair.
    ObjectRegistry.clear();
    registerMember();
    const reopened = await editorFor();
    expect(reopened.snapshot().revision).toBe(5);
    await repairVisits();
    await applier(reopened)({
      type: 'add_field',
      model: MEMBER,
      name: 'nickname',
      field: { type: 'text' },
    });
    expect(await columns(MEMBER_TABLE)).toContain('nickname');
  });

  it('boot of an applied journal runs no DDL on provider tables', async () => {
    const e = await editorFor();
    await applier(e)({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    // A provider upgrade adds a field; the editor restarts with it.
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    registerMember(true);
    await editorFor();
    expect(await columns(MEMBER_TABLE)).not.toContain('loyalty_tier');
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
      /MODEL_IDENTIFIER_TOO_LONG: .*name_of_the_person_who_signed_off_on_the_last_fire_inspection_here" \(66 bytes\); PostgreSQL allows 63/,
    );
    await expect(
      apply({
        type: 'add_field',
        model: MEMBER,
        name: LONG_MONEY,
        field: { type: 'money', currency: 'CAD' },
      }),
    ).rejects.toThrow(/MODEL_IDENTIFIER_TOO_LONG: .*_currency" \(70 bytes\)/);
    await expect(
      apply({
        type: 'create_list',
        name: 'GuardAnExceptionallyLongListNameThatNoPostgresTableCouldEverHold',
        list: mats,
      }),
    ).rejects.toThrow(
      /MODEL_IDENTIFIER_TOO_LONG: models\.lists\..* stores as table/,
    );
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
        /MODEL_IDENTIFIER_TOO_LONG: guard_members\.name_of_the_person.* cannot take new fields/,
      );
    else await addToSameModel;
    expect(
      (await reopened.history()).every((row) => row.status === 'applied'),
    ).toBe(true);
  });
});
