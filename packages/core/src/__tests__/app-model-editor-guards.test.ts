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
import { createCookbookEngine } from '../cookbook/engine/engine.js';
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
      /MODEL_EDITOR_CONFLICT/,
    );
    await expect(editorFor(TENANT, 'editor-guards-other-app')).rejects.toThrow(
      /MODEL_EDITOR_CONFLICT/,
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
      applier(
        first,
        TENANT,
      )({
        type: 'add_field',
        model: MEMBER,
        name: 'vip',
        field: { type: 'boolean' },
      }),
    ).rejects.toThrow(/MODEL_EDITOR_CONFLICT/);
    const fields = await ObjectRegistry.getAllFields(`${APP}:GuardMember`);
    expect([...fields.keys()]).not.toContain('vip');
    expect(await first.history()).toEqual([]);
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
    activation?: Awaited<ReturnType<typeof boot>>,
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
});

describe('app model editor: history reads stay bounded', () => {
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

  it('an edit reads single journal rows, never the whole history or its receipts', async () => {
    const application = 'editor-guards-history';
    const base = await createAppModelHistory({
      db,
      application,
      tenantId: TENANT,
    });
    const reads: Array<{ receipts?: boolean } | undefined> = [];
    const store = {
      ...base,
      read: (options?: { receipts?: boolean }) => {
        reads.push(options);
        return base.read(options);
      },
    };
    const open = () =>
      createAppModelEditor({
        db,
        application,
        tenantId: TENANT,
        packageName: APP,
        cookbook: memberBook(),
        catalog: memberCatalog,
        authorize: (c) => c.actor === 'owner',
        store,
      });
    const e = await open();
    const apply = (
      value: AppModelEdit,
      requestId: string = crypto.randomUUID(),
    ) =>
      e.apply(value, {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: e.snapshot().revision,
        requestId,
      });
    await apply({ type: 'create_list', name: 'GuardMat', list: mats });
    for (let i = 0; i < 6; i++)
      await apply({
        type: 'relabel_list',
        name: 'GuardMat',
        label: `Mats ${i}`,
      });
    // Boot reads the light journal once; edits read no full history at all.
    expect(reads).toEqual([{ receipts: false }]);

    const receipt = await apply(
      { type: 'relabel_list', name: 'GuardMat', label: 'Final' },
      'req-final',
    );
    expect(receipt.revision).toBe(8);
    expect(receipt.manifest.objects).toBeDefined();
    // A committed retry still replays its stored receipt.
    const replayed = await e.apply(
      { type: 'relabel_list', name: 'GuardMat', label: 'Final' },
      {
        actor: 'owner',
        tenantId: TENANT,
        expectedRevision: 7,
        requestId: 'req-final',
      },
    );
    expect(replayed).toMatchObject({ revision: 8, replayed: true });
    expect(reads).toEqual([{ receipts: false }]);

    const light = await base.read({ receipts: false });
    expect(light).toHaveLength(8);
    expect(light.every((row) => !row.receipt && !row.result)).toBe(true);
    expect((await base.read()).every((row) => !!row.receipt)).toBe(true);
    expect((await open()).snapshot().revision).toBe(8);
  });
});
