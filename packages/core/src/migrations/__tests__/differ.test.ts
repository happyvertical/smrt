/**
 * SchemaComparer Tests
 *
 * Tests for schema comparison and diff generation.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaGenerator } from '../../schema/generator.js';
import type { SchemaDefinition, SchemaDiff } from '../../schema/types.js';
import {
  getSQLFromDiff,
  hasActionableChanges,
  SchemaComparer,
} from '../differ.js';

describe('SchemaComparer', () => {
  let db: DatabaseProvider;
  let comparer: SchemaComparer;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    comparer = new SchemaComparer(db);
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  describe('compare', () => {
    it('should detect new tables', async () => {
      const manifest: Record<string, SchemaDefinition> = {
        users: {
          tableName: 'users',
          ddl: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);',
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
      };

      const diff = await comparer.compare(manifest);

      expect(diff.has_changes).toBe(true);
      expect(diff.added_tables).toHaveLength(1);
      expect(diff.added_tables[0].tableName).toBe('users');
    });

    it('should not report existing tables as new', async () => {
      // Create table first
      await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);');

      const manifest: Record<string, SchemaDefinition> = {
        users: {
          tableName: 'users',
          ddl: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);',
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
      };

      const diff = await comparer.compare(manifest);

      expect(diff.added_tables).toHaveLength(0);
    });

    it('should detect new columns in existing table', async () => {
      // Create table with only id
      await db.query('CREATE TABLE users (id TEXT PRIMARY KEY);');

      const manifest: Record<string, SchemaDefinition> = {
        users: {
          tableName: 'users',
          ddl: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT);',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            name: { type: 'TEXT' },
            email: { type: 'TEXT' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      const diff = await comparer.compare(manifest);

      expect(diff.has_changes).toBe(true);
      const columnChanges = diff.changes.filter((c) => c.type === 'add_column');
      expect(columnChanges).toHaveLength(2);
      expect(columnChanges.map((c) => c.name)).toContain('name');
      expect(columnChanges.map((c) => c.name)).toContain('email');
    });

    it('should detect new indexes', async () => {
      // Create table without index
      await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);');

      const manifest: Record<string, SchemaDefinition> = {
        users: {
          tableName: 'users',
          ddl: 'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            email: { type: 'TEXT' },
          },
          indexes: [
            { name: 'idx_users_email', columns: ['email'], unique: false },
          ],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      const diff = await comparer.compare(manifest);

      expect(diff.has_changes).toBe(true);
      const indexChanges = diff.changes.filter((c) => c.type === 'add_index');
      expect(indexChanges).toHaveLength(1);
      expect(indexChanges[0].name).toBe('idx_users_email');
    });

    it('migrates a declared composite index onto an existing deployment (#2357)', async () => {
      // A table that predates the `@smrt({ indexes: [...] })` declaration.
      await db.query(
        'CREATE TABLE posts (id TEXT PRIMARY KEY, tenant_id TEXT, publish_date TIMESTAMP);',
      );

      // Target schema comes from the generator, so this asserts the whole
      // declaration → schema → migration path rather than a hand-written index.
      const generated = new SchemaGenerator().generateSchemaFromRegistry(
        'Post',
        'posts',
        new Map<string, { type: string }>([
          ['tenantId', { type: 'text' }],
          ['publish_date', { type: 'datetime' }],
        ]) as never,
        {
          indexes: [
            {
              name: 'posts_tenant_id_publish_date_idx',
              columns: ['tenantId', 'publish_date'],
            },
          ],
        },
      );

      const diff = await comparer.compare({ posts: generated });

      const add = diff.changes.find(
        (c) =>
          c.type === 'add_index' &&
          c.name === 'posts_tenant_id_publish_date_idx',
      );
      expect(add).toBeDefined();
      // And the emitted statement is executable against the live table.
      expect(add?.sql).toBeTruthy();
      await db.query(add?.sql as string);
      const indexes = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'posts';",
      );
      expect(indexes.rows.map((row) => row.name)).toContain(
        'posts_tenant_id_publish_date_idx',
      );
    });

    it('emits add-index SQL with IF NOT EXISTS so a retry repairs (issue #2362)', async () => {
      // A batch that fails part way through — a lock_timeout during the epic's
      // ~200-index rollout, a cancelled deploy — leaves some indexes created.
      // Without IF NOT EXISTS the retry errors on those instead of repairing
      // the rest. This also matches the canonical `generateIndexes()` DDL used
      // for new tables, so both schema paths emit the same clause.
      await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);');

      const manifest: Record<string, SchemaDefinition> = {
        users: {
          tableName: 'users',
          ddl: 'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            email: { type: 'TEXT' },
          },
          indexes: [
            { name: 'idx_users_email', columns: ['email'], unique: true },
          ],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      const diff = await comparer.compare(manifest);
      const add = diff.changes.find((c) => c.type === 'add_index');

      expect(add?.sql).toBe(
        'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email" ON "users" ("email")',
      );

      // Executable, and idempotent on a second run.
      await db.query(add?.sql as string);
      await expect(db.query(add?.sql as string)).resolves.toBeDefined();
    });

    it('should not report existing indexes as new', async () => {
      await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);');
      await db.query('CREATE INDEX idx_users_email ON users(email);');

      const manifest: Record<string, SchemaDefinition> = {
        users: {
          tableName: 'users',
          ddl: 'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            email: { type: 'TEXT' },
          },
          indexes: [
            { name: 'idx_users_email', columns: ['email'], unique: false },
          ],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      const diff = await comparer.compare(manifest);

      const indexChanges = diff.changes.filter((c) => c.type === 'add_index');
      expect(indexChanges).toHaveLength(0);
    });

    it('should detect type mismatches when configured', async () => {
      // Create table with INTEGER
      await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, age INTEGER);');

      const manifest: Record<string, SchemaDefinition> = {
        users: {
          tableName: 'users',
          ddl: 'CREATE TABLE users (id TEXT PRIMARY KEY, age TEXT);',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            age: { type: 'TEXT' }, // Manifest says TEXT, DB has INTEGER
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      // Create comparer with ignoreTypeMismatches: false
      const strictComparer = new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      });

      const diff = await strictComparer.compare(manifest);

      const typeMismatches = diff.changes.filter(
        (c) => c.type === 'type_mismatch',
      );
      expect(typeMismatches).toHaveLength(1);
      expect(typeMismatches[0].name).toBe('age');
    });

    it('should detect TEXT→JSON as type_upgrade for SQLite', async () => {
      // Create table with TEXT column (how SQLite stores JSON)
      await db.query(
        'CREATE TABLE documents (id TEXT PRIMARY KEY, tags TEXT);',
      );

      const manifest: Record<string, SchemaDefinition> = {
        documents: {
          tableName: 'documents',
          ddl: 'CREATE TABLE documents (id TEXT PRIMARY KEY, tags JSON);',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            tags: { type: 'JSON' }, // Manifest says JSON, DB has TEXT
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      const diff = await comparer.compare(manifest);

      // For SQLite, JSON maps to TEXT, so there should be no changes
      // The DDL strategy knows JSON → TEXT for SQLite
      expect(diff.has_changes).toBe(false);
    });

    it('should treat manifest TEXT vs DB JSON as equivalent (no churn) (#1335)', async () => {
      // A native-`json` DB column with a text-convention manifest field. SMRT
      // stores JSON as serialized TEXT, so a native-json column already holds
      // exactly the data the manifest expects — no migration is needed and the
      // differ must NOT emit a type_upgrade (which would needlessly rewrite the
      // whole column and risk losing the native-json typing).
      await db.query(
        'CREATE TABLE documents (id TEXT PRIMARY KEY, metadata JSON);',
      );

      const manifest: Record<string, SchemaDefinition> = {
        documents: {
          tableName: 'documents',
          ddl: 'CREATE TABLE documents (id TEXT PRIMARY KEY, metadata TEXT);',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            metadata: { type: 'TEXT' }, // Manifest says TEXT, DB has JSON
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      const strictComparer = new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      });

      const diff = await strictComparer.compare(manifest);

      // No type_upgrade, no type_mismatch — json and text are interchangeable.
      expect(
        diff.changes.filter((c) => c.type === 'type_upgrade'),
      ).toHaveLength(0);
      expect(
        diff.changes.filter((c) => c.type === 'type_mismatch'),
      ).toHaveLength(0);
      expect(diff.has_changes).toBe(false);
    });

    it('should treat manifest JSON vs DB TEXT as equivalent (no phantom upgrade) (#1335)', async () => {
      // The canary case (#1335): an enum/plain field on an STI child was
      // mis-inferred as JSON by a downstream scanner, while the real column is
      // `text` holding bare values like 'active'. The differ must NOT generate
      // `ALTER COLUMN ... TYPE jsonb USING col::jsonb` — that raises
      // "invalid input syntax for type json" and aborts the atomic migration.
      await db.query(
        'CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT);',
      );
      await db.query(
        "INSERT INTO tenants (id, status) VALUES ('t1', 'active')",
      );

      const manifest: Record<string, SchemaDefinition> = {
        tenants: {
          tableName: 'tenants',
          ddl: 'CREATE TABLE tenants (id TEXT PRIMARY KEY, status JSON);',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            status: { type: 'JSON' }, // Manifest mis-says JSON, DB is TEXT
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      const strictComparer = new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      });

      const diff = await strictComparer.compare(manifest);

      expect(
        diff.changes.filter((c) => c.type === 'type_upgrade'),
      ).toHaveLength(0);
      expect(
        diff.changes.filter((c) => c.type === 'type_mismatch'),
      ).toHaveLength(0);
      expect(diff.has_changes).toBe(false);
    });

    it('should handle empty manifest', async () => {
      const diff = await comparer.compare({});

      expect(diff.has_changes).toBe(false);
      expect(diff.added_tables).toHaveLength(0);
      expect(diff.changes).toHaveLength(0);
    });

    it('should compare multiple tables', async () => {
      // Create one table
      await db.query('CREATE TABLE users (id TEXT PRIMARY KEY);');

      const manifest: Record<string, SchemaDefinition> = {
        users: {
          tableName: 'users',
          ddl: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);',
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
        profiles: {
          tableName: 'profiles',
          ddl: 'CREATE TABLE profiles (id TEXT PRIMARY KEY);',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      };

      const diff = await comparer.compare(manifest);

      expect(diff.has_changes).toBe(true);
      expect(diff.added_tables).toHaveLength(1);
      expect(diff.added_tables[0].tableName).toBe('profiles');

      const columnChanges = diff.changes.filter((c) => c.type === 'add_column');
      expect(columnChanges).toHaveLength(1);
      expect(columnChanges[0].name).toBe('name');
    });
  });
});

describe('SchemaComparer engine-specific SQL generation', () => {
  it('uses db.config.url when db.url is empty for engine detection', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ table_name: 'documents' }] };
      }
      throw new Error(`Unexpected introspection query: ${sql}`);
    });

    const mockDb = {
      url: '',
      config: { url: 'postgresql://localhost/test' },
      query,
      // DB is missing `metadata`; the differ must add it. The generated
      // ADD COLUMN SQL maps JSON→JSONB only on the Postgres DDL strategy, so
      // a JSONB type proves the engine was detected from `config.url`.
      getTableSchema: async () => ({
        columns: {
          id: { type: 'text', notnull: true },
        },
        indexes: [],
      }),
    };

    const comparer = new SchemaComparer(mockDb as any, {
      ignoreTypeMismatches: false,
    });
    const diff = await comparer.compare({
      documents: {
        tableName: 'documents',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          metadata: { type: 'JSON' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.tables'),
    );
    const addColumns = diff.changes.filter((c) => c.type === 'add_column');
    expect(addColumns).toHaveLength(1);
    expect(addColumns[0].name).toBe('metadata');
    expect(addColumns[0].sql).toContain('JSONB');
  });

  it('uses engineHint for existing-table introspection query selection', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ table_name: 'users' }] };
      }
      throw new Error(`Unexpected introspection query: ${sql}`);
    });

    const mockDb = {
      url: ':memory:',
      query,
      getTableSchema: async () => ({
        columns: {
          id: { type: 'TEXT', notnull: true },
        },
        indexes: [],
      }),
    };

    const comparer = new SchemaComparer(mockDb as any, {
      engineHint: 'postgres',
    });
    const diff = await comparer.compare({
      users: {
        tableName: 'users',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.tables'),
    );
    expect(diff.added_tables).toHaveLength(0);
  });

  it('treats PostgreSQL TEXT(db) vs JSON(manifest) as equivalent — no churn (#1335)', async () => {
    // SMRT stores JSON as serialized TEXT, so a `text` DB column already holds
    // exactly what a JSON manifest field expects. Rewriting it (`col::jsonb`)
    // is pure churn AND data-destroying when the text isn't valid JSON
    // (e.g. a legacy enum column holding 'active' → "invalid input syntax for
    // type json"). The differ must emit NO type_upgrade here.
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'documents' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'text', notnull: true },
          tags: { type: 'text', notnull: false },
        },
        indexes: [],
      }),
    };

    const pgComparer = new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
    });

    const manifest: Record<string, SchemaDefinition> = {
      documents: {
        tableName: 'documents',
        ddl: 'CREATE TABLE documents (id TEXT PRIMARY KEY, tags JSON);',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          tags: { type: 'JSON' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await pgComparer.compare(manifest);

    expect(diff.changes.filter((c) => c.type === 'type_upgrade')).toHaveLength(
      0,
    );
    expect(diff.changes.filter((c) => c.type === 'type_mismatch')).toHaveLength(
      0,
    );
    expect(diff.has_changes).toBe(false);
  });

  it('generates a value-safe to_jsonb cast when a TEXT→JSON upgrade is requested directly (#1335)', async () => {
    // The compare() path no longer reaches a TEXT→JSON upgrade (json/text are
    // equivalent), but the generator must still produce a value-safe cast for
    // any caller that constructs one explicitly — `to_jsonb(col)` wraps ANY
    // text as a JSON string and never raises on non-JSON legacy data, unlike
    // the old `col::jsonb`.
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [] }),
      getTableSchema: async () => null,
    };
    const pgComparer = new SchemaComparer(mockPostgresDb as any);

    const generated = (
      pgComparer as unknown as {
        generateTypeUpgradeSQL: (
          t: string,
          c: string,
          d: { type: string; defaultValue?: unknown },
          dbType: string,
        ) => { sql: string };
      }
    ).generateTypeUpgradeSQL('documents', 'tags', { type: 'JSON' }, 'text');

    expect(generated.sql).toContain('ALTER TABLE');
    expect(generated.sql).toContain('TYPE JSONB');
    expect(generated.sql).toContain('USING to_jsonb("tags")');
    expect(generated.sql).not.toContain('"tags"::jsonb');
    expect(generated.sql).not.toContain('"tags"::json ');
  });

  it('preserves PostgreSQL JSON defaults with a value-safe cast on a direct TEXT→JSON upgrade (#1335)', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [] }),
      getTableSchema: async () => null,
    };
    const pgComparer = new SchemaComparer(mockPostgresDb as any);

    const generated = (
      pgComparer as unknown as {
        generateTypeUpgradeSQL: (
          t: string,
          c: string,
          d: { type: string; defaultValue?: unknown },
          dbType: string,
        ) => { sql: string };
      }
    ).generateTypeUpgradeSQL(
      'documents',
      'metadata',
      { type: 'JSON', defaultValue: '{}' },
      'text',
    );

    expect(generated.sql).toContain('DROP DEFAULT');
    expect(generated.sql).toContain('TYPE JSONB');
    expect(generated.sql).toContain('USING to_jsonb("metadata")');
    expect(generated.sql).toContain("SET DEFAULT '{}'::jsonb");
  });

  it('should generate PostgreSQL ADD COLUMN SQL for JSON array defaults', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'contents' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'TEXT', notnull: true },
        },
        indexes: [],
      }),
    };

    const pgComparer = new SchemaComparer(mockPostgresDb as any);

    const manifest: Record<string, SchemaDefinition> = {
      contents: {
        tableName: 'contents',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          word_timings: { type: 'JSON', defaultValue: [] },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await pgComparer.compare(manifest);

    expect(diff.changes).toEqual([
      expect.objectContaining({
        type: 'add_column',
        table: 'contents',
        name: 'word_timings',
        sql: `ALTER TABLE "contents" ADD COLUMN "word_timings" JSONB DEFAULT '[]'`,
      }),
    ]);
  });

  it('splits a DuckDB unique column into ADD COLUMN + CREATE UNIQUE INDEX (DuckDB rejects inline UNIQUE) (#2369)', async () => {
    // DuckDB: `ALTER TABLE ... ADD COLUMN ... UNIQUE` → "Adding columns with
    // constraints not yet supported". The previous assertion enshrined that
    // rejected SQL; the plan must be executable instead.
    const mockDuckDb = {
      url: '/path/to/test.duckdb',
      query: async () => ({ rows: [{ name: 'users' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'TEXT', notnull: true },
        },
        indexes: [],
      }),
    };

    const duckComparer = new SchemaComparer(mockDuckDb as any);

    const manifest: Record<string, SchemaDefinition> = {
      users: {
        tableName: 'users',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          email: { type: 'TEXT', unique: true },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await duckComparer.compare(manifest);

    expect(diff.changes).toEqual([
      expect.objectContaining({
        type: 'add_column',
        table: 'users',
        name: 'email',
        sql: `ALTER TABLE "users" ADD COLUMN "email" TEXT`,
        sqlStatements: [
          `ALTER TABLE "users" ADD COLUMN "email" TEXT`,
          `CREATE UNIQUE INDEX "users_email_key" ON "users" ("email")`,
        ],
      }),
    ]);
    for (const sql of getSQLFromDiff(diff)) {
      expect(sql).not.toMatch(/ADD COLUMN .* UNIQUE/);
    }
  });

  it('should not emit PRIMARY KEY constraints in ADD COLUMN SQL', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'users' }] }),
      getTableSchema: async () => ({
        columns: {},
        indexes: [],
      }),
    };

    const pgComparer = new SchemaComparer(mockPostgresDb as any);

    const manifest: Record<string, SchemaDefinition> = {
      users: {
        tableName: 'users',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await pgComparer.compare(manifest);

    expect(diff.changes).toEqual([
      expect.objectContaining({
        type: 'add_column',
        table: 'users',
        name: 'id',
        sql: `ALTER TABLE "users" ADD COLUMN "id" TEXT`,
      }),
    ]);
  });

  it('should generate PostgreSQL USING clause for legacy JSON→TIMESTAMP drift', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'analytics_events' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'TEXT', notnull: true },
          created_at: { type: 'JSON', notnull: false },
        },
        indexes: [],
      }),
    };

    const pgComparer = new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
      postgresTimestampMigration: { legacyTimezone: 'UTC' },
    });

    const manifest: Record<string, SchemaDefinition> = {
      analytics_events: {
        tableName: 'analytics_events',
        ddl: 'CREATE TABLE analytics_events (id TEXT PRIMARY KEY, created_at TIMESTAMP);',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          created_at: { type: 'TIMESTAMP' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await pgComparer.compare(manifest);

    const typeUpgrades = diff.changes.filter((c) => c.type === 'type_upgrade');
    expect(typeUpgrades).toHaveLength(1);
    expect(typeUpgrades[0].sql).toContain('TYPE TIMESTAMPTZ');
    expect(typeUpgrades[0].sql).toContain(
      `USING NULLIF(NULLIF(trim(both '"' from "created_at"::text), ''), 'null')::timestamptz`,
    );
  });

  it('migrates legacy PostgreSQL TIMESTAMP wall times as UTC instants', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'settlements' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'uuid', notnull: true },
          settled_at: {
            type: 'timestamp without time zone',
            notnull: false,
          },
        },
        indexes: [],
      }),
    };

    const manifest: Record<string, SchemaDefinition> = {
      settlements: {
        tableName: 'settlements',
        ddl: '',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          settled_at: { type: 'TIMESTAMP' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
      postgresTimestampMigration: { legacyTimezone: 'UTC' },
    }).compare(manifest);

    expect(diff.changes).toEqual([
      expect.objectContaining({
        type: 'type_upgrade',
        table: 'settlements',
        name: 'settled_at',
        mismatch: {
          expected: 'TIMESTAMP',
          actual: 'timestamp without time zone',
        },
        sql:
          `ALTER TABLE "settlements" ALTER COLUMN "settled_at" ` +
          `TYPE TIMESTAMPTZ USING "settled_at" AT TIME ZONE 'UTC'`,
        sqlStatements: [
          expect.stringContaining("current_setting('TimeZone')"),
          `ALTER TABLE "settlements" ALTER COLUMN "settled_at" ` +
            `TYPE TIMESTAMPTZ USING "settled_at" AT TIME ZONE 'UTC'`,
        ],
      }),
    ]);
  });

  it('guards legacy PostgreSQL text timestamps with the UTC preflight', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'settlements' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'uuid', notnull: true },
          settled_at: { type: 'text', notnull: false },
        },
        indexes: [],
      }),
    };
    const manifest: Record<string, SchemaDefinition> = {
      settlements: {
        tableName: 'settlements',
        ddl: '',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          settled_at: { type: 'TIMESTAMP' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
      postgresTimestampMigration: { legacyTimezone: 'UTC' },
    }).compare(manifest);
    const change = diff.changes.find(
      (candidate) => candidate.name === 'settled_at',
    );

    expect(change).toEqual(
      expect.objectContaining({
        type: 'type_upgrade',
        sqlStatements: [
          expect.stringContaining("current_setting('TimeZone')"),
          expect.stringContaining('::timestamptz'),
        ],
      }),
    );
  });

  it('reports legacy PostgreSQL timestamps as manual drift without UTC provenance confirmation', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'settlements' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'uuid', notnull: true },
          settled_at: {
            type: 'timestamp without time zone',
            notnull: false,
          },
        },
        indexes: [],
      }),
    };
    const manifest: Record<string, SchemaDefinition> = {
      settlements: {
        tableName: 'settlements',
        ddl: '',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          settled_at: { type: 'TIMESTAMP' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
    }).compare(manifest);
    expect(diff.changes).toContainEqual(
      expect.objectContaining({
        type: 'type_mismatch',
        name: 'settled_at',
      }),
    );
    expect(getSQLFromDiff(diff)).toEqual([]);
  });

  it.each([
    ['sqlite', 'DATETIME(6)', 'TIMESTAMP'],
    ['duckdb', 'TIMESTAMP(6)', 'TIMESTAMP'],
    ['json', 'TIMESTAMP(6) WITHOUT TIME ZONE', 'TIMESTAMP'],
    ['postgres', 'TIMESTAMP(6) WITH TIME ZONE', 'TIMESTAMPTZ'],
  ] as const)('normalizes precision-qualified %s date type %s', (engine, input, expected) => {
    const db =
      engine === 'json'
        ? { url: '', exportTable: () => undefined }
        : { url: engine === 'postgres' ? 'postgresql://test' : ':memory:' };
    const comparer = new SchemaComparer(db as any, { engineHint: engine });
    const normalized = (
      comparer as unknown as { normalizeType: (type: string) => string }
    ).normalizeType(input);
    expect(normalized).toBe(expected);
  });

  it('accepts PostgreSQL TIMESTAMPTZ as the current Date representation', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'settlements' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'uuid', notnull: true },
          settled_at: { type: 'timestamp with time zone', notnull: false },
        },
        indexes: [],
      }),
    };

    const manifest: Record<string, SchemaDefinition> = {
      settlements: {
        tableName: 'settlements',
        ddl: '',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          settled_at: { type: 'TIMESTAMP' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
    }).compare(manifest);

    expect(diff.has_changes).toBe(false);
  });

  it('should generate PostgreSQL guarded USING clause for legacy TEXT→INTEGER drift', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'asset_associations' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'TEXT', notnull: true },
          sort_order: { type: 'TEXT', notnull: false },
        },
        indexes: [],
      }),
    };

    const pgComparer = new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
    });

    const manifest: Record<string, SchemaDefinition> = {
      asset_associations: {
        tableName: 'asset_associations',
        ddl: 'CREATE TABLE asset_associations (id TEXT PRIMARY KEY, sort_order INTEGER);',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          sort_order: { type: 'INTEGER' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await pgComparer.compare(manifest);

    const typeUpgrades = diff.changes.filter((c) => c.type === 'type_upgrade');
    expect(typeUpgrades).toHaveLength(1);
    expect(typeUpgrades[0].sql).toContain('ALTER TABLE');
    expect(typeUpgrades[0].sql).toContain('TYPE BIGINT');
    expect(typeUpgrades[0].sql).toContain(
      'USING trim("sort_order"::text)::bigint',
    );
    expect(typeUpgrades[0].sqlStatements).toHaveLength(2);
    expect(typeUpgrades[0].sqlStatements?.[0]).toContain(
      'DO $$ BEGIN IF EXISTS',
    );
    expect(typeUpgrades[0].sqlStatements?.[0]).toContain(
      `trim("sort_order"::text) !~ '^[+-]?[0-9]+$'`,
    );
    expect(typeUpgrades[0].sqlStatements?.[1]).toContain(
      'USING trim("sort_order"::text)::bigint',
    );
  });

  it('should generate PostgreSQL guarded USING clause for legacy REAL→INTEGER drift', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'ad_campaigns' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'TEXT', notnull: true },
          target_clicks: { type: 'REAL', notnull: false },
        },
        indexes: [],
      }),
    };

    const pgComparer = new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
    });

    const manifest: Record<string, SchemaDefinition> = {
      ad_campaigns: {
        tableName: 'ad_campaigns',
        ddl: 'CREATE TABLE ad_campaigns (id TEXT PRIMARY KEY, target_clicks INTEGER);',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          target_clicks: { type: 'INTEGER' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await pgComparer.compare(manifest);

    const typeUpgrades = diff.changes.filter((c) => c.type === 'type_upgrade');
    expect(typeUpgrades).toHaveLength(1);
    expect(typeUpgrades[0].sql).toContain('ALTER TABLE');
    expect(typeUpgrades[0].sql).toContain('TYPE BIGINT');
    expect(typeUpgrades[0].sql).toContain('USING "target_clicks"::bigint');
    expect(typeUpgrades[0].sqlStatements).toHaveLength(2);
    expect(typeUpgrades[0].sqlStatements?.[0]).toContain(
      'DO $$ BEGIN IF EXISTS',
    );
    expect(typeUpgrades[0].sqlStatements?.[0]).toContain(
      '"target_clicks" IS NOT NULL AND "target_clicks" <> trunc("target_clicks")',
    );
    expect(typeUpgrades[0].sqlStatements?.[1]).toContain(
      'USING "target_clicks"::bigint',
    );
  });

  it('treats DuckDB TEXT(db) vs JSON(manifest) as equivalent — no churn (#1335)', async () => {
    const mockDuckDb = {
      url: '/path/to/test.duckdb',
      query: async () => ({ rows: [{ name: 'records' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'TEXT', notnull: true },
          metadata: { type: 'TEXT', notnull: false },
        },
        indexes: [],
      }),
    };

    const duckComparer = new SchemaComparer(mockDuckDb as any, {
      ignoreTypeMismatches: false,
    });

    const manifest: Record<string, SchemaDefinition> = {
      records: {
        tableName: 'records',
        ddl: 'CREATE TABLE records (id TEXT PRIMARY KEY, metadata JSON);',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          metadata: { type: 'JSON' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await duckComparer.compare(manifest);

    // json<->text are interchangeable for SMRT — no migration needed.
    expect(diff.changes.filter((c) => c.type === 'type_upgrade')).toHaveLength(
      0,
    );
    expect(diff.has_changes).toBe(false);

    // The DuckDB generator still emits a native ALTER COLUMN TYPE (no USING)
    // when a TEXT→JSON upgrade is requested directly.
    const generated = (
      duckComparer as unknown as {
        generateTypeUpgradeSQL: (
          t: string,
          c: string,
          d: { type: string },
          dbType: string,
        ) => { sql: string };
      }
    ).generateTypeUpgradeSQL('records', 'metadata', { type: 'JSON' }, 'text');
    expect(generated.sql).toContain('ALTER TABLE');
    expect(generated.sql).toContain('TYPE JSON');
    expect(generated.sql).not.toContain('USING');
  });

  it('should generate SQLite no-op comment for TEXT→JSON', async () => {
    // Create a mock database interface that identifies as SQLite
    const mockSqliteDb = {
      url: ':memory:',
      // Return table name from query so getExistingTables() knows it exists
      query: async () => ({ rows: [{ name: 'items' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'TEXT', notnull: true },
          data: { type: 'TEXT', notnull: false },
        },
        indexes: [],
      }),
    };

    const sqliteComparer = new SchemaComparer(mockSqliteDb as any, {
      ignoreTypeMismatches: false,
    });

    const manifest: Record<string, SchemaDefinition> = {
      items: {
        tableName: 'items',
        ddl: 'CREATE TABLE items (id TEXT PRIMARY KEY, data JSON);',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          data: { type: 'JSON' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const diff = await sqliteComparer.compare(manifest);

    // SQLite maps JSON to TEXT, so there should be no changes
    // (the types match after engine-specific mapping)
    expect(diff.has_changes).toBe(false);
  });
});

/**
 * #2361 — rate fields (`InvoiceLineItem.taxRate`, `FactEvidence.confidence`)
 * shipped as INTEGER columns because `= 0` compiles to integer, which truncates
 * every rate. The models now declare `0.0`, so existing deployments need the
 * widening migration to actually be emitted. INTEGER→REAL is already
 * whitelisted as a compatible upgrade; these lock in that the upgrade reaches
 * the diff and produces engine-correct SQL.
 *
 * Money went the other way and stays INTEGER (minor units), so the integer
 * column below is not incidental — it stands for the money columns on the same
 * table, which this migration must leave completely alone.
 */
