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
import { SYSTEM_TABLE_NAMES } from './system-table-shapes.js';
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
  it('advises on legacy PostgreSQL int4 without turning it into type drift', async () => {
    const database = {
      url: 'postgres://localhost/test',
      query: async (sql: string, ...params: unknown[]) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'widgets' }] };
        }
        if (sql.includes('information_schema.columns') && params.length > 0) {
          return {
            rows: [{ column_name: 'attempts', data_type: 'integer' }],
          };
        }
        if (sql.startsWith('SELECT COUNT(*) AS row_count')) {
          return { rows: [{ row_count: '4' }] };
        }
        return { rows: [] };
      },
      getTableSchema: async () => ({
        columns: {
          attempts: {
            type: 'integer',
            notNull: false,
            primaryKey: false,
          },
        },
      }),
    } as unknown as DatabaseProvider;

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: {
        widgets: {
          tableName: 'widgets',
          columns: { attempts: { type: 'INTEGER' } },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      includeSystemTables: false,
    });

    const finding = find(report.findings, 'legacy_integer_width', 'attempts');
    expect(finding).toMatchObject({
      severity: 'warning',
      table: 'widgets',
      details: { actual: 'integer', expected: 'BIGINT', rowCount: 4 },
    });
    expect(finding?.recommendation).toContain('db:migrate-int8');
    expect(report.ok).toBe(true);
  });

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

    // A reference-lead index (tenant_id, owner_id) is no longer silently
    // exempted from `extra_index` (#2751): a repaired/clean schema declares
    // it explicitly rather than relying on live-parity to stay quiet about it.
    const schema = widgetSchema();
    schema.widgets.indexes.push(
      { name: 'widgets_tenant_id_idx', columns: ['tenant_id'] },
      { name: 'widgets_owner_id_idx', columns: ['owner_id'] },
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: schema,
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

  it('reports an undeclared reference-lead index as info-severity drift (#2751)', async () => {
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
    // Undeclared single-column indexes led by reference columns. live-parity
    // used to treat these as intentional policy and never report them, while
    // `migrations/differ.ts --drop-indexes` would drop them — the two
    // surfaces disagreed about what counted as drift. The repository owner
    // decided these are drift: report them so an operator sees the signal
    // before reaching for `--drop-indexes` (#2751).
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

    const extraIndexNames = report.findings
      .filter((finding) => finding.kind === 'extra_index')
      .map((finding) => finding.target)
      .sort();
    expect(extraIndexNames).toEqual([
      'widgets_owner_id_idx',
      'widgets_tenant_id_idx',
    ]);
    expect(
      report.findings
        .filter((finding) => finding.kind === 'extra_index')
        .every((finding) => finding.severity === 'info'),
    ).toBe(true);
    expect(
      report.findings.find(
        (finding) => finding.target === 'widgets_tenant_id_idx',
      )?.recommendation,
    ).toBe(
      'Declare it so a rebuilt database keeps it, or drop it if it is obsolete.',
    );
  });
});

