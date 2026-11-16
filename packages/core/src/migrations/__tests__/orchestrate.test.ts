import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { computeChecksum } from '../checksum.js';
import {
  createRegisteredTables,
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
  let db: DatabaseInterface;

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
      mockPostgresDb as unknown as DatabaseInterface,
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
      mockPostgresDb as unknown as DatabaseInterface,
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

    const tables = await db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='documents'`,
    );
    expect(tables.rows).toHaveLength(1);
  });

  it('refuses every change before tracker bootstrap and applies everything after the stop is fixed (#4927)', async () => {
    await db.query('CREATE TABLE documents (id TEXT PRIMARY KEY, score BLOB)');
    await db.query("INSERT INTO documents VALUES ('d1', 'kept')");
    const schema = makeDocumentSchema();
    const schemas = {
      documents: schema,
      tags: { ...makeDocumentSchema(), tableName: 'tags', indexes: [] },
    };
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue(
      schemas,
    );
    const before = (await db.query('SELECT * FROM sqlite_master ORDER BY name'))
      .rows;
    const pending = await getPendingSchemaStatements(db);
    expect(pending.decision.proceed).toBe(false);
    const initialize = vi.spyOn(MigrationTracker.prototype, 'initialize');
    const result = await migrateSmrtSchemas({ db, packageName: '@test/app' });
    expect(result).toMatchObject({
      applied: false,
      refused: true,
      results: [],
      hasManualDrift: true,
    });
    expect(result.stops).toEqual(pending.decision.stops);
    expect(result.heldBack).toEqual(pending.decision.heldBack);
    expect(result.heldBack.map((item) => item.description)).toEqual(
      expect.arrayContaining([
        'Create table tags',
        'Add column documents.metadata',
        'Add column documents.is_active',
        'Add index documents.idx_documents_score_active',
      ]),
    );
    expect(initialize).not.toHaveBeenCalled();
    expect(
      (await db.query('SELECT * FROM sqlite_master ORDER BY name')).rows,
    ).toEqual(before);
    expect((await db.query('SELECT * FROM documents')).rows).toEqual([
      { id: 'd1', score: 'kept' },
    ]);

    // The operator aligns the incompatible declaration; the next run applies all.
    schema.columns.score.type = 'BLOB';
    const applied = await migrateSmrtSchemas({ db, packageName: '@test/app' });
    expect(applied).toMatchObject({
      applied: true,
      refused: false,
      stops: [],
      heldBack: [],
    });
    expect((await db.getTableSchema?.('documents'))?.columns).toHaveProperty(
      'metadata',
    );
    expect(
      (await db.query("SELECT name FROM sqlite_master WHERE name = 'tags'"))
        .rows,
    ).toHaveLength(1);
  });

  it('rolls back the whole ordinary core batch if a later unique index fails (#4927)', async () => {
    await db.query('CREATE TABLE documents (id TEXT PRIMARY KEY, score REAL)');
    await db.query("INSERT INTO documents VALUES ('d1', 2), ('d2', 2)");
    const schema = makeDocumentSchema();
    schema.indexes = [
      { name: 'documents_score_unique', columns: ['score'], unique: true },
    ];
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: schema,
    });
    const before = (await db.query('SELECT * FROM sqlite_master ORDER BY name'))
      .rows;
    await expect(
      migrateSmrtSchemas({ db, packageName: '@test/app', postgresSafe: false }),
    ).rejects.toThrow();
    expect(
      (await db.query('SELECT * FROM sqlite_master ORDER BY name')).rows,
    ).toEqual(before);
    expect(
      (await db.query('SELECT * FROM documents ORDER BY id')).rows,
    ).toEqual([
      { id: 'd1', score: 2 },
      { id: 'd2', score: 2 },
    ]);
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
    const tables = await db.query(
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

  it('rebuilds a SQLite table that other tables reference, keeping their rows (#4937)', async () => {
    await db.query('PRAGMA foreign_keys = ON');
    await db.query(
      'CREATE TABLE documents (id TEXT PRIMARY KEY, score INTEGER);',
    );
    await db.query(
      'CREATE TABLE document_notes (id TEXT PRIMARY KEY, document_id TEXT REFERENCES documents(id) ON DELETE CASCADE);',
    );
    await db.query("INSERT INTO documents VALUES ('d1', 3)");
    await db.query("INSERT INTO document_notes VALUES ('n1', 'd1')");

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

    const result = await migrateSmrtSchemas({ db, packageName: 'test' });
    expect(result.applied).toBe(true);
    expect(result.hasManualDrift).toBe(false);
    expect((await db.query('SELECT id FROM document_notes')).rows).toEqual([
      { id: 'n1' },
    ]);
    expect((await db.query('SELECT score FROM documents')).rows).toEqual([
      { score: 3 },
    ]);
  });

  it('still surfaces an unplannable SQLite change as unactionable drift', async () => {
    // AUTOINCREMENT keeps a sequence that a rebuild would not carry over, so
    // the differ keeps the advisory comment. The orchestrator must strip that
    // comment from the executable statements and report the drift as manual.
    await db.query(
      'CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, score INTEGER);',
    );

    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: {
        tableName: 'documents',
        columns: {
          id: { type: 'INTEGER', primaryKey: true },
          score: { type: 'INTEGER', defaultValue: 5 },
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
    expect(pending.unactionableChanges[0].type).toBe('alter_column');
    expect(pending.unactionableChanges[0].name).toBe('score');
  });

  it('requireComplete refuses manual drift before executing even the actionable part of a plan', async () => {
    // An incompatible type change is manual drift (a stop, #4925); an orphan
    // NOT NULL column no longer is (see the next test).
    await db.query('CREATE TABLE documents (id TEXT PRIMARY KEY, score BLOB)');
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: {
        ...makeDocumentSchema(),
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          score: { type: 'INTEGER' },
        },
      },
      new_documents: { ...makeDocumentSchema(), tableName: 'new_documents' },
    });
    await expect(
      migrateSmrtSchemas({
        db,
        packageName: '@fixture/app',
        requireComplete: true,
      }),
    ).rejects.toThrow(/manual schema migration/);
    expect(
      (
        await db.query(
          "SELECT name FROM sqlite_master WHERE name = 'new_documents'",
        )
      ).rows,
    ).toEqual([]);
  });

  it('reports an orphan NOT NULL column without manual drift or executable SQL (#4925)', async () => {
    await db.query(
      'CREATE TABLE documents (id TEXT PRIMARY KEY, legacy_code TEXT NOT NULL, legacy_note TEXT);',
    );
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      documents: {
        tableName: 'documents',
        columns: { id: { type: 'TEXT', primaryKey: true } },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const pending = await getPendingSchemaStatements(db);
    expect(pending.statements).toEqual([]);
    expect(pending.hasChanges).toBe(false);
    expect(
      pending.diff.changes
        .map((c) => `${c.name}:${c.advisory?.severity}`)
        .sort(),
    ).toEqual(['legacy_code:warning', 'legacy_note:info']);
    // Retaining the column loses or invents no data, even when inserts fail.
    expect(pending.unactionableChanges).toEqual([]);
    expect(pending.hasManualDrift).toBe(false);

    const result = await migrateSmrtSchemas({ db, packageName: 'test' });
    expect(result.applied).toBe(false);
    expect(result.statements).toEqual([]);
    expect(result.unactionableChanges).toEqual([]);
    expect(result.hasManualDrift).toBe(false);
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
    expect(result.refused).toBe(true);
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

  it('reports each applied relaxation by table and column and logs it as its own line (#4897)', async () => {
    await db.query(
      'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);',
    );
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      notes: {
        tableName: 'notes',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          body: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });
    const output: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      });
    }

    // Dropping NOT NULL applies by default on every engine (#4937), so it is
    // planned and reported without the opt-in.
    const pending = await getPendingSchemaStatements(db);
    expect(pending.relaxedColumns).toEqual([
      { table: 'notes', column: 'body', alteration: 'drop_not_null' },
    ]);

    const result = await migrateSmrtSchemas({
      db,
      packageName: 'test',
      version: '1.0.0',
    });
    expect(result.applied).toBe(true);
    expect(result.relaxedColumns).toEqual([
      { table: 'notes', column: 'body', alteration: 'drop_not_null' },
    ]);
    expect(
      output.filter((line) => line.includes('Relaxed notes.body')),
    ).toHaveLength(1);
    await db.query("INSERT INTO notes (id, body) VALUES ('n1', NULL)");
  });

  it('createRegisteredTables creates only the named missing tables', async () => {
    await db.query('CREATE TABLE present (id TEXT PRIMARY KEY);');
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockImplementation(
      (options?: { tables?: Iterable<string> }) => {
        const all = {
          documents: makeDocumentSchema(),
          present: { ...makeDocumentSchema(), tableName: 'present' },
          other: { ...makeDocumentSchema(), tableName: 'other' },
        };
        const wanted = new Set(options?.tables ?? Object.keys(all));
        return Object.fromEntries(
          Object.entries(all).filter(([name]) => wanted.has(name)),
        );
      },
    );

    const ran = await createRegisteredTables(
      db,
      ['documents', 'present'],
      'sqlite',
    );

    expect(ran.some((sql) => sql.includes('"documents"'))).toBe(true);
    expect(ran.some((sql) => sql.includes('"present"'))).toBe(false);
    expect(await db.getTableSchema?.('documents')).toBeTruthy();
    expect(await db.getTableSchema?.('other')).toBeFalsy();
    expect(await createRegisteredTables(db, ['documents'], 'sqlite')).toEqual(
      [],
    );
  });
});
