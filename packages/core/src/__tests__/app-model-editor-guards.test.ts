/** App model editor guards: installed-model identity, scoped reconciliation, history bounds. */

import type { Cookbook } from '@happyvertical/smrt-types';
import type { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disableTenancy,
  enableTenancy,
} from '../../../tenancy/src/interceptor.js';
import {
  type AppModelEdit,
  type AppModelEditorOptions,
  createAppModelEditor,
} from '../cookbook/model-editor.js';
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
});
