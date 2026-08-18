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

  it('migrateSmrtSchemas accepts lockTimeout and statementTimeout in its options', async () => {
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: makeDocumentSchema(),
    });

    // We can't read the tracker's private `options` field, and the values
    // only matter on Postgres (where the tracker emits SET LOCAL …).
    // Against SQLite we can only verify the options are accepted by the
    // type signature, forwarded by the orchestrator without crashing, and
    // don't break the apply path. The TypeScript type itself enforces that
    // a refactor can't silently drop these fields between
    // `MigrateSmrtSchemasOptions` and `MigrationTrackerOptions`.
    const result = await migrateSmrtSchemas({
      db,
      packageName: '@test/app',
      version: '1.0.0',
      name: '20260527_020000_timeout_test',
      lockTimeout: 12345,
      statementTimeout: 67890,
    });

    expect(result.applied).toBe(true);
    const tables = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='documents'`,
    );
    expect(tables.rows).toHaveLength(1);
  });

  it('plans an executable SQLite table rebuild for a type upgrade (#2370)', async () => {
    // Pre-create the column with INTEGER; manifest declares REAL. SQLite
    // can't widen the type in place, and the differ used to emit an advisory
    // comment that left the drift unfixable forever. It now emits the
    // table-rebuild plan, which the orchestrator must pass through as real
    // DDL (comment-only statements are still filtered out).
    await db.query(
      'CREATE TABLE documents (id TEXT PRIMARY KEY, score INTEGER);',
    );
    await db.query("INSERT INTO documents VALUES ('d1', 4);");

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

    expect(pending.hasChanges).toBe(true);
    expect(pending.statements.some((sql) => sql.startsWith('--'))).toBe(false);
    expect(pending.statements).toContain(
      'ALTER TABLE "_smrt_rebuild_documents" RENAME TO "documents"',
    );
    // Nothing is left for a human to do.
    expect(pending.unactionableChanges).toEqual([]);
    expect(pending.hasManualDrift).toBe(false);

    const result = await migrateSmrtSchemas({
      db,
      packageName: '@test/app',
      name: '20260818_000000_sqlite_rebuild',
    });
    expect(result.applied).toBe(true);

    const columns = (await db.query('PRAGMA table_info("documents")')).rows as {
      name: string;
      type: string;
    }[];
    expect(columns.find((c) => c.name === 'score')?.type).toBe('REAL');
    expect((await db.query('SELECT score FROM documents')).rows[0]).toEqual({
      score: 4,
    });
  });

  it('does not report a column covered by a sibling rebuild as manual drift (#2370)', async () => {
    // Two drifted columns on one table share a single rebuild: the second
    // change is a `no change needed` comment. Comment-only SQL normally means
    // "a human must act", so without the no-op exemption this fully
    // auto-repairable migration would report hasManualDrift.
    await db.query(
      'CREATE TABLE documents (id TEXT PRIMARY KEY, score INTEGER, weight INTEGER);',
    );

    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: {
        tableName: 'documents',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          score: { type: 'REAL' },
          weight: { type: 'REAL' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const pending = await getPendingSchemaStatements(db);

    expect(pending.unactionableChanges).toEqual([]);
    expect(pending.hasManualDrift).toBe(false);
    expect(pending.statements.some((sql) => sql.startsWith('--'))).toBe(false);

    const result = await migrateSmrtSchemas({
      db,
      packageName: '@test/app',
      name: '20260818_000100_sqlite_rebuild_multi',
    });
    expect(result.applied).toBe(true);
    expect(result.hasManualDrift).toBe(false);

    const columns = (await db.query('PRAGMA table_info("documents")')).rows as {
      name: string;
      type: string;
    }[];
    expect(columns.find((c) => c.name === 'score')?.type).toBe('REAL');
    expect(columns.find((c) => c.name === 'weight')?.type).toBe('REAL');
  });

  it('still surfaces an unplannable SQLite type upgrade as unactionable drift', async () => {
    // A child table with ON DELETE CASCADE makes the rebuild unsafe (the
    // DROP TABLE step would cascade its rows away), so the differ keeps the
    // advisory comment. The orchestrator must strip that comment from the
    // executable statements and report the drift as manual.
    await db.query(
      'CREATE TABLE documents (id TEXT PRIMARY KEY, score INTEGER);',
    );
    await db.query(
      'CREATE TABLE document_notes (id TEXT PRIMARY KEY, document_id TEXT REFERENCES documents(id) ON DELETE CASCADE);',
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

    expect(pending.statements).toEqual([]);
    expect(pending.unactionableChanges).toHaveLength(1);
    expect(pending.hasManualDrift).toBe(true);
    expect(pending.unactionableChanges[0].type).toBe('type_upgrade');
    expect(pending.unactionableChanges[0].name).toBe('score');
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
    // there's still drift. Exactly one column drifted.
    expect(result.applied).toBe(false);
    expect(result.unactionableChanges).toHaveLength(1);
    expect(result.hasManualDrift).toBe(true);
    expect(result.unactionableChanges[0].type).toBe('type_mismatch');
    expect(result.unactionableChanges[0].name).toBe('score');
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