describe('SchemaComparer INTEGER→REAL widening for rate columns (#2361)', () => {
  const invoiceManifest = (): Record<string, SchemaDefinition> => ({
    invoice_line_items: {
      tableName: 'invoice_line_items',
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        // What `taxRate: number = 0.0` now compiles to.
        tax_rate: { type: 'REAL', defaultValue: 0 },
        // Money stays INTEGER minor units and must not be disturbed.
        unit_price: { type: 'INTEGER', defaultValue: 0 },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  });

  /** A deployed table whose `tax_rate` column is still INTEGER. */
  const legacyColumns = (integerType: string) => ({
    id: { type: 'text', notnull: true },
    tax_rate: { type: integerType, notnull: false },
    unit_price: { type: integerType, notnull: false },
  });

  it('emits an ALTER … TYPE DOUBLE PRECISION on PostgreSQL', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'invoice_line_items' }] }),
      getTableSchema: async () => ({
        columns: legacyColumns('integer'),
        indexes: [],
      }),
    };

    const diff = await new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
    }).compare(invoiceManifest());

    const typeUpgrades = diff.changes.filter((c) => c.type === 'type_upgrade');
    expect(typeUpgrades).toHaveLength(1);
    expect(typeUpgrades[0].name).toBe('tax_rate');
    expect(typeUpgrades[0].mismatch).toEqual({
      expected: 'REAL',
      actual: 'integer',
    });
    expect(typeUpgrades[0].sql).toContain('ALTER TABLE "invoice_line_items"');
    expect(typeUpgrades[0].sql).toContain(
      'ALTER COLUMN "tax_rate" TYPE DOUBLE PRECISION',
    );
    // PostgreSQL casts integer to double precision implicitly, so a USING
    // clause would be noise; the default is cycled so it can be re-typed.
    expect(typeUpgrades[0].sql).not.toContain('USING');
    expect(typeUpgrades[0].sql).toContain('DROP DEFAULT');
    expect(typeUpgrades[0].sql).toContain('SET DEFAULT');

    // The widening must not be mistaken for drift on the real integer column.
    expect(diff.changes.filter((c) => c.type === 'type_mismatch')).toEqual([]);
  });

  it('emits a native ALTER COLUMN TYPE on DuckDB', async () => {
    const mockDuckDb = {
      url: '/path/to/test.duckdb',
      query: async () => ({ rows: [{ name: 'invoice_line_items' }] }),
      getTableSchema: async () => ({
        columns: legacyColumns('BIGINT'),
        indexes: [],
      }),
    };

    const diff = await new SchemaComparer(mockDuckDb as any, {
      ignoreTypeMismatches: false,
    }).compare(invoiceManifest());

    const typeUpgrades = diff.changes.filter((c) => c.type === 'type_upgrade');
    expect(typeUpgrades).toHaveLength(1);
    expect(typeUpgrades[0].name).toBe('tax_rate');
    // DuckDB maps the abstract REAL straight through; exact-decimal semantics
    // remain intentionally outside the INTEGER/BIGINT contract.
    expect(typeUpgrades[0].sql).toBe(
      'ALTER TABLE "invoice_line_items" ALTER COLUMN "tax_rate" TYPE REAL',
    );
  });

  it('plans an executable SQLite rebuild that leaves the money column INTEGER', async () => {
    // SQLite has no ALTER COLUMN TYPE, so #2370 rebuilds the table. That needs
    // the real `CREATE TABLE` out of `sqlite_master`, so this runs against a
    // live in-memory database rather than a mock — a synthetic schema makes the
    // planner (correctly) refuse for want of a DDL statement to rewrite.
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      await db.query(
        `CREATE TABLE "invoice_line_items" (
          "id" TEXT PRIMARY KEY,
          "tax_rate" INTEGER DEFAULT 0,
          "unit_price" INTEGER DEFAULT 0
        )`,
      );
      await db.query(
        `INSERT INTO "invoice_line_items" ("id", "tax_rate", "unit_price") VALUES ('li-1', 0, 14999)`,
      );

      const diff = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      }).compare(invoiceManifest());

      const typeUpgrades = diff.changes.filter(
        (c) => c.type === 'type_upgrade',
      );
      expect(typeUpgrades).toHaveLength(1);
      expect(typeUpgrades[0].name).toBe('tax_rate');

      // A real rebuild, not the old advisory comment.
      const statements = typeUpgrades[0].sqlStatements ?? [];
      expect(statements.some((s) => s.startsWith('--'))).toBe(false);
      expect(
        statements.some((s) =>
          /^CREATE TABLE "_smrt_rebuild_invoice_line_items"/.test(s),
        ),
      ).toBe(true);

      // The rebuild retypes only the rate. Money must survive as INTEGER —
      // widening it to REAL would silently reintroduce float money.
      const createStatement = statements.find((s) =>
        s.startsWith('CREATE TABLE "_smrt_rebuild_invoice_line_items"'),
      ) as string;
      expect(createStatement).toMatch(/"tax_rate"\s+REAL/);
      expect(createStatement).toMatch(/"unit_price"\s+INTEGER/);

      for (const statement of statements) {
        await db.query(statement);
      }

      // Rows survive, the rate is now REAL-affinity, and the money value is
      // still an exact integer.
      const rows = (
        await db.query(
          `SELECT "unit_price", typeof("unit_price") AS price_type, typeof("tax_rate") AS rate_type FROM "invoice_line_items"`,
        )
      ).rows as {
        unit_price: number;
        price_type: string;
        rate_type: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].unit_price).toBe(14999);
      expect(rows[0].price_type).toBe('integer');
      expect(rows[0].rate_type).toBe('real');

      // And the drift is gone on a re-diff.
      const reDiff = await new SchemaComparer(db, {
        ignoreTypeMismatches: false,
      }).compare(invoiceManifest());
      expect(
        reDiff.changes.filter((c) => c.type === 'type_upgrade'),
      ).toHaveLength(0);
    } finally {
      await db.close?.();
    }
  });

  it('is a no-op once the column is already REAL', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'invoice_line_items' }] }),
      // The live defaults have to be reported too: #2369 compares them, so a
      // fixture that omits them describes a database that has drifted, not a
      // converged one.
      getTableSchema: async () => ({
        columns: {
          id: { type: 'text', notnull: true },
          tax_rate: {
            type: 'double precision',
            notnull: false,
            defaultValue: 0,
          },
          unit_price: { type: 'integer', notnull: false, defaultValue: 0 },
        },
        indexes: [],
      }),
    };

    const diff = await new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
    }).compare(invoiceManifest());

    expect(diff.changes).toEqual([]);
    expect(diff.has_changes).toBe(false);
  });
});

