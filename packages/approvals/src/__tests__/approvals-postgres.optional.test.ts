/**
 * PostgreSQL lane for smrt-approvals.
 *
 * The schema is created the way a deployment creates it (`migrateSmrtSchemas`,
 * the engine behind `smrt db:migrate`) in a disposable database; then the
 * columns are native, the ledger keys are unique, the schema is in live
 * parity, and the whole behaviour suite (including the concurrency cases,
 * which run truly in parallel on pooled connections here) runs against it.
 *
 * Named `*.optional.test.ts`: the package's `test:postgres` script runs it
 * through `scripts/run-with-ci-postgres.mjs`; without PostgreSQL it skips.
 */

import { randomUUID } from 'node:crypto';
import {
  checkLiveSchemaParity,
  getTestDatabase,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import {
  type DatabaseInterface,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineApprovalSuite } from './helpers/approval-suite.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

const PACKAGE_TABLES = [
  'approval_requests',
  'approval_events',
  'approval_policies',
];

type Closable = { close?: () => Promise<void> };

function dbMigrate(db: DatabaseInterface) {
  return migrateSmrtSchemas({
    db,
    packageName: '@happyvertical/smrt-approvals',
    name: `approvals_${randomUUID().replace(/-/g, '')}`,
    postgresSafe: false,
  });
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

describePostgres('approvals on PostgreSQL', () => {
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
    databaseName = `smrt_approvals_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    // Framework bootstrap only; application tables come from the migration.
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
    it('uses native id, integer, and time types', async () => {
      expect(await columnTypes(db, 'approval_requests')).toMatchObject({
        id: 'uuid',
        tenant_id: 'uuid',
        required_approvals: 'bigint',
        approval_count: 'bigint',
        version: 'bigint',
        expires_at: 'timestamp with time zone',
        decided_at: 'timestamp with time zone',
        consumed_at: 'timestamp with time zone',
      });
      expect(await columnTypes(db, 'approval_events')).toMatchObject({
        id: 'uuid',
        tenant_id: 'uuid',
        request_id: 'uuid',
        sequence: 'bigint',
        occurred_at: 'timestamp with time zone',
      });
      expect(await columnTypes(db, 'approval_policies')).toMatchObject({
        tenant_id: 'uuid',
        required_approvals: 'bigint',
        ttl_ms: 'bigint',
      });
    });

    it('is in live-schema parity, and a second migrate is a no-op', async () => {
      const report = await checkLiveSchemaParity({
        db,
        schemas: ObjectRegistry.getAllSchemasAsDefinitions(),
        includeSystemTables: false,
        engineHint: 'postgres',
      });
      const ours = report.findings.filter(
        (finding) =>
          PACKAGE_TABLES.includes(finding.table) && finding.severity !== 'info',
      );
      expect(ours).toEqual([]);
      const again = await dbMigrate(db);
      expect(again.applied).toBe(false);
    });
  });

  describe('behaviour', () => {
    defineApprovalSuite(() => db);
  });
});
