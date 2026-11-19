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
  type AppModelEditReceipt,
  type AppModelSnapshot,
  createAppModelEditor,
} from '../cookbook/model-editor.js';
import {
  type AppModelHistoryStore,
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
import { registerRuntimeModel } from '../runtime-model.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

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
  const open = (store?: AppModelEditorOptions['store']) =>
    createAppModelEditor({
      db,
      application,
      tenantId: TENANT,
      packageName: APP,
      cookbook: memberBook(),
      catalog: memberCatalog,
      authorize: (c) => c.actor === 'owner',
      ...(store ? { store } : {}),
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
