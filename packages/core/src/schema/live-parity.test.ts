/**
 * Live-schema parity check against a real SQLite database (#2368).
 *
 * The point of this check is that it does NOT trust the manifest as the index
 * oracle: a database can match its manifest exactly and still be missing every
 * tenant and foreign-key index (#2356) or carry a conflict target that no
 * UNIQUE index enforces (#1165). These tests therefore drive a deliberately
 * drifted schema and assert on the finding classes, then re-run against the
 * repaired schema and assert it reports clean.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { getSystemTableDDL } from '../system/schema.js';
import {
  checkLiveSchemaParity,
  type LiveParityFinding,
  type LiveParityFindingKind,
  LiveSchemaParityError,
  parseIndexDefColumns,
} from './live-parity.js';
import type { SchemaDefinition } from './types.js';

let db: DatabaseProvider | undefined;

async function openDatabase(): Promise<DatabaseProvider> {
  db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  return db;
}

afterEach(async () => {
  if (db && typeof db.close === 'function') {
    try {
      await db.close();
    } catch {
      // in-memory databases occasionally reject a double close
    }
  }
  db = undefined;
});

/** The declared shape of a tenant-scoped table with two reference columns. */
function widgetSchema(): Record<string, SchemaDefinition> {
  return {
    widgets: {
      tableName: 'widgets',
      columns: {
        id: { type: 'UUID', primaryKey: true, referenceKind: 'id' },
        slug: { type: 'TEXT' },
        context: { type: 'TEXT' },
        tenant_id: { type: 'TEXT', referenceKind: 'tenantId' },
        owner_id: {
          type: 'TEXT',
          referenceKind: 'foreignKey',
          foreignKey: { table: 'owners', column: 'id' },
        },
        price: { type: 'REAL' },
        description: { type: 'TEXT' },
      },
      indexes: [
        {
          name: 'widgets_slug_context_idx',
          columns: ['slug', 'context'],
          unique: true,
        },
        { name: 'widgets_price_idx', columns: ['price'] },
      ],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  };
}

function find(
  findings: LiveParityFinding[],
  kind: LiveParityFindingKind,
  target?: string,
): LiveParityFinding | undefined {
  return findings.find(
    (finding) =>
      finding.kind === kind &&
      (target === undefined || finding.target === target),
  );
}

describe('checkLiveSchemaParity (application tables)', () => {
  it('reports the #2356 unindexed-tenant class and the FK-index class', async () => {
    const database = await openDatabase();
    // A schema that a manifest-oracle diff calls "in sync": every declared
    // index is present, but nothing indexes the tenant or the foreign key.
    await database.query(`
      CREATE TABLE widgets (
        id TEXT PRIMARY KEY,
        slug TEXT,
        context TEXT,
        tenant_id TEXT,
        owner_id TEXT,
        price REAL,
        description TEXT
      )`);
    await database.query(
      `CREATE UNIQUE INDEX widgets_slug_context_idx ON widgets(slug, context)`,
    );
    await database.query(`CREATE INDEX widgets_price_idx ON widgets(price)`);

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: widgetSchema(),
      conflictTargets: {
        widgets: [{ columns: ['slug', 'context'], source: 'Widget' }],
      },
      includeSystemTables: false,
    });

    const unindexed = report.findings.filter(
      (finding) => finding.kind === 'unindexed_reference',
    );
    expect(unindexed.map((finding) => finding.target).sort()).toEqual([
      'owner_id',
      'tenant_id',
    ]);
    expect(unindexed.every((finding) => finding.severity === 'warning')).toBe(
      true,
    );
    // Coverage gaps are not correctness failures; the run still has no errors.
    expect(report.counts.error).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('reports missing columns, type drift, and orphan NOT NULL columns', async () => {
    const database = await openDatabase();
    await database.query(`
      CREATE TABLE widgets (
        id TEXT PRIMARY KEY,
        slug TEXT,
        context TEXT,
        tenant_id TEXT,
        owner_id TEXT,
        price TEXT,
        legacy_label TEXT NOT NULL
      )`);
    await database.query(
      `CREATE UNIQUE INDEX widgets_slug_context_idx ON widgets(slug, context)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: widgetSchema(),
      includeSystemTables: false,
    });

    const missingColumn = find(
      report.findings,
      'missing_column',
      'description',
    );
    expect(missingColumn?.severity).toBe('error');

    const typeDrift = find(report.findings, 'column_type_drift', 'price');
    expect(typeDrift?.details).toEqual({ expected: 'REAL', actual: 'TEXT' });

    const orphan = find(report.findings, 'extra_column', 'legacy_label');
    expect(orphan?.severity).toBe('error');
    expect(orphan?.message).toContain('every framework insert');

    // A UUID primary key stored as TEXT on SQLite is the documented R11
    // tolerance, not drift.
    expect(find(report.findings, 'column_type_drift', 'id')).toBeUndefined();

    expect(report.ok).toBe(false);
  });

  it('flags a conflict target whose live index is not unique', async () => {
    const database = await openDatabase();
    await database.query(`
      CREATE TABLE widgets (
        id TEXT PRIMARY KEY,
        slug TEXT,
        context TEXT,
        tenant_id TEXT,
        owner_id TEXT,
        price REAL,
        description TEXT
      )`);
    // The #1165 failure mode: declared UNIQUE, materialized non-unique.
    await database.query(
      `CREATE INDEX widgets_slug_context_idx ON widgets(slug, context)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: widgetSchema(),
      conflictTargets: {
        widgets: [{ columns: ['slug', 'context'], source: 'Widget' }],
      },
      includeSystemTables: false,
    });

    const finding = find(report.findings, 'conflict_target_not_unique');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('declared by Widget');
    expect(finding?.target).toBe('widgets_slug_context_idx');
    // The same index must not also be reported as a missing declared index.
    expect(
      find(report.findings, 'missing_index', 'widgets_slug_context_idx'),
    ).toBeUndefined();
  });

  it('flags a conflict target with no index at all', async () => {
    const database = await openDatabase();
    await database.query(
      `CREATE TABLE widgets (id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT, owner_id TEXT, price REAL, description TEXT)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: widgetSchema(),
      conflictTargets: {
        widgets: [{ columns: ['context', 'slug'], source: 'Widget' }],
      },
      includeSystemTables: false,
    });

    const finding = find(report.findings, 'conflict_target_unindexed');
    expect(finding?.severity).toBe('error');
    expect(finding?.table).toBe('widgets');
  });

  it('does not accept a partial unique index as a conflict target', async () => {
    const database = await openDatabase();
    await database.query(
      `CREATE TABLE widgets (id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT, owner_id TEXT, price REAL, description TEXT)`,
    );
    // A partial unique index constrains only the rows its predicate selects,
    // so it cannot arbitrate `ON CONFLICT (slug, context)`.
    await database.query(
      `CREATE UNIQUE INDEX widgets_slug_context_idx ON widgets(slug, context) WHERE description IS NOT NULL`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: widgetSchema(),
      conflictTargets: {
        widgets: [{ columns: ['slug', 'context'], source: 'Widget' }],
      },
      includeSystemTables: false,
    });

    const finding = find(report.findings, 'conflict_target_unindexed');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('partial index');
    expect(finding?.target).toBe('widgets_slug_context_idx');
  });

  it('flags a declared-unique column that nothing enforces', async () => {
    const database = await openDatabase();
    await database.query(
      `CREATE TABLE profiles (id TEXT PRIMARY KEY, email TEXT)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: {
        profiles: {
          tableName: 'profiles',
          columns: {
            id: { type: 'TEXT', primaryKey: true, referenceKind: 'id' },
            email: { type: 'TEXT', unique: true },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      includeSystemTables: false,
    });

    expect(
      find(report.findings, 'unique_constraint_missing', 'email')?.severity,
    ).toBe('error');
  });

  it('reports a declared index whose shape drifted', async () => {
    const database = await openDatabase();
    await database.query(
      `CREATE TABLE widgets (id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT, owner_id TEXT, price REAL, description TEXT)`,
    );
    await database.query(
      `CREATE UNIQUE INDEX widgets_slug_context_idx ON widgets(slug, context)`,
    );
    // Declared on (price), materialized on (description).
    await database.query(
      `CREATE INDEX widgets_price_idx ON widgets(description)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: widgetSchema(),
      includeSystemTables: false,
    });

    const drift = find(report.findings, 'missing_index', 'widgets_price_idx');
    expect(drift?.message).toContain('shape drifted');
  });

  it('reports a missing table and an unexplained live table', async () => {
    const database = await openDatabase();
    await database.query(`CREATE TABLE leftovers (id TEXT PRIMARY KEY)`);

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: widgetSchema(),
      includeSystemTables: false,
    });

    expect(find(report.findings, 'missing_table')?.table).toBe('widgets');
    expect(find(report.findings, 'extra_table')?.table).toBe('leftovers');
    expect(find(report.findings, 'extra_table')?.severity).toBe('info');
    expect(report.tablesMissing).toBe(1);
    expect(report.tablesChecked).toBe(0);
  });

  it('reports clean once the schema is repaired', async () => {
    const database = await openDatabase();
    await database.query(`
      CREATE TABLE widgets (
        id TEXT PRIMARY KEY,
        slug TEXT,
        context TEXT,
        tenant_id TEXT,
        owner_id TEXT,
        price REAL,
        description TEXT
      )`);
    await database.query(
      `CREATE UNIQUE INDEX widgets_slug_context_idx ON widgets(slug, context)`,
    );
    await database.query(`CREATE INDEX widgets_price_idx ON widgets(price)`);
    await database.query(
      `CREATE INDEX widgets_tenant_id_idx ON widgets(tenant_id)`,
    );
    await database.query(
      `CREATE INDEX widgets_owner_id_idx ON widgets(owner_id)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: widgetSchema(),
      conflictTargets: {
        widgets: [{ columns: ['slug', 'context'], source: 'Widget' }],
      },
      includeSystemTables: false,
    });

    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.indexIntrospection).toBe('full');
    expect(report.tablesChecked).toBe(1);
  });
});

