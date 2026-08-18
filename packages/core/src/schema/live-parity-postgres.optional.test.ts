/**
 * Live-schema parity against a real PostgreSQL database (#2368).
 *
 * SQLite's affinity model hides three things this check depends on: native
 * `uuid`/`jsonb`/`timestamptz` column types, unique constraints materialized
 * as `<table>_key` indexes, and indexes left INVALID by a failed
 * `CREATE INDEX CONCURRENTLY`. An INVALID unique index enforces nothing while
 * still appearing in `pg_indexes`, so the parity check reads `pg_index`
 * directly — that path only exists on this engine and is only provable here.
 *
 * Runs only in the dedicated PostgreSQL shard. The database must be
 * disposable: this suite creates and drops its own prefixed tables.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkLiveSchemaParity } from './live-parity.js';
import type { SchemaDefinition } from './types.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'issue_2368_parity_widgets';

let db: DatabaseInterface | undefined;

function widgetSchema(): Record<string, SchemaDefinition> {
  return {
    [TABLE]: {
      tableName: TABLE,
      columns: {
        id: { type: 'UUID', primaryKey: true, referenceKind: 'id' },
        slug: { type: 'TEXT' },
        context: { type: 'TEXT' },
        tenant_id: { type: 'UUID', referenceKind: 'tenantId' },
        payload: { type: 'JSON' },
        created_at: { type: 'TIMESTAMP' },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  };
}

async function createWidgets(): Promise<void> {
  await db?.query(`
    CREATE TABLE ${TABLE} (
      id uuid PRIMARY KEY,
      slug text,
      context text,
      tenant_id uuid,
      payload jsonb,
      created_at timestamptz
    )`);
}

describe.skipIf(!pgUrl)('live-schema parity (PostgreSQL)', () => {
  beforeAll(async () => {
    db = await getDatabase({ type: 'postgres', url: pgUrl as string });
  });

  afterEach(async () => {
    await db?.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  });

  afterAll(async () => {
    await db?.close?.();
    db = undefined;
  });

  it('accepts native uuid, jsonb, and timestamptz columns as declared', async () => {
    await createWidgets();
    await db?.query(
      `CREATE UNIQUE INDEX ${TABLE}_slug_context_idx ON ${TABLE} (slug, context)`,
    );
    await db?.query(
      `CREATE INDEX ${TABLE}_tenant_id_idx ON ${TABLE} (tenant_id)`,
    );

    const report = await checkLiveSchemaParity({
      db: db as DatabaseInterface,
      schemas: widgetSchema(),
      conflictTargets: {
        [TABLE]: [{ columns: ['slug', 'context'], source: 'Widget' }],
      },
      includeSystemTables: false,
      reportExtraTables: false,
    });

    expect(report.engine).toBe('postgres');
    expect(report.indexIntrospection).toBe('full');
    expect(report.findings).toEqual([]);
  });

  it('accepts a unique CONSTRAINT as the conflict-target index', async () => {
    await createWidgets();
    // A table-level constraint materializes as `<table>_<cols>_key`, which is
    // an index PostgreSQL owns rather than one anybody declared.
    await db?.query(
      `ALTER TABLE ${TABLE} ADD CONSTRAINT ${TABLE}_slug_context_key UNIQUE (slug, context)`,
    );
    await db?.query(
      `CREATE INDEX ${TABLE}_tenant_id_idx ON ${TABLE} (tenant_id)`,
    );

    const report = await checkLiveSchemaParity({
      db: db as DatabaseInterface,
      schemas: widgetSchema(),
      conflictTargets: {
        [TABLE]: [{ columns: ['slug', 'context'], source: 'Widget' }],
      },
      includeSystemTables: false,
      reportExtraTables: false,
    });

    expect(report.findings).toEqual([]);
  });

  it('flags an INVALID index left behind by a failed concurrent build', async () => {
    await createWidgets();
    await db?.query(
      `CREATE UNIQUE INDEX ${TABLE}_slug_context_idx ON ${TABLE} (slug, context)`,
    );
    await db?.query(
      `CREATE INDEX ${TABLE}_tenant_id_idx ON ${TABLE} (tenant_id)`,
    );
    // Simulate the residue of an interrupted CREATE INDEX CONCURRENTLY.
    await db?.query(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = '${TABLE}_tenant_id_idx'::regclass`,
    );

    const report = await checkLiveSchemaParity({
      db: db as DatabaseInterface,
      schemas: widgetSchema(),
      includeSystemTables: false,
      reportExtraTables: false,
    });

    const invalid = report.findings.find(
      (finding) => finding.kind === 'invalid_index',
    );
    expect(invalid?.target).toBe(`${TABLE}_tenant_id_idx`);
    expect(invalid?.severity).toBe('error');
    expect(report.ok).toBe(false);
  });

  it('flags a non-unique conflict target and an unindexed tenant column', async () => {
    await createWidgets();
    await db?.query(
      `CREATE INDEX ${TABLE}_slug_context_idx ON ${TABLE} (slug, context)`,
    );

    const report = await checkLiveSchemaParity({
      db: db as DatabaseInterface,
      schemas: widgetSchema(),
      conflictTargets: {
        [TABLE]: [{ columns: ['slug', 'context'], source: 'Widget' }],
      },
      includeSystemTables: false,
      reportExtraTables: false,
    });

    expect(
      report.findings.find(
        (finding) => finding.kind === 'conflict_target_not_unique',
      )?.severity,
    ).toBe('error');
    expect(
      report.findings.find(
        (finding) =>
          finding.kind === 'unindexed_reference' &&
          finding.target === 'tenant_id',
      ),
    ).toBeDefined();
  });
});