describe('checkLiveSchemaParity rename_data_pending (#2752)', () => {
  async function createRenameTable(
    database: DatabaseProvider,
    extraColumns: string,
  ): Promise<void> {
    await database.query(`
      CREATE TABLE widgets (
        id TEXT PRIMARY KEY,
        new_slug TEXT
        ${extraColumns}
      )`);
  }

  it('flags a same-type (text -> text) pending rename', async () => {
    const database = await openDatabase();
    await createRenameTable(database, ', old_slug TEXT');
    await database.query(
      `INSERT INTO widgets (id, new_slug, old_slug) VALUES ('1', NULL, 'hello')`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: {
        widgets: {
          tableName: 'widgets',
          columns: {
            id: { type: 'UUID', primaryKey: true },
            new_slug: { type: 'TEXT' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      includeSystemTables: false,
      reportExtraTables: false,
    });

    const finding = find(report.findings, 'rename_data_pending', 'new_slug');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.details).toEqual({ candidates: ['old_slug'] });
    expect(finding?.message).toContain('old_slug');
  });

  it('does not flag when the declared column already holds data', async () => {
    const database = await openDatabase();
    await createRenameTable(database, ', old_slug TEXT');
    await database.query(
      `INSERT INTO widgets (id, new_slug, old_slug) VALUES ('1', 'already-set', 'hello')`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: {
        widgets: {
          tableName: 'widgets',
          columns: {
            id: { type: 'UUID', primaryKey: true },
            new_slug: { type: 'TEXT' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      includeSystemTables: false,
      reportExtraTables: false,
    });

    expect(find(report.findings, 'rename_data_pending')).toBeUndefined();
  });

  it('does not flag when the candidate (old) column is also empty', async () => {
    const database = await openDatabase();
    await createRenameTable(database, ', old_slug TEXT');
    await database.query(
      `INSERT INTO widgets (id, new_slug, old_slug) VALUES ('1', NULL, NULL)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: {
        widgets: {
          tableName: 'widgets',
          columns: {
            id: { type: 'UUID', primaryKey: true },
            new_slug: { type: 'TEXT' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      includeSystemTables: false,
      reportExtraTables: false,
    });

    expect(find(report.findings, 'rename_data_pending')).toBeUndefined();
  });

  it('lists every candidate rather than guessing when several columns qualify', async () => {
    const database = await openDatabase();
    await createRenameTable(database, ', old_slug_a TEXT, old_slug_b TEXT');
    await database.query(
      `INSERT INTO widgets (id, new_slug, old_slug_a, old_slug_b) VALUES ('1', NULL, 'a-value', 'b-value')`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: {
        widgets: {
          tableName: 'widgets',
          columns: {
            id: { type: 'UUID', primaryKey: true },
            new_slug: { type: 'TEXT' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      includeSystemTables: false,
      reportExtraTables: false,
    });

    const finding = find(report.findings, 'rename_data_pending', 'new_slug');
    expect(finding).toBeDefined();
    expect(finding?.details).toEqual({
      candidates: ['old_slug_a', 'old_slug_b'],
    });
    expect(finding?.message).toContain('ambiguous');
    expect(finding?.recommendation).toContain('will not guess');
  });

  it('does not flag an incompatible type as a rename candidate', async () => {
    const database = await openDatabase();
    await createRenameTable(database, ', old_count INTEGER');
    await database.query(
      `INSERT INTO widgets (id, new_slug, old_count) VALUES ('1', NULL, 7)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: {
        widgets: {
          tableName: 'widgets',
          columns: {
            id: { type: 'UUID', primaryKey: true },
            new_slug: { type: 'TEXT' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      includeSystemTables: false,
      reportExtraTables: false,
    });

    expect(find(report.findings, 'rename_data_pending')).toBeUndefined();
  });

  // SQLite has no native `uuid` type (a manifest UUID column maps to TEXT
  // there), so the text->uuid shape-gated branch only ever exercises on
  // PostgreSQL. Drive it with a mocked PostgreSQL adapter, matching the
  // `legacy_integer_width` test above.
  function postgresRenameDatabase(options: {
    oldColumnEmpty?: boolean;
    invalidUuidCount?: number;
  }): DatabaseProvider {
    const { oldColumnEmpty = false, invalidUuidCount = 0 } = options;
    return {
      url: 'postgres://localhost/test',
      query: async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'widgets' }] };
        }
        if (sql.includes('FROM pg_index')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT 1 AS present')) {
          if (sql.includes('"new_id"')) return { rows: [] };
          if (sql.includes('"old_id"')) {
            return oldColumnEmpty ? { rows: [] } : { rows: [{ present: 1 }] };
          }
          return { rows: [] };
        }
        if (sql.includes('invalid_count')) {
          return { rows: [{ invalid_count: invalidUuidCount }] };
        }
        return { rows: [] };
      },
      getTableSchema: async () => ({
        columns: {
          id: { type: 'uuid', notNull: true, primaryKey: true },
          new_id: { type: 'uuid', notNull: false, primaryKey: false },
          old_id: { type: 'text', notNull: false, primaryKey: false },
        },
      }),
    } as unknown as DatabaseProvider;
  }

  function renameSchema(): Record<string, SchemaDefinition> {
    return {
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          new_id: { type: 'UUID', referenceKind: 'foreignKey' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };
  }

  it('flags a text -> uuid pending rename when every value is UUID-shaped', async () => {
    const database = postgresRenameDatabase({ invalidUuidCount: 0 });

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: renameSchema(),
      includeSystemTables: false,
      reportExtraTables: false,
    });

    const finding = find(report.findings, 'rename_data_pending', 'new_id');
    expect(finding).toBeDefined();
    expect(finding?.details).toEqual({ candidates: ['old_id'] });
  });

  it('does not flag a text -> uuid rename when the old column has non-UUID-shaped values', async () => {
    const database = postgresRenameDatabase({ invalidUuidCount: 3 });

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: renameSchema(),
      includeSystemTables: false,
      reportExtraTables: false,
    });

    expect(find(report.findings, 'rename_data_pending')).toBeUndefined();
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
    expect(report.tablesChecked).toBe(SYSTEM_TABLE_NAMES.length);
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

/**
 * #2770 — REAL and DOUBLE PRECISION both fold into `normalizeSqlType`'s
 * shared 'REAL' bucket, so single- vs double-precision drift is invisible to
 * the ordinary `column_type_drift` check above. SQLite's dynamic typing lets
 * a table be hand-created with an arbitrary type name, which is enough to
 * reproduce the narrowing direction (declared REAL, live DOUBLE PRECISION)
 * without a real PostgreSQL server; the widening direction and the
 * PostgreSQL-native "real"/"double precision" spellings are covered against
 * a live server in `issue-2770-2771-2772-postgres.optional.test.ts`.
 */
describe('checkLiveSchemaParity float-width drift (#2770)', () => {
  const priceSchema = (): Record<string, SchemaDefinition> => ({
    products: {
      tableName: 'products',
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        price: { type: 'REAL' },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  });

  // Review finding: SQLite stores every real as an 8-byte double regardless
  // of the declared type name, so there is no narrowing and no repair path
  // (the differ's own float check is gated `postgres || duckdb` — see
  // `differ.ts`). Flagging this on SQLite, as an earlier revision did, would
  // be a permanent, unclearable warning for a distinction that has no
  // meaning there — the same class of bug already fixed for #2772's
  // JSON-vs-TEXT warning below. SQLite's dynamic typing is only used here to
  // confirm the check stays silent even though the live type name alone
  // would otherwise look like narrowing.
  it('does not flag SQLite: there is no narrowing (or a repair path) on a dynamically-typed engine', async () => {
    const database = await openDatabase();
    await database.query(
      `CREATE TABLE products (id TEXT PRIMARY KEY, price DOUBLE PRECISION)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: priceSchema(),
      includeSystemTables: false,
    });

    expect(find(report.findings, 'column_type_drift', 'price')).toBeUndefined();
  });

  // The narrowing direction (a real repair concern on an engine with fixed
  // float widths) is covered on a DuckDB-shaped mock instead, mirroring how
  // `differ.test.ts` already tests DuckDB narrowing without a live server.
  it('flags a declared REAL column backed by a wider live type on DuckDB', async () => {
    const duckDb = {
      url: 'analytics.duckdb',
      query: async (sql: string) => {
        if (sql.includes('sqlite_master'))
          return { rows: [{ name: 'products' }] };
        if (sql.includes('duckdb_indexes')) return { rows: [] };
        if (sql.includes('duckdb_constraints')) return { rows: [] };
        return { rows: [] };
      },
      getTableSchema: async () => ({
        tableName: 'products',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          price: { type: 'DOUBLE', notNull: false },
        },
        indexes: [],
        foreignKeys: [],
      }),
    } as unknown as DatabaseProvider;

    const report = await checkLiveSchemaParity({
      db: duckDb,
      schemas: priceSchema(),
      includeSystemTables: false,
      engineHint: 'duckdb',
    });

    const drift = find(report.findings, 'column_type_drift', 'price');
    expect(drift?.severity).toBe('warning');
    expect(drift?.recommendation).toContain('Narrowing');
    expect(drift?.details).toEqual({
      expected: 'REAL',
      actual: 'DOUBLE',
    });
    expect(report.counts.error).toBe(0);
  });

  // Companion regression to the DuckDB narrowing test above: DuckDB's
  // information_schema normalizes REAL/FLOAT4 to the bare string "FLOAT"
  // (never "REAL"), so a converged column must not misreport as drift.
  it('does not flag a converged DuckDB REAL column reporting live type FLOAT', async () => {
    const duckDb = {
      url: 'analytics.duckdb',
      query: async (sql: string) => {
        if (sql.includes('sqlite_master'))
          return { rows: [{ name: 'products' }] };
        if (sql.includes('duckdb_indexes')) return { rows: [] };
        if (sql.includes('duckdb_constraints')) return { rows: [] };
        return { rows: [] };
      },
      getTableSchema: async () => ({
        tableName: 'products',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          price: { type: 'FLOAT', notNull: false },
        },
        indexes: [],
        foreignKeys: [],
      }),
    } as unknown as DatabaseProvider;

    const report = await checkLiveSchemaParity({
      db: duckDb,
      schemas: priceSchema(),
      includeSystemTables: false,
      engineHint: 'duckdb',
    });

    expect(find(report.findings, 'column_type_drift', 'price')).toBeUndefined();
  });

  it('does not flag a column whose live type already matches', async () => {
    const database = await openDatabase();
    await database.query(
      `CREATE TABLE products (id TEXT PRIMARY KEY, price REAL)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: priceSchema(),
      includeSystemTables: false,
    });

    expect(find(report.findings, 'column_type_drift', 'price')).toBeUndefined();
  });

  it('does not flag DECIMAL/NUMERIC columns still tolerated by the general REAL bucket', async () => {
    const database = await openDatabase();
    await database.query(
      `CREATE TABLE products (id TEXT PRIMARY KEY, price NUMERIC)`,
    );

    const report = await checkLiveSchemaParity({
      db: database,
      schemas: priceSchema(),
      includeSystemTables: false,
    });

    // NUMERIC has no fixed binary width, so `floatPrecisionOf` returns null
    // for it and the #2770 check must stay silent — this is pre-existing
    // (#2361-era) tolerance, not something this feature should disturb.
    expect(find(report.findings, 'column_type_drift', 'price')).toBeUndefined();
  });
});

/**
 * #2772 — the JSON-vs-TEXT warning is only actionable on PostgreSQL, the
 * only engine `differ.ts`'s `jsonUpgradeCandidate` gate can converge (see
 * `differ.ts`, `this.engine === 'postgres'`). The positive path (PostgreSQL,
 * a live text column backed by a declared JSON field) is covered against a
 * real server by the `tag_aliases` fixture in
 * `issue-2770-2771-2772-postgres.optional.test.ts`; this only needs to
 * confirm the warning stays silent on an engine with no repair path.
 */
describe('checkLiveSchemaParity JSON-vs-TEXT warning is engine-gated (#2772)', () => {
  it('does not flag a legacy text column on DuckDB, which has no jsonb repair path', async () => {
    const duckDb = {
      url: 'analytics.duckdb',
      query: async (sql: string) => {
        if (sql.includes('sqlite_master'))
          return { rows: [{ name: 'tag_aliases' }] };
        if (sql.includes('duckdb_indexes')) return { rows: [] };
        if (sql.includes('duckdb_constraints')) return { rows: [] };
        return { rows: [] };
      },
      getTableSchema: async () => ({
        tableName: 'tag_aliases',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          _meta_data: { type: 'TEXT', notNull: false },
        },
        indexes: [],
        foreignKeys: [],
      }),
    } as unknown as DatabaseProvider;

    const schema: Record<string, SchemaDefinition> = {
      tag_aliases: {
        tableName: 'tag_aliases',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          _meta_data: { type: 'JSON' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const report = await checkLiveSchemaParity({
      db: duckDb,
      schemas: schema,
      includeSystemTables: false,
      engineHint: 'duckdb',
    });

    expect(
      find(report.findings, 'column_type_drift', '_meta_data'),
    ).toBeUndefined();
  });
});

/**
 * #2772 review follow-up (final full-diff pass 4) — the uuid/text `info`
 * finding's only repair path is `smrt db:migrate-uuid`, which is gated
 * PostgreSQL-only (`cli/src/commands/db-migrate-uuid.ts`, `runConvert = ... &&
 * isPostgres`). On DuckDB there is no conversion path for this pairing, so
 * the finding must stay silent there — the same class of fix already applied
 * to the jsonb (#2772) and float-width (#2770) checks above.
 */
describe('checkLiveSchemaParity uuid/text info finding is engine-gated (#2772)', () => {
  it('does not flag a structural id column on DuckDB, which has no db:migrate-uuid repair path', async () => {
    const duckDb = {
      url: 'analytics.duckdb',
      query: async (sql: string) => {
        if (sql.includes('sqlite_master'))
          return { rows: [{ name: 'widgets' }] };
        if (sql.includes('duckdb_indexes')) return { rows: [] };
        if (sql.includes('duckdb_constraints')) return { rows: [] };
        return { rows: [] };
      },
      getTableSchema: async () => ({
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
        },
        indexes: [],
        foreignKeys: [],
      }),
    } as unknown as DatabaseProvider;

    const schema: Record<string, SchemaDefinition> = {
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'UUID', primaryKey: true },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const report = await checkLiveSchemaParity({
      db: duckDb,
      schemas: schema,
      includeSystemTables: false,
      engineHint: 'duckdb',
    });

    expect(find(report.findings, 'column_type_drift', 'id')).toBeUndefined();
  });
});