describe('SchemaComparer rename_data_pending (#2752)', () => {
  let db: DatabaseProvider;

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  function widgetManifest(): Record<string, SchemaDefinition> {
    return {
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          new_slug: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };
  }

  it('emits an operator-mediated copy-then-drop advisory for a same-type (text) rename on SQLite', async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      `CREATE TABLE widgets (id TEXT PRIMARY KEY, new_slug TEXT, old_slug TEXT)`,
    );
    await db.query(
      `INSERT INTO widgets (id, new_slug, old_slug) VALUES ('1', NULL, 'hello')`,
    );

    const comparer = new SchemaComparer(db);
    const diff = await comparer.compare(widgetManifest());

    const change = diff.changes.find(
      (c) => c.type === 'rename_data_pending' && c.name === 'new_slug',
    );
    expect(change).toBeDefined();
    expect(change?.advisory?.severity).toBe('warning');
    expect(change?.sql).toBeUndefined();
    expect(change?.sqlStatements).toBeUndefined();

    // Neither engine can make an UPDATE naming a specific column
    // conditional on that column's existence in plain SQL, so the guard
    // query runs FIRST and covers the whole repair (UPDATE + DROP), not
    // just the DROP (#2752 review findings P1/P2).
    const suggested = change?.advisory?.suggestedSql ?? [];
    expect(suggested).toHaveLength(3);
    expect(suggested[0]).toContain('pragma_table_info');
    expect(suggested[0]).toContain("'old_slug'");
    expect(suggested[1]).toContain(
      'UPDATE "widgets" SET "new_slug" = "old_slug"',
    );
    expect(suggested[1]).toContain(
      '"new_slug" IS NULL OR CAST("new_slug" AS TEXT) = \'\'',
    );
    expect(suggested[1]).toContain('"old_slug" IS NOT NULL');
    expect(suggested[2]).toBe('ALTER TABLE "widgets" DROP COLUMN "old_slug"');
  });

  it('uses a CAST-based emptiness predicate for a same-type non-text rename (#2752 review finding P1)', async () => {
    // A raw `col = ''` predicate is invalid SQL for a non-text column type
    // (PostgreSQL rejects it before any row is even considered); the
    // predicate must go through CAST(... AS TEXT) instead, matching the
    // detection probe.
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      `CREATE TABLE widgets (id TEXT PRIMARY KEY, new_count INTEGER, old_count INTEGER)`,
    );
    await db.query(
      `INSERT INTO widgets (id, new_count, old_count) VALUES ('1', NULL, 7)`,
    );

    const manifest: Record<string, SchemaDefinition> = {
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          new_count: { type: 'INTEGER' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const comparer = new SchemaComparer(db);
    const diff = await comparer.compare(manifest);

    const change = diff.changes.find(
      (c) => c.type === 'rename_data_pending' && c.name === 'new_count',
    );
    expect(change).toBeDefined();
    const suggested = change?.advisory?.suggestedSql ?? [];
    expect(suggested[1]).toContain(
      '"new_count" IS NULL OR CAST("new_count" AS TEXT) = \'\'',
    );
    expect(suggested[1]).not.toContain('"new_count" = \'\'');
  });

  it('does not flag it when the declared column already holds data', async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      `CREATE TABLE widgets (id TEXT PRIMARY KEY, new_slug TEXT, old_slug TEXT)`,
    );
    await db.query(
      `INSERT INTO widgets (id, new_slug, old_slug) VALUES ('1', 'already-set', 'hello')`,
    );

    const comparer = new SchemaComparer(db);
    const diff = await comparer.compare(widgetManifest());

    expect(
      diff.changes.find((c) => c.type === 'rename_data_pending'),
    ).toBeUndefined();
  });

  it('casts old -> new with ::uuid when the declared column is native uuid (PostgreSQL)', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'widgets' }] };
        }
        if (sql.includes('SELECT 1 AS present')) {
          if (sql.includes('"new_id"')) return { rows: [] };
          if (sql.includes('"old_id"')) return { rows: [{ present: 1 }] };
          return { rows: [] };
        }
        if (sql.includes('invalid_count')) {
          return { rows: [{ invalid_count: 0 }] };
        }
        return { rows: [] };
      },
      getTableSchema: async () => ({
        columns: {
          id: { type: 'uuid', notNull: true, primaryKey: true },
          new_id: { type: 'uuid', notNull: false, primaryKey: false },
          old_id: { type: 'text', notNull: false, primaryKey: false },
        },
        indexes: [],
      }),
    };

    const manifest: Record<string, SchemaDefinition> = {
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          new_id: { type: 'UUID' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const pgComparer = new SchemaComparer(mockPostgresDb as any);
    const diff = await pgComparer.compare(manifest);

    const change = diff.changes.find(
      (c) => c.type === 'rename_data_pending' && c.name === 'new_id',
    );
    expect(change).toBeDefined();
    // PostgreSQL gets a single, genuinely idempotent `DO $$ ... $$` block
    // (#2752 review finding P2): the existence check and both the UPDATE
    // and the DROP live inside the same conditional, so rerunning the one
    // statement after the rename is complete is a real no-op.
    const suggested = change?.advisory?.suggestedSql ?? [];
    expect(suggested).toHaveLength(1);
    expect(suggested[0]).toContain('DO $$ BEGIN IF EXISTS');
    expect(suggested[0]).toContain('information_schema.columns');
    // Scoped to the `public` schema (#2752 review finding): an unscoped
    // check would match a same-named table/column in another schema.
    expect(suggested[0]).toContain("table_schema = 'public'");
    expect(suggested[0]).toContain("'old_id'");
    expect(suggested[0]).toContain('"new_id" = "old_id"::uuid');
    expect(suggested[0]).toContain('"new_id" IS NULL');
    expect(suggested[0]).toContain(
      'ALTER TABLE "widgets" DROP COLUMN "old_id"',
    );
    expect(suggested[0]).toContain('END IF; END $$');
  });

  it('does not emit an advisory when the old column has non-UUID-shaped values', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'widgets' }] };
        }
        if (sql.includes('SELECT 1 AS present')) {
          if (sql.includes('"new_id"')) return { rows: [] };
          if (sql.includes('"old_id"')) return { rows: [{ present: 1 }] };
          return { rows: [] };
        }
        if (sql.includes('invalid_count')) {
          return { rows: [{ invalid_count: 2 }] };
        }
        return { rows: [] };
      },
      getTableSchema: async () => ({
        columns: {
          id: { type: 'uuid', notNull: true, primaryKey: true },
          new_id: { type: 'uuid', notNull: false, primaryKey: false },
          old_id: { type: 'text', notNull: false, primaryKey: false },
        },
        indexes: [],
      }),
    };

    const manifest: Record<string, SchemaDefinition> = {
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          new_id: { type: 'UUID' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const pgComparer = new SchemaComparer(mockPostgresDb as any);
    const diff = await pgComparer.compare(manifest);

    expect(
      diff.changes.find((c) => c.type === 'rename_data_pending'),
    ).toBeUndefined();
  });

  it('does not flag a logical-UUID column on SQLite when the orphan text column is not UUID-shaped (#2767 review)', async () => {
    // SQLite has no native uuid type, so `mapType('UUID')` maps a manifest
    // UUID column down to physical TEXT — same as any other declared TEXT
    // column. Before the #2767 fix, `declaredNormalized` alone could not
    // tell these apart, so a logical UUID column matched any TEXT-typed
    // orphan as `same-type` and skipped the UUID shape probe entirely,
    // suggesting a repair that copies arbitrary non-UUID text into a
    // logically UUID column. This asserts no advisory is emitted for an
    // orphan column whose data is plainly not UUID-shaped.
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      `CREATE TABLE widgets (id TEXT PRIMARY KEY, new_id TEXT, old_id TEXT)`,
    );
    await db.query(
      `INSERT INTO widgets (id, new_id, old_id) VALUES ('1', NULL, 'not-a-uuid')`,
    );

    const manifest: Record<string, SchemaDefinition> = {
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          new_id: { type: 'UUID' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const comparer = new SchemaComparer(db);
    const diff = await comparer.compare(manifest);

    expect(
      diff.changes.find((c) => c.type === 'rename_data_pending'),
    ).toBeUndefined();
  });

  it('flags a logical-UUID column on SQLite when the orphan text column is UUID-shaped', async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      `CREATE TABLE widgets (id TEXT PRIMARY KEY, new_id TEXT, old_id TEXT)`,
    );
    await db.query(
      `INSERT INTO widgets (id, new_id, old_id) VALUES ('1', NULL, '123e4567-e89b-12d3-a456-426614174000')`,
    );

    const manifest: Record<string, SchemaDefinition> = {
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          new_id: { type: 'UUID' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const comparer = new SchemaComparer(db);
    const diff = await comparer.compare(manifest);

    const change = diff.changes.find(
      (c) => c.type === 'rename_data_pending' && c.name === 'new_id',
    );
    expect(change).toBeDefined();

    // SQLite has no `::uuid` cast syntax and no native uuid type: even
    // though this declared column is logically a UUID (and needed the
    // shape probe above), the emitted repair must still be a plain text
    // copy with the ordinary `CAST(...) = ''` empty predicate, not the
    // PostgreSQL-only `::uuid` cast / NULL-only predicate (#2767 review,
    // final-pass P1 — the two were previously conflated).
    const suggested = change?.advisory?.suggestedSql ?? [];
    const copyStatement = suggested.find((sql) => sql.includes('UPDATE'));
    expect(copyStatement).toBeDefined();
    expect(copyStatement).not.toContain('::uuid');
    expect(copyStatement).toContain('"new_id" = "old_id"');
    expect(copyStatement).toContain(
      `("new_id" IS NULL OR CAST("new_id" AS TEXT) = '')`,
    );
  });

  it('withholds repair SQL and lists every candidate when the rename source is ambiguous (#2767 review)', async () => {
    // Two undeclared columns are both populated and type-compatible with
    // the same empty declared column: the rename source cannot be inferred,
    // so this must not emit a separate destructive advisory per candidate
    // (which an operator could run all of, merging data in output order and
    // dropping every candidate column).
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      `CREATE TABLE widgets (id TEXT PRIMARY KEY, new_slug TEXT, old_slug TEXT, older_slug TEXT)`,
    );
    await db.query(
      `INSERT INTO widgets (id, new_slug, old_slug, older_slug) VALUES ('1', NULL, 'hello', 'world')`,
    );

    const manifest: Record<string, SchemaDefinition> = {
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          new_slug: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const comparer = new SchemaComparer(db);
    const diff = await comparer.compare(manifest);

    const matches = diff.changes.filter(
      (c) => c.type === 'rename_data_pending' && c.name === 'new_slug',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].advisory?.suggestedSql).toBeUndefined();
    expect(matches[0].mismatch?.actual).toContain('old_slug');
    expect(matches[0].mismatch?.actual).toContain('older_slug');
  });
});

