/**
 * SchemaManager branch coverage.
 *
 * schema-manager.test.ts covers the addMissingColumns introspection path with
 * a mocked DB. This file exercises the table-CREATION paths end-to-end on a
 * real in-memory SQLite database (per testing rules: real SQLite, never mock
 * the DB for SmrtObject/schema work), plus the adapter-specific branches
 * (syncSchema present, exportTable JSON detection, postgres introspection)
 * that SQLite doesn't structurally expose — those use minimal stub adapters.
 *
 * @happyvertical/logger is mocked so debug traces can be asserted; createLogger
 * is a spy to verify the per-instance level follows the `debug` option.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger, createLoggerMock } = vi.hoisted(() => {
  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return { mockLogger, createLoggerMock: vi.fn(() => mockLogger) };
});
vi.mock('@happyvertical/logger', () => ({
  createLogger: createLoggerMock,
}));

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { createSchemaManager, SchemaManager } from './schema-manager';
import type { SchemaDefinition } from './types';

function fullSchema(tableName: string): SchemaDefinition {
  return {
    tableName,
    columns: {
      id: {
        type: 'TEXT',
        primaryKey: true,
        notNull: true,
        referenceKind: 'id',
      },
      slug: { type: 'TEXT', notNull: true },
      title: { type: 'TEXT' },
      // notNull without default and not a PK -> exercises ADD COLUMN relaxation
      // (only when added to an existing table) and CREATE-time NOT NULL.
      count: { type: 'INTEGER', notNull: true, defaultValue: 0 },
      // updated_at must exist for the no-op trigger body below to be valid DDL.
      updated_at: {
        type: 'TIMESTAMP',
        notNull: true,
        defaultValue: 'current_timestamp',
      },
    },
    indexes: [
      { name: `idx_${tableName}_slug`, columns: ['slug'] },
      {
        name: `idx_${tableName}_title_unique`,
        columns: ['title'],
        unique: true,
      },
    ],
    triggers: [
      {
        name: `trg_${tableName}_updated`,
        when: 'AFTER',
        event: 'UPDATE',
        // Complete no-op UPDATE so SQLite accepts the trigger DDL.
        body: `UPDATE "${tableName}" SET "updated_at" = "updated_at" WHERE 0;`,
        description: 'noop',
      },
    ],
    foreignKeys: [],
    version: 'v1',
    dependencies: [],
  };
}

describe('SchemaManager table creation on real SQLite', () => {
  let db: DatabaseProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        // ignore
      }
    }
  });

  it('creates a table with indexes and triggers end-to-end on real SQLite', async () => {
    // The SDK sqlite provider exposes syncSchema, so ensureTable feeds it the
    // combined DDL first; on this in-memory connection the post-sync existence
    // check drives a direct-DDL fallback that ultimately creates everything.
    // Either way the table, indexes, and trigger must all exist afterwards.
    const manager = new SchemaManager(db, { engine: 'sqlite', debug: true });
    const schema = fullSchema('widgets');

    await manager.ensureTable(schema);

    expect(await db.tableExists('widgets')).toBe(true);

    const indexes = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='widgets'`,
    );
    const indexNames = indexes.rows.map((r) => r.name);
    expect(indexNames).toContain('idx_widgets_slug');
    expect(indexNames).toContain('idx_widgets_title_unique');

    const triggers = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='widgets'`,
    );
    expect(triggers.rows.map((r) => r.name)).toContain('trg_widgets_updated');

    // Debug option raises the logger level so traces emit.
    expect(createLoggerMock).toHaveBeenCalledWith({ level: 'debug' });
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  it('skips triggers when skipTriggers is set', async () => {
    const manager = new SchemaManager(db, {
      engine: 'sqlite',
      skipTriggers: true,
    });

    await manager.ensureTable(fullSchema('gadgets'));

    const triggers = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='gadgets'`,
    );
    expect(triggers.rows).toHaveLength(0);
  });

  it('adds missing columns when the table already exists with a partial schema', async () => {
    // Pre-create a partial table; ensureTable should ALTER in the missing cols.
    await db.query(`CREATE TABLE parts ("id" TEXT PRIMARY KEY, "slug" TEXT)`);

    const manager = new SchemaManager(db, { engine: 'sqlite' });
    await manager.ensureTable(fullSchema('parts'));

    const cols = await db.query<{ name: string }>(`PRAGMA table_info(parts)`);
    const colNames = cols.rows.map((r) => r.name);
    expect(colNames).toContain('title');
    // `count` was NOT NULL with a default; it should still be added.
    expect(colNames).toContain('count');
  });

  it('ensureTables creates multiple tables ordered by dependencies', async () => {
    const parent = fullSchema('parents');
    const child: SchemaDefinition = {
      ...fullSchema('children'),
      dependencies: ['parents'],
    };

    const manager = new SchemaManager(db, { engine: 'sqlite' });
    // Pass child first; topological sort must create parent first regardless.
    await manager.ensureTables([child, parent]);

    expect(await db.tableExists('parents')).toBe(true);
    expect(await db.tableExists('children')).toBe(true);
  });
});

describe('SchemaManager engine resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects the JSON adapter structurally via exportTable', () => {
    const db = {
      url: 'duckdb://:memory:',
      exportTable: () => undefined,
      query: vi.fn(),
      tableExists: vi.fn(),
    } as any;

    const manager = new SchemaManager(db);
    expect(manager.getEngine()).toBe('json');
  });

  it('falls back to URL-based detection when no engine or adapter hint', () => {
    const db = {
      url: 'postgres://localhost/test',
      query: vi.fn(),
      tableExists: vi.fn(),
    } as any;

    const manager = new SchemaManager(db);
    expect(manager.getEngine()).toBe('postgres');
  });

  it('honors an explicitly provided engine over detection', () => {
    const db = { url: 'postgres://localhost/test' } as any;
    const manager = createSchemaManager(db, { engine: 'duckdb' });
    expect(manager.getEngine()).toBe('duckdb');
  });

  it('generateDDL returns engine-specific DDL without executing', () => {
    const db = { url: 'sqlite::memory:' } as any;
    const manager = createSchemaManager(db, { engine: 'sqlite' });

    const ddl = manager.generateDDL(fullSchema('preview'));
    expect(ddl.createTable).toContain('preview');
    expect(Array.isArray(ddl.indexes)).toBe(true);
    expect(Array.isArray(ddl.triggers)).toBe(true);
  });
});

describe('SchemaManager adapter syncSchema path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses adapter syncSchema and returns when the table is verified created', async () => {
    let tableCreated = false;
    const syncSchema = vi.fn(async () => {
      tableCreated = true;
    });
    const db = {
      url: 'duckdb://:memory:',
      query: vi.fn(),
      tableExists: vi.fn(async () => tableCreated),
      syncSchema,
    } as any;

    const manager = new SchemaManager(db, { engine: 'duckdb', debug: true });
    await manager.ensureTable(fullSchema('via_sync'));

    expect(syncSchema).toHaveBeenCalledTimes(1);
    // The combined schema string should contain CREATE TABLE plus indexes.
    const passed = syncSchema.mock.calls[0][0] as string;
    expect(passed).toContain('CREATE TABLE');
    expect(passed).toContain('idx_via_sync_slug');
    // Direct DDL must NOT run (query never called for DDL).
    expect(db.query).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      '[SchemaManager] Table "via_sync" created via adapter syncSchema',
    );
  });

  it('omits triggers from the syncSchema string when skipTriggers is set', async () => {
    const syncSchema = vi.fn(async () => {});
    const tableExists = vi
      .fn()
      // initial existence check -> false (create path)
      .mockResolvedValueOnce(false)
      // post-syncSchema verification -> true (success)
      .mockResolvedValueOnce(true);
    const db = {
      url: 'duckdb://:memory:',
      query: vi.fn(),
      tableExists,
      syncSchema,
    } as any;

    const manager = new SchemaManager(db, {
      engine: 'duckdb',
      skipTriggers: true,
    });
    await manager.ensureTable(fullSchema('no_trig'));

    const passed = syncSchema.mock.calls[0][0] as string;
    expect(passed).not.toContain('trg_no_trig_updated');
  });

  it('falls back to direct DDL when syncSchema returns but the table is absent', async () => {
    const syncSchema = vi.fn(async () => {});
    const tableExists = vi
      .fn()
      // 1) initial existence check -> false (create path)
      .mockResolvedValueOnce(false)
      // 2) post-syncSchema verification -> false (triggers fallback)
      .mockResolvedValueOnce(false);
    const query = vi.fn(async () => ({ rows: [] }));
    const db = {
      url: 'duckdb://:memory:',
      query,
      tableExists,
      syncSchema,
    } as any;

    const manager = new SchemaManager(db, { engine: 'duckdb' });
    await manager.ensureTable(fullSchema('fallback'));

    expect(syncSchema).toHaveBeenCalledTimes(1);
    // Direct DDL fallback ran -> query executed createTable + indexes + triggers.
    expect(query).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `syncSchema returned but table "fallback" doesn't exist`,
      ),
    );
  });

  it('falls back to direct DDL when syncSchema throws', async () => {
    const syncSchema = vi.fn(async () => {
      throw new Error('adapter refused');
    });
    const query = vi.fn(async () => ({ rows: [] }));
    const db = {
      url: 'duckdb://:memory:',
      query,
      tableExists: vi.fn(async () => false),
      syncSchema,
    } as any;

    const manager = new SchemaManager(db, { engine: 'duckdb' });
    await manager.ensureTable(fullSchema('throwing'));

    expect(query).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`syncSchema failed for "throwing"`),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});

describe('SchemaManager addMissingColumns edge cases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns early when the schema declares no columns', async () => {
    const query = vi.fn();
    const db = {
      url: 'sqlite::memory:',
      query,
      tableExists: vi.fn(async () => true),
    } as any;

    const manager = new SchemaManager(db, { engine: 'sqlite' });
    await manager.ensureTable({
      tableName: 'empty_cols',
      columns: {},
      indexes: [],
      triggers: [],
      foreignKeys: [],
      version: 'v',
      dependencies: [],
    });

    // tableExists short-circuits; with no columns, no PRAGMA/ALTER queries run.
    expect(query).not.toHaveBeenCalled();
  });

  it('skips column additions when introspection returns no columns', async () => {
    const query = vi
      .fn()
      // PRAGMA table_info -> empty (introspection yields nothing)
      .mockResolvedValueOnce([]);
    const db = {
      url: 'sqlite::memory:',
      query,
      tableExists: vi.fn(async () => true),
    } as any;

    const manager = new SchemaManager(db, { engine: 'sqlite' });
    await manager.ensureTable(fullSchema('introspect_empty'));

    // Only the introspection PRAGMA ran; no ALTER statements followed.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('PRAGMA table_info');
  });

  it('does not attempt to ALTER in primary-key columns', async () => {
    // Existing table missing the PK column "id"; ensureTable must skip it
    // (cannot ADD a PRIMARY KEY via ALTER) but still add "title"/"count".
    const query = vi
      .fn()
      // introspection: only slug present
      .mockResolvedValueOnce([{ name: 'slug' }])
      // subsequent ALTERs resolve
      .mockResolvedValue([]);
    const db = {
      url: 'sqlite::memory:',
      query,
      tableExists: vi.fn(async () => true),
    } as any;

    const manager = new SchemaManager(db, { engine: 'sqlite' });
    await manager.ensureTable(fullSchema('pk_skip'));

    const alterStatements = query.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => sql.startsWith('ALTER TABLE'));
    // id is the PK -> never altered in.
    expect(alterStatements.some((s) => s.includes('"id"'))).toBe(false);
    expect(alterStatements.some((s) => s.includes('"title"'))).toBe(true);
  });

  it('continues past a failing ALTER without aborting the whole operation', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('ALTER TABLE') && sql.includes('"title"')) {
        throw new Error('duplicate column title');
      }
      if (sql.includes('PRAGMA table_info')) {
        return [{ name: 'id' }, { name: 'slug' }];
      }
      return [];
    });
    const db = {
      url: 'sqlite::memory:',
      query,
      tableExists: vi.fn(async () => true),
    } as any;

    const manager = new SchemaManager(db, { engine: 'sqlite', debug: true });
    // Must not throw despite the failing ALTER.
    await expect(
      manager.ensureTable(fullSchema('resilient')),
    ).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to add column "title"'),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it('uses information_schema introspection for postgres and logs on failure', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('information_schema.columns')) {
        throw new Error('permission denied');
      }
      return { rows: [] };
    });
    const db = {
      url: 'postgres://localhost/test',
      query,
      tableExists: vi.fn(async () => true),
    } as any;

    const manager = new SchemaManager(db, { engine: 'postgres', debug: true });
    await manager.ensureTable(fullSchema('pg_introspect'));

    // Introspection failure is swallowed (empty set) -> no columns added.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to introspect columns'),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});

describe('SchemaManager dependency sorting', () => {
  beforeEach(() => vi.clearAllMocks());

  it('warns and proceeds when a circular dependency is detected', async () => {
    const created: string[] = [];
    const db = {
      url: 'sqlite::memory:',
      query: vi.fn(async () => ({ rows: [] })),
      tableExists: vi.fn(async (name: string) => {
        // Report not-exists so each schema goes through the create path.
        created.push(name);
        return false;
      }),
    } as any;

    const a: SchemaDefinition = {
      ...fullSchema('a'),
      dependencies: ['b'],
    };
    const b: SchemaDefinition = {
      ...fullSchema('b'),
      dependencies: ['a'],
    };

    const manager = new SchemaManager(db, { engine: 'sqlite' });
    await manager.ensureTables([a, b]);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Circular dependency detected involving'),
    );
    // Both tables still get created despite the cycle.
    expect(created).toContain('a');
    expect(created).toContain('b');
  });

  it('ignores external (unknown) dependencies during sorting', async () => {
    const db = {
      url: 'sqlite::memory:',
      query: vi.fn(async () => ({ rows: [] })),
      tableExists: vi.fn(async () => false),
    } as any;

    const schema: SchemaDefinition = {
      ...fullSchema('local'),
      // 'external' is not among the provided schemas -> skipped, no throw.
      dependencies: ['external'],
    };

    const manager = new SchemaManager(db, { engine: 'sqlite' });
    await expect(manager.ensureTables([schema])).resolves.toBeUndefined();
  });
});
