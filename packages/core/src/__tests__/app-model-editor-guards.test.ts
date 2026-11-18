/** App model editor guards: installed-model identity, scoped reconciliation, history bounds. */

import type { Cookbook } from '@happyvertical/smrt-types';
import type { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disableTenancy,
  enableTenancy,
} from '../../../tenancy/src/interceptor.js';
import { planAppEdit } from '../cookbook/app-tool-edits.js';
import {
  type AppModelEdit,
  type AppModelEditorOptions,
  createAppModelEditor,
} from '../cookbook/model-editor.js';
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
