/**
 * An existing table the comparison cannot read is an error, on a real
 * PostgreSQL server (see `unreadable-table.test.ts` for SQLite and DuckDB).
 *
 * The table list comes from `information_schema.tables`, which also lists
 * views. A handle without an inspector is described from the catalog through
 * `query()`, which describes ordinary tables only, so a view standing where a model's table should be is
 * listed but not described. That used to compare as "no changes".
 *
 * Runs only in the PostgreSQL lane (`DATABASE_URL` / `SMRT_TEST_POSTGRES_URL`).
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { TableSchemaUnreadableError } from '../../schema/inspection.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { readLastMigrateRecord } from '../migrate-record.js';
import { migrateSmrtSchemas } from '../orchestrate.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const PACKAGE = '@test/unreadable-table-pg';

describe.skipIf(!pgUrl)(
  'an existing table that cannot be read stops the migrate (real PostgreSQL)',
  () => {
    let admin: DatabaseInterface;
    let db: DatabaseInterface;
    let databaseName: string;
    let restore: () => void;

    let table: string;

    function registerVersion(version: 1 | 2) {
      ObjectRegistry.clear();
      class UnreadablePgItemV1 extends SmrtObject {
        title = '';
      }
      class UnreadablePgItemV2 extends SmrtObject {
        title = '';
        note = '';
      }
      const Item = version === 1 ? UnreadablePgItemV1 : UnreadablePgItemV2;
      field({ type: 'text' })(Item.prototype, 'title');
      if (version === 2) field({ type: 'text' })(Item.prototype, 'note');
      ObjectRegistry.register(Item, {
        packageName: PACKAGE,
        tableName: table,
      });
    }

    /** `db` without an inspector: only `query()` can describe its tables. */
    const queryOnly = (db: DatabaseInterface): DatabaseInterface =>
      new Proxy(db, {
        get(target, key, receiver) {
          if (key === 'getTableSchema') return undefined;
          const value = Reflect.get(target, key, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

    const migrate = (handle: DatabaseInterface) =>
      migrateSmrtSchemas({
        db: handle,
        packageName: PACKAGE,
        name: `unreadable_pg_${randomUUID()}`,
        engineHint: 'postgres',
        postgresSafe: false,
        useConcurrentIndexes: false,
      });

    const hasColumn = async (column: string) =>
      (
        await db.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
          table,
          column,
        )
      ).rows.length > 0;

    beforeAll(async () => {
      admin = (await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
      })) as DatabaseInterface;
      databaseName = `smrt_unreadable_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const url = new URL(pgUrl as string);
      url.pathname = `/${databaseName}`;
      db = (await getDatabase({
        type: 'postgres',
        url: String(url),
        dbid: `unreadable-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    });
    beforeEach(() => {
      restore = snapshotObjectRegistryState();
      table = `unreadable_pg_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    });
    afterEach(() => restore?.());
    afterAll(async () => {
      await db?.close?.();
      await admin?.query(
        `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
      );
      await admin?.close?.();
    });

    it('a transaction handle without an inspector compares an ordinary existing table', async () => {
      registerVersion(1);
      await migrate(db);
      registerVersion(2);

      const result = await db.transaction?.((tx) =>
        migrate(queryOnly(tx as unknown as DatabaseInterface)),
      );

      expect(result).toMatchObject({ applied: true, refused: false });
      expect(await hasColumn('note')).toBe(true);
    });

    it('wraps an adapter inspection failure without applying or recording changes', async () => {
      registerVersion(1);
      await migrate(db);
      const recordBefore = await readLastMigrateRecord(db, {
        engineHint: 'postgres',
      });
      registerVersion(2);
      const cause = new Error('catalog unavailable');
      const handle = new Proxy(db, {
        get(target, key, receiver) {
          if (key === 'getTableSchema')
            return async () => {
              throw cause;
            };
          const value = Reflect.get(target, key, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(migrate(handle)).rejects.toMatchObject({
        name: 'TableSchemaUnreadableError',
        table,
        engine: 'postgres',
        cause,
      });
      expect(await hasColumn('note')).toBe(false);
      expect(
        await readLastMigrateRecord(db, { engineHint: 'postgres' }),
      ).toEqual(recordBefore);
    });

    it('a transaction handle without an inspector refuses a listed relation it cannot describe, and records nothing', async () => {
      registerVersion(1);
      await migrate(db);
      const recordBefore = await readLastMigrateRecord(db, {
        engineHint: 'postgres',
      });
      await db.query(`ALTER TABLE ${table} RENAME TO ${table}_kept`);
      await db.query(`CREATE VIEW ${table} AS SELECT * FROM ${table}_kept`);
      registerVersion(2);

      const attempt = db.transaction?.((tx) =>
        migrate(queryOnly(tx as unknown as DatabaseInterface)),
      );

      await expect(attempt).rejects.toBeInstanceOf(TableSchemaUnreadableError);
      await expect(attempt).rejects.toMatchObject({
        table,
        engine: 'postgres',
      });
      expect(await hasColumn('note')).toBe(false);
      expect(
        await readLastMigrateRecord(db, { engineHint: 'postgres' }),
      ).toEqual(recordBefore);
    });
  },
);