describe('checkLiveSchemaParity (system tables)', () => {
  async function createSystemTables(database: DatabaseProvider): Promise<void> {
    for (const ddl of getSystemTableDDL('sqlite')) {
      for (const statement of ddl.split(';')) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) {
          await database.query(trimmed);
        }
      }
    }
  }

  it('reports a fully initialized system schema as clean', async () => {
    const database = await openDatabase();
    await createSystemTables(database);

    const report = await checkLiveSchemaParity({ db: database });

    expect(report.systemTablesIncluded).toBe(true);
    expect(report.tablesChecked).toBe(11);
    expect(report.findings).toEqual([]);
  });

  it('detects a dropped system index the manifest differ never sees', async () => {
    const database = await openDatabase();
    await createSystemTables(database);
    await database.query(`DROP INDEX idx_smrt_dispatch_status`);

    const report = await checkLiveSchemaParity({ db: database });

    const finding = find(
      report.findings,
      'missing_index',
      'idx_smrt_dispatch_status',
    );
    expect(finding?.origin).toBe('system');
    expect(finding?.table).toBe('_smrt_dispatch');
    expect(finding?.recommendation).toContain('system-table initialization');
  });

  it('detects a system table missing its inline UNIQUE constraint', async () => {
    const database = await openDatabase();
    await createSystemTables(database);
    // A legacy `_smrt_embeddings` created before the uniqueness rule: the
    // upsert target silently duplicates rows instead of updating them.
    await database.query(`DROP TABLE _smrt_embeddings`);
    await database.query(`
      CREATE TABLE _smrt_embeddings (
        id TEXT PRIMARY KEY,
        object_class TEXT NOT NULL,
        object_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        provider TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

    const report = await checkLiveSchemaParity({ db: database });

    const finding = find(report.findings, 'conflict_target_unindexed');
    expect(finding?.table).toBe('_smrt_embeddings');
    expect(finding?.severity).toBe('error');
    expect(report.ok).toBe(false);
  });

  it('detects a missing system table', async () => {
    const database = await openDatabase();
    await createSystemTables(database);
    await database.query(`DROP TABLE _smrt_changes`);

    const report = await checkLiveSchemaParity({ db: database });

    const finding = find(report.findings, 'missing_table');
    expect(finding?.table).toBe('_smrt_changes');
    expect(finding?.origin).toBe('system');
  });
});

describe('checkLiveSchemaParity failure modes', () => {
  it('fails closed when the adapter cannot describe tables', async () => {
    const database = await openDatabase();
    await database.query(`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);

    const blindDb = {
      url: database.url,
      query: database.query.bind(database),
    } as unknown as DatabaseProvider;

    await expect(
      checkLiveSchemaParity({
        db: blindDb,
        schemas: widgetSchema(),
        includeSystemTables: false,
      }),
    ).rejects.toBeInstanceOf(LiveSchemaParityError);
  });

  it('fails closed when the database cannot be queried', async () => {
    const brokenDb = {
      url: 'sqlite://broken',
      query: async () => {
        throw new Error('connection refused');
      },
      getTableSchema: async () => null,
    } as unknown as DatabaseProvider;

    await expect(
      checkLiveSchemaParity({ db: brokenDb, includeSystemTables: false }),
    ).rejects.toThrow(/connection refused/);
  });
});

