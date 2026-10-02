/**
 * PostgreSQL lane for smrt-expenses.
 *
 * The schema is created the way a deployment creates it — `migrateSmrtSchemas`,
 * the engine behind `smrt db:migrate` — in a disposable database, then:
 *
 *  1. the migrated columns use the native types the invariants require
 *     (BIGINT money, UUID ids/FKs, TIMESTAMPTZ, BOOLEAN);
 *  2. the duplicate-receipt unique index exists and is UNIQUE;
 *  3. live-schema parity (`smrt db:status --parity`) is clean for the
 *     package's tables and a second migrate is a no-op;
 *  4. the full behaviour suite — review transitions, duplicate receipts,
 *     commitment matching — runs against that migrated database.
 *
 * Named `*.optional.test.ts`: the package's `test:postgres` script runs it
 * through `scripts/run-with-ci-postgres.mjs`; without PostgreSQL it skips.
 */

import { randomUUID } from 'node:crypto';
import {
  type ConflictTargetInput,
  checkLiveSchemaParity,
  getTestDatabase,
  isSmrtCollectionExtendsName,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineExpenseSuite } from './helpers/expense-suite.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

const PACKAGE_TABLES = ['expenses', 'expense_receipts'];

type Closable = { close?: () => Promise<void> };

/** `smrt db:migrate`: one atomic, uniquely named schema sync. */
function dbMigrate(db: DatabaseInterface) {
  return migrateSmrtSchemas({
    db,
    packageName: '@happyvertical/smrt-expenses',
    name: `expenses_${randomUUID().replace(/-/g, '')}`,
    postgresSafe: false,
  });
}

/** The registry's declared conflict targets, as `db:status --parity` reads them. */
function registryConflictTargets(): Record<string, ConflictTargetInput[]> {
  const targets: Record<string, ConflictTargetInput[]> = {};
  for (const className of ObjectRegistry.getQualifiedClassNames()) {
    const isCollection = [
      className,
      ...ObjectRegistry.getInheritanceChain(className),
    ].some((name) =>
      isSmrtCollectionExtendsName(ObjectRegistry.getClass(name)?.extends),
    );
    if (isCollection) continue;
    const tableName = ObjectRegistry.getTableName(className);
    const columns = ObjectRegistry.getConflictColumns(className);
    if (!tableName || !columns || columns.length === 0) continue;
    const bucket = targets[tableName] ?? [];
    bucket.push({ columns, source: className });
    targets[tableName] = bucket;
  }
  return targets;
}

async function columnTypes(
  db: DatabaseInterface,
  table: string,
): Promise<Record<string, string>> {
  const result = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?`,
    table,
  );
  return Object.fromEntries(
    (result.rows as Array<{ column_name: string; data_type: string }>).map(
      (row) => [row.column_name, row.data_type],
    ),
  );
}

describePostgres('expenses on PostgreSQL', () => {
  let admin: DatabaseInterface | undefined;
  let db: DatabaseInterface;
  let databaseName = '';

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL ?? '';
    admin = await getTestDatabase({
      type: 'postgres',
      url: baseUrl,
      classes: [],
      includeSystemTables: false,
    });
    databaseName = `smrt_expenses_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);

    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    // Framework bootstrap only (system tables); application tables come from
    // the migration below, never from the runtime.
    db = await getTestDatabase({
      type: 'postgres',
      url: String(url),
      classes: [],
    });
    const migrated = await dbMigrate(db);
    expect(migrated.applied).toBe(true);
  });

  afterAll(async () => {
    await (db as Closable | undefined)?.close?.();
    if (databaseName) {
      await admin?.query(
        `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
      );
    }
    await (admin as Closable | undefined)?.close?.();
  });

  describe('migrated schema', () => {
    it('uses native money, id, time and flag types', async () => {
      const expenses = await columnTypes(db, 'expenses');
      expect(expenses).toMatchObject({
        id: 'uuid',
        tenant_id: 'uuid',
        amount: 'bigint',
        currency: 'text',
        incurred_on: 'text',
        cost_object_type: 'text',
        cost_object_id: 'text',
        recorded_by_profile_id: 'uuid',
        paid_by_profile_id: 'uuid',
        vendor_id: 'uuid',
        commitment_id: 'uuid',
        commitment_line_id: 'uuid',
        review_status: 'text',
        reviewed_by_profile_id: 'uuid',
        reviewed_at: 'timestamp with time zone',
        duplicate_of_id: 'uuid',
        reimbursable: 'boolean',
        reimbursed_at: 'timestamp with time zone',
      });

      const receipts = await columnTypes(db, 'expense_receipts');
      expect(receipts).toMatchObject({
        id: 'uuid',
        tenant_id: 'uuid',
        expense_id: 'uuid',
        asset_id: 'uuid',
        uploaded_by_profile_id: 'uuid',
        byte_count: 'bigint',
        content_sha256: 'text',
      });
    });

    it('enforces one copy of a file per expense with a NULL-safe unique index', async () => {
      const result = await db.query(
        `SELECT i.indisunique AS is_unique, i.indisvalid AS is_valid,
                array_to_string(array_agg(a.attname ORDER BY k.ord), ',') AS cols
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_attribute a
             ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE c.relname = 'expense_receipts_expense_sha256_key'
          GROUP BY i.indisunique, i.indisvalid`,
      );
      expect(result.rows).toEqual([
        {
          is_unique: true,
          is_valid: true,
          cols: 'expense_id,content_sha256',
        },
      ]);
    });

    it('is in live-schema parity, and a second migrate is a no-op', async () => {
      const report = await checkLiveSchemaParity({
        db,
        schemas: ObjectRegistry.getAllSchemasAsDefinitions(),
        conflictTargets: registryConflictTargets(),
        includeSystemTables: false,
        engineHint: 'postgres',
      });
      const ours = report.findings.filter(
        (finding) =>
          PACKAGE_TABLES.includes(finding.table) && finding.severity !== 'info',
      );
      expect(ours).toEqual([]);
      expect(report.ok).toBe(true);

      const again = await dbMigrate(db);
      expect(again.applied).toBe(false);
      expect(again.statements).toEqual([]);
    });
  });

  describe('behaviour', () => {
    defineExpenseSuite(() => db);
  });
});
