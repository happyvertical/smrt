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

    const postgresPending = await getPendingSchemaStatements(db, {
      engineHint: 'postgres',
    });
    expect(postgresPending.statements.join('\n')).toContain(
      '"score" DOUBLE PRECISION',
    );
    expect(postgresPending.statements.join('\n')).toContain('"metadata" JSONB');
    expect(postgresPending.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_documents_score_active" ON "documents" ("score") WHERE is_active = 1;',
    );
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

  it('migrateSmrtSchemas respects engineHint override for generated DDL', async () => {
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: makeDocumentSchema(),
    });

    const result = await migrateSmrtSchemas({
      db,
      packageName: '@test/app',
      version: '1.0.0',
      name: '20260527_010000_smrt_schema_sync_pg',
      engineHint: 'postgres',
    });

    expect(result.applied).toBe(true);
    expect(result.statements.join('\n')).toContain('"score" DOUBLE PRECISION');
    expect(result.statements.join('\n')).toContain('"metadata" JSONB');
    expect(result.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_documents_score_active" ON "documents" ("score") WHERE is_active = 1;',
    );
  });
});