describe('hasActionableChanges', () => {
  it('should return true when there are added tables', () => {
    const diff: SchemaDiff = {
      has_changes: true,
      added_tables: [
        {
          tableName: 'test',
          ddl: '',
          columns: {},
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      ],
      dropped_tables: [],
      changes: [],
    };

    expect(hasActionableChanges(diff)).toBe(true);
  });

  it('should return true for column additions', () => {
    const diff: SchemaDiff = {
      has_changes: true,
      added_tables: [],
      dropped_tables: [],
      changes: [
        {
          type: 'add_column',
          table: 'users',
          name: 'email',
          column: { type: 'TEXT' },
        },
      ],
    };

    expect(hasActionableChanges(diff)).toBe(true);
  });

  it('should return true for index additions', () => {
    const diff: SchemaDiff = {
      has_changes: true,
      added_tables: [],
      dropped_tables: [],
      changes: [
        {
          type: 'add_index',
          table: 'users',
          name: 'idx_email',
          index: { name: 'idx_email', columns: ['email'], unique: false },
        },
      ],
    };

    expect(hasActionableChanges(diff)).toBe(true);
  });

  it('should return false when no changes', () => {
    const diff: SchemaDiff = {
      has_changes: false,
      added_tables: [],
      dropped_tables: [],
      changes: [],
    };

    expect(hasActionableChanges(diff)).toBe(false);
  });

  it('should return false when only type mismatches', () => {
    const diff: SchemaDiff = {
      has_changes: true,
      added_tables: [],
      dropped_tables: [],
      changes: [
        {
          type: 'type_mismatch',
          table: 'users',
          name: 'age',
          mismatch: { expected: 'TEXT', actual: 'INTEGER' },
        },
      ],
    };

    // Type mismatches are not "actionable" automatically
    expect(hasActionableChanges(diff)).toBe(false);
  });

  it('should return true for type upgrades', () => {
    const diff: SchemaDiff = {
      has_changes: true,
      added_tables: [],
      dropped_tables: [],
      changes: [
        {
          type: 'type_upgrade',
          table: 'documents',
          name: 'tags',
          mismatch: { expected: 'JSON', actual: 'TEXT' },
          sql: 'ALTER TABLE "documents" ALTER COLUMN "tags" TYPE JSONB USING "tags"::jsonb',
        },
      ],
    };

    // Type upgrades ARE actionable (they have executable SQL)
    expect(hasActionableChanges(diff)).toBe(true);
  });
});

describe('getSQLFromDiff', () => {
  it('should return SQL statements for column changes', () => {
    const diff: SchemaDiff = {
      has_changes: true,
      added_tables: [],
      dropped_tables: [],
      changes: [
        {
          type: 'add_column',
          table: 'users',
          name: 'email',
          column: { type: 'TEXT' },
          sql: 'ALTER TABLE "users" ADD COLUMN "email" TEXT',
        },
      ],
    };

    const sql = getSQLFromDiff(diff);

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('ALTER TABLE');
    expect(sql[0]).toContain('email');
  });

  it('should return SQL statements for index changes', () => {
    const diff: SchemaDiff = {
      has_changes: true,
      added_tables: [],
      dropped_tables: [],
      changes: [
        {
          type: 'add_index',
          table: 'users',
          name: 'idx_users_email',
          index: { name: 'idx_users_email', columns: ['email'], unique: false },
          sql: 'CREATE INDEX "idx_users_email" ON "users" ("email")',
        },
      ],
    };

    const sql = getSQLFromDiff(diff);

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('CREATE INDEX');
  });

  it('should skip type mismatches', () => {
    const diff: SchemaDiff = {
      has_changes: true,
      added_tables: [],
      dropped_tables: [],
      changes: [
        {
          type: 'type_mismatch',
          table: 'users',
          name: 'age',
          mismatch: { expected: 'TEXT', actual: 'INTEGER' },
          sql: '-- Type mismatch',
        },
      ],
    };

    const sql = getSQLFromDiff(diff);

    expect(sql).toHaveLength(0);
  });

  it('should include type upgrades with executable SQL', () => {
    const diff: SchemaDiff = {
      has_changes: true,
      added_tables: [],
      dropped_tables: [],
      changes: [
        {
          type: 'type_upgrade',
          table: 'documents',
          name: 'tags',
          mismatch: { expected: 'JSON', actual: 'TEXT' },
          sql: 'ALTER TABLE "documents" ALTER COLUMN "tags" TYPE JSONB USING "tags"::jsonb',
        },
      ],
    };

    const sql = getSQLFromDiff(diff);

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('ALTER TABLE');
    expect(sql[0]).toContain('TYPE JSONB');
  });

  it('should flatten multi-step SQL statements for executable changes', () => {
    const diff: SchemaDiff = {
      has_changes: true,
      added_tables: [],
      dropped_tables: [],
      changes: [
        {
          type: 'type_upgrade',
          table: 'ad_campaigns',
          name: 'target_clicks',
          mismatch: { expected: 'INTEGER', actual: 'REAL' },
          sql: 'ALTER TABLE "ad_campaigns" ALTER COLUMN "target_clicks" TYPE BIGINT USING "target_clicks"::bigint',
          sqlStatements: [
            'DO $$ BEGIN IF EXISTS (SELECT 1 FROM "ad_campaigns" WHERE "target_clicks" IS NOT NULL AND "target_clicks" <> trunc("target_clicks")) THEN RAISE EXCEPTION \'Cannot convert ad_campaigns.target_clicks to INTEGER: found non-integer values\'; END IF; END $$',
            'ALTER TABLE "ad_campaigns" ALTER COLUMN "target_clicks" TYPE BIGINT USING "target_clicks"::bigint',
          ],
        },
      ],
    };

    const sql = getSQLFromDiff(diff);

    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('DO $$ BEGIN IF EXISTS');
    expect(sql[1]).toContain('ALTER TABLE');
  });

  it('should return empty arrays for no changes', () => {
    const diff: SchemaDiff = {
      has_changes: false,
      added_tables: [],
      dropped_tables: [],
      changes: [],
    };

    const sql = getSQLFromDiff(diff);

    expect(sql).toHaveLength(0);
  });
});

/**
 * #2770 — REAL and DOUBLE PRECISION both normalize into the differ's shared
 * 'REAL' bucket (matching DECIMAL/NUMERIC), so single- vs double-precision
 * float drift never reached the ordinary type-mismatch gate. Widening
 * (float4 -> float8) is lossless and auto-planned; narrowing stays
 * advisory-only because it can lose precision.
 */
describe('SchemaComparer float-width drift (#2770)', () => {
  const priceManifest = (): Record<string, SchemaDefinition> => ({
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

  it('plans a lossless widening ALTER when the live column is single-precision', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'products' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'text', notnull: true },
          price: { type: 'real', notnull: false },
        },
        indexes: [],
      }),
    };

    const diff = await new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
    }).compare(priceManifest());

    const typeUpgrades = diff.changes.filter((c) => c.type === 'type_upgrade');
    expect(typeUpgrades).toHaveLength(1);
    expect(typeUpgrades[0].name).toBe('price');
    expect(typeUpgrades[0].advisory).toBeUndefined();
    expect(typeUpgrades[0].sql).toBe(
      'ALTER TABLE "products" ALTER COLUMN "price" TYPE DOUBLE PRECISION USING "price"::DOUBLE PRECISION',
    );
    expect(diff.changes.filter((c) => c.type === 'type_mismatch')).toEqual([]);
    expect(diff.has_changes).toBe(true);
  });

  it('reports narrowing (double precision -> real) as an advisory only, never executable', async () => {
    // Unreachable through the ordinary manifest pipeline on PostgreSQL (the
    // abstract REAL type always maps to DOUBLE PRECISION there), but DuckDB's
    // base strategy maps REAL straight through, so a legacy DuckDB column
    // that was widened by hand to DOUBLE is a real narrowing candidate.
    const mockDuckDb = {
      url: '/path/to/test.duckdb',
      query: async () => ({ rows: [{ name: 'products' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'VARCHAR', notnull: true },
          price: { type: 'DOUBLE', notnull: false },
        },
        indexes: [],
      }),
    };

    const diff = await new SchemaComparer(mockDuckDb as any, {
      ignoreTypeMismatches: false,
    }).compare(priceManifest());

    const typeUpgrades = diff.changes.filter((c) => c.type === 'type_upgrade');
    expect(typeUpgrades).toHaveLength(1);
    expect(typeUpgrades[0].sql).toBeUndefined();
    expect(typeUpgrades[0].sqlStatements).toBeUndefined();
    expect(typeUpgrades[0].advisory?.severity).toBe('warning');
    expect(typeUpgrades[0].advisory?.message).toContain('Narrowing');
    expect(getSQLFromDiff(diff)).toEqual([]);
    expect(diff.has_changes).toBe(true);
  });

  it('is a no-op once the live column already matches the declared precision', async () => {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async () => ({ rows: [{ table_name: 'products' }] }),
      getTableSchema: async () => ({
        columns: {
          id: { type: 'text', notnull: true },
          price: { type: 'double precision', notnull: false },
        },
        indexes: [],
      }),
    };

    const diff = await new SchemaComparer(mockPostgresDb as any, {
      ignoreTypeMismatches: false,
    }).compare(priceManifest());

    expect(diff.changes.filter((c) => c.type === 'type_upgrade')).toEqual([]);
    expect(diff.changes.filter((c) => c.type === 'type_mismatch')).toEqual([]);
    expect(diff.has_changes).toBe(false);
  });
});
