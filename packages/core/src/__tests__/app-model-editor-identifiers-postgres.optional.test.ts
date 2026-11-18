/**
 * App model editor storage identifiers on a real PostgreSQL server, which
 * truncates identifiers over 63 bytes. Needs SMRT_TEST_POSTGRES_URL.
 */
import type { Cookbook } from '@happyvertical/smrt-types';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disableTenancy,
  enableTenancy,
} from '../../../tenancy/src/interceptor.js';
import {
  type AppModelEdit,
  createAppModelEditor,
} from '../cookbook/model-editor.js';
import { COOKBOOK_SCHEMA_URL } from '../cookbook/validate.js';
import { field } from '../decorators/index.js';
import { migrateSmrtSchemas } from '../migrations/orchestrate.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import { setRuntimeExposureGate } from '../runtime-exposure.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const APP = '@fixture/pg-identifier-app';
const PKG = '@fixture/pg-identifier-members';
const MEMBER = `${PKG}:PgIdentifierMember`;
const TABLE = 'pg_identifier_members';
const LIST_TABLE = 'pg_identifier_mats';
const TENANT = '44444444-4444-4444-8444-444444444444';
const LONG_FIELD = 'nameOfThePersonWhoSignedOffOnTheLastFireInspectionHere';
const LONG_MONEY = 'dateOfLastInspectionByTheFireMarshalForThisLocation';
const book = (): Cookbook => ({
  $schema: COOKBOOK_SCHEMA_URL,
  version: 1,
  recipes: [],
  features: [MEMBER],
  policies: [],
});
const catalog = {
  recipes: [],
  models: [
    {
      id: MEMBER,
      name: 'PgIdentifierMember',
      packageId: 'pg-identifier-members',
      exposed: true,
      fields: [{ name: 'name' }],
    },
  ],
};
const register = () => {
  class PgIdentifierMember extends SmrtObject {
    name = '';
  }
  field({ type: 'text' })(PgIdentifierMember.prototype, 'name');
  ObjectRegistry.register(PgIdentifierMember, {
    packageName: PKG,
    tableName: TABLE,
    tenantScoped: true,
    api: true,
    mcp: true,
  });
};
const mats = {
  label: 'Mats',
  icon: 'layers',
  displayField: 'size',
  fields: { size: { type: 'text' } },
} as const;

describe.skipIf(!pgUrl)('app model editor identifiers on PostgreSQL', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let application: string;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    globalThis.__smrtModelReadiness?.clear();
    db = await getDatabase({ type: 'postgres', url: pgUrl });
    for (const table of [TABLE, LIST_TABLE])
      await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    application = `pg-identifiers-${crypto.randomUUID()}`;
    register();
    enableTenancy();
    await migrateSmrtSchemas({
      db,
      packageName: APP,
      engineHint: 'postgres',
      postgresSafe: false,
      useConcurrentIndexes: false,
    });
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
      application,
      tenantId: TENANT,
      packageName: APP,
      cookbook: book(),
      catalog,
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
  const columns = async () =>
    (
      await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${TABLE}'`,
      )
    ).rows.map((row) => String(row.column_name));

  it('refuses an over-long column or money companion before any DDL or journal row', async () => {
    const e = await editorFor();
    const apply = applier(e);
    await expect(
      apply({
        type: 'add_field',
        model: MEMBER,
        name: LONG_FIELD,
        field: { type: 'text' },
      }),
    ).rejects.toThrow(/INVALID_MODEL_EDIT: .*\(66 bytes\)/);
    await expect(
      apply({
        type: 'add_field',
        model: MEMBER,
        name: LONG_MONEY,
        field: { type: 'money', currency: 'CAD' },
      }),
    ).rejects.toThrow(/INVALID_MODEL_EDIT: .*\(70 bytes\)/);
    expect(await e.history()).toEqual([]);
    expect(
      (await columns()).some((name) => name.startsWith('name_of_the_person')),
    ).toBe(false);
    // Later edits and a reopen keep working.
    await apply({
      type: 'add_field',
      model: MEMBER,
      name: 'vip',
      field: { type: 'boolean' },
    });
    await apply({
      type: 'add_field',
      model: MEMBER,
      name: 'tier',
      field: { type: 'text' },
    });
    ObjectRegistry.clear();
    register();
    expect((await editorFor()).snapshot().revision).toBe(2);
  });
});