describe('DuckDB index introspection', () => {
  /**
   * A DuckDB-shaped fake. Uniqueness on this engine lives almost entirely in
   * `duckdb_constraints()` (DuckDB requires an inline UNIQUE constraint for
   * upsert), so losing that catalog while keeping `duckdb_indexes()` would make
   * every conflict target and unique column look unenforced.
   */
  function duckDb(options: { constraintsFail: boolean }): DatabaseProvider {
    return {
      url: 'analytics.duckdb',
      query: async (sql: string) => {
        if (sql.includes('duckdb_constraints')) {
          if (options.constraintsFail) {
            throw new Error('duckdb_constraints() unavailable');
          }
          return {
            rows: [
              {
                table_name: 'widgets',
                constraint_type: 'UNIQUE',
                constraint_column_names: ['slug', 'context'],
              },
            ],
          };
        }
        if (sql.includes('duckdb_indexes')) return { rows: [] };
        if (sql.includes('sqlite_master'))
          return { rows: [{ name: 'widgets' }] };
        return { rows: [] };
      },
      getTableSchema: async () => ({
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          slug: { type: 'TEXT' },
          context: { type: 'TEXT' },
        },
        indexes: [],
        foreignKeys: [],
      }),
    } as unknown as DatabaseProvider;
  }

  const duckDbSchema: Record<string, SchemaDefinition> = {
    widgets: {
      tableName: 'widgets',
      columns: {
        id: { type: 'TEXT', primaryKey: true, referenceKind: 'id' },
        slug: { type: 'TEXT' },
        context: { type: 'TEXT' },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  };

  it('reads uniqueness from the constraint catalog', async () => {
    const report = await checkLiveSchemaParity({
      db: duckDb({ constraintsFail: false }),
      schemas: duckDbSchema,
      conflictTargets: {
        widgets: [{ columns: ['slug', 'context'], source: 'Widget' }],
      },
      includeSystemTables: false,
      engineHint: 'duckdb',
    });

    expect(report.indexIntrospection).toBe('full');
    expect(report.findings).toEqual([]);
  });

  it('skips every index check when the constraint catalog is unreadable', async () => {
    const report = await checkLiveSchemaParity({
      db: duckDb({ constraintsFail: true }),
      schemas: duckDbSchema,
      conflictTargets: {
        widgets: [{ columns: ['slug', 'context'], source: 'Widget' }],
      },
      includeSystemTables: false,
      engineHint: 'duckdb',
    });

    // Partial metadata must never manufacture an error: with constraints
    // unreadable the conflict target would look unenforced on a correct
    // database.
    expect(report.indexIntrospection).toBe('unavailable');
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('parseIndexDefColumns', () => {
  it('extracts plain columns from a PostgreSQL index definition', () => {
    expect(
      parseIndexDefColumns(
        'CREATE UNIQUE INDEX widgets_slug_context_idx ON public.widgets USING btree (slug, context)',
      ),
    ).toEqual(['slug', 'context']);
  });

  it('drops operator classes, sort modifiers, and quoting', () => {
    expect(
      parseIndexDefColumns(
        'CREATE INDEX i ON public.t USING btree ("Name" text_pattern_ops, created_at DESC NULLS LAST)',
      ),
    ).toEqual(['Name', 'created_at']);
  });

  it('keeps an expression component intact', () => {
    expect(
      parseIndexDefColumns(
        `CREATE INDEX i ON public.t USING btree (((_meta_data ->> 'sku'::text))) WHERE (x = 1)`,
      ),
    ).toEqual([`((_meta_data ->> 'sku'::text))`]);
  });
});
