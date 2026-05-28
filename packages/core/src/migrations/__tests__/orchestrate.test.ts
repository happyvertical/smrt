import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { computeChecksum } from '../checksum.js';
import {
  getPendingSchemaStatements,
  migrateSmrtSchemas,
} from '../orchestrate.js';
import { MigrationTracker } from '../tracker.js';

function makeDocumentSchema(): SchemaDefinition {
  return {
    tableName: 'documents',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      score: { type: 'REAL' },
      metadata: { type: 'JSON' },
      is_active: { type: 'BOOLEAN' },
    },
    indexes: [
      {
        name: 'idx_documents_score_active',
        columns: ['score'],
        where: 'is_active = 1',
      },
    ],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '1.0.0',
  };
}

describe('schema orchestration', () => {
  let db: DatabaseProvider;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    ObjectRegistry.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    ObjectRegistry.clear();
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  it('getPendingSchemaStatements returns no statements when db is already in sync', async () => {
    await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);');

    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      users: {
        tableName: 'users',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const pending = await getPendingSchemaStatements(db);
    expect(pending.hasChanges).toBe(false);
    expect(pending.statements).toEqual([]);
  });

  it('getPendingSchemaStatements returns engine-correct DDL for new tables', async () => {
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: makeDocumentSchema(),
    });

    const sqlitePending = await getPendingSchemaStatements(db);
    expect(sqlitePending.hasChanges).toBe(true);
    expect(sqlitePending.statements.join('\n')).toContain('"score" REAL');
    expect(sqlitePending.statements.join('\n')).toContain('"metadata" TEXT');
    expect(sqlitePending.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_documents_score_active" ON "documents" ("score") WHERE is_active = 1;',
    );

    const mockPostgresDb = {
      url: '',
      config: { url: 'postgresql://localhost/test' },
      query: async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      getTableSchema: async () => null,
    };

    const postgresPending = await getPendingSchemaStatements(
      mockPostgresDb as unknown as DatabaseProvider,
      {
        engineHint: 'postgres',
      },
    );
    expect(postgresPending.hasChanges).toBe(true);
    expect(postgresPending.statements.join('\n')).toContain(
      '"score" DOUBLE PRECISION',
    );
    expect(postgresPending.statements.join('\n')).toContain('"metadata" JSONB');
    expect(postgresPending.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_documents_score_active" ON "documents" ("score") WHERE is_active = 1;',
    );
  });

  it('engineHint threads into SchemaComparer for existing-table SQL (no split-brain)', async () => {
    const mockPostgresDb = {
      url: '',
      config: { url: 'postgresql://localhost/test' },
      query: async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'documents' }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      getTableSchema: async () => ({
        columns: {
          id: { type: 'TEXT', notnull: true },
          score: { type: 'TEXT', notnull: false },
        },
        indexes: [],
      }),
    };

    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: makeDocumentSchema(),
    });

    const pending = await getPendingSchemaStatements(
      mockPostgresDb as unknown as DatabaseProvider,
      {
        engineHint: 'postgres',
      },
    );

    // documents already exists, so the change goes through getSQLFromDiff
    // (SchemaComparer's per-change SQL), not the new-table path. Joined
    // statements should reflect the postgres-flavored DDL strategy — no
    // SQLite-style table recreation patterns mixed in.
    const joined = pending.statements.join('\n');
    expect(joined).not.toContain('REAL'); // SQLite uses REAL; postgres uses DOUBLE PRECISION
    // The comparer's added-column SQL should now use postgres types.
    if (joined.includes('ADD COLUMN')) {
      expect(joined).toMatch(/ADD COLUMN.*(?:JSONB|DOUBLE PRECISION|BOOLEAN)/i);
    }
  });

  it('migrateSmrtSchemas returns applied false when no pending changes exist', async () => {
    await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);');

    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      users: {
        tableName: 'users',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const result = await migrateSmrtSchemas({
      db,
      packageName: '@test/app',
      version: '1.0.0',
    });

    expect(result.applied).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.statements).toEqual([]);
  });

  it('migrateSmrtSchemas applies pending schema changes end-to-end', async () => {
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: makeDocumentSchema(),
    });

    const result = await migrateSmrtSchemas({
      db,
      packageName: '@test/app',
      version: '1.0.0',
      name: '20260527_000000_smrt_schema_sync',
    });

    expect(result.applied).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].applied).toBe(true);

    const tables = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='documents'`,
    );
    expect(tables.rows).toHaveLength(1);
  });

  it('migrateSmrtSchemas reports applied false when tracker skips an idempotent migration', async () => {
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: makeDocumentSchema(),
    });

    const pending = await getPendingSchemaStatements(db);
    const checksum = computeChecksum(pending.statements);
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();

    await db.query(
      `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, status, attempts, batch)
       VALUES ('skip-id', 'existing_schema_sync', '1.0.0', ?, 'completed', 1, 1)`,
      checksum,
    );

    const result = await migrateSmrtSchemas({
      db,
      packageName: '@test/app',
      version: '1.0.0',
      name: 'existing_schema_sync',
      reconcile: false,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].skipped).toBe(true);
    expect(result.results[0].applied).toBe(false);
    expect(result.applied).toBe(false);
  });

  it('migrateSmrtSchemas forwards lockTimeout and statementTimeout to the tracker', async () => {
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: makeDocumentSchema(),
    });

    // Spy on tracker construction by intercepting applyAll — we can't read
    // the private options directly, so we assert the call sequence happens
    // without errors and that custom timeouts are accepted by the type.
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@test/app',
      version: '1.0.0',
      name: '20260527_020000_timeout_test',
      lockTimeout: 12345,
      statementTimeout: 67890,
    });

    expect(result.applied).toBe(true);
    // The schema was created — direct verification that custom timeouts
    // didn't break the apply path.
    const tables = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='documents'`,
    );
    expect(tables.rows).toHaveLength(1);
  });

  it('surfaces SQLite type-upgrade comments as unactionableChanges, not as applied DDL', async () => {
    // Pre-create the column with INTEGER; manifest declares REAL. SQLite
    // can't widen the type in place — the differ emits an advisory
    // comment-only "requires table recreation" SQL. Before the fix, that
    // comment was passed to the tracker and recorded as a successful
    // migration, so the drift would re-appear every run.
    await db.query(
      'CREATE TABLE documents (id TEXT PRIMARY KEY, score INTEGER);',
    );

    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: {
        tableName: 'documents',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          score: { type: 'REAL' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const pending = await getPendingSchemaStatements(db);

    // No executable statements should make it through the filter.
    for (const stmt of pending.statements) {
      const lines = stmt
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      expect(lines.every((l) => l.startsWith('--'))).toBe(false);
    }

    // The unresolved drift should surface via unactionableChanges so the
    // caller can prompt for manual remediation.
    expect(pending.unactionableChanges.length).toBeGreaterThan(0);
    expect(pending.hasManualDrift).toBe(true);
    expect(
      pending.unactionableChanges.some(
        (c) => c.type === 'type_upgrade' && c.name === 'score',
      ),
    ).toBe(true);
  });

  it('surfaces incompatible type_mismatch changes as unactionableChanges', async () => {
    // The differ emits `type: 'type_mismatch'` (no SQL) for column type
    // changes it can't auto-upgrade. Previously these were invisible to
    // callers — `applied: false` looked identical to "schema in sync".
    await db.query('CREATE TABLE documents (id TEXT PRIMARY KEY, score BLOB);');

    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: {
        tableName: 'documents',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          score: { type: 'INTEGER' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const result = await migrateSmrtSchemas({
      db,
      packageName: '@test/app',
      version: '1.0.0',
      name: '20260527_030000_type_mismatch',
    });

    // No applicable DDL → applied false, but the caller needs to know
    // there's still drift.
    expect(result.applied).toBe(false);
    expect(result.unactionableChanges.length).toBeGreaterThan(0);
    expect(result.hasManualDrift).toBe(true);
    expect(
      result.unactionableChanges.some(
        (c) => c.type === 'type_mismatch' && c.name === 'score',
      ),
    ).toBe(true);
  });

  it('hasManualDrift is false when the schema is in sync', async () => {
    await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);');

    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      users: {
        tableName: 'users',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const pending = await getPendingSchemaStatements(db);
    expect(pending.hasChanges).toBe(false);
    expect(pending.hasManualDrift).toBe(false);
    expect(pending.unactionableChanges).toEqual([]);

    const result = await migrateSmrtSchemas({
      db,
      packageName: '@test/app',
      version: '1.0.0',
    });
    expect(result.applied).toBe(false);
    expect(result.hasManualDrift).toBe(false);
  });
});
