/**
 * SchemaComparer Tests
 *
 * Tests for schema comparison and diff generation.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('should preserve DuckDB UNIQUE constraints in ADD COLUMN SQL', async () => {
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
        sql: `ALTER TABLE "users" ADD COLUMN "email" TEXT UNIQUE`,
      }),
    ]);
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
    expect(typeUpgrades[0].sql).toContain('TYPE TIMESTAMP');
    expect(typeUpgrades[0].sql).toContain(
      `USING NULLIF(NULLIF(trim(both '"' from "created_at"::text), ''), 'null')::timestamp`,
    );
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
    expect(typeUpgrades[0].sql).toContain('TYPE INTEGER');
    expect(typeUpgrades[0].sql).toContain(
      'USING trim("sort_order"::text)::integer',
    );
    expect(typeUpgrades[0].sqlStatements).toHaveLength(2);
    expect(typeUpgrades[0].sqlStatements?.[0]).toContain(
      'DO $$ BEGIN IF EXISTS',
    );
    expect(typeUpgrades[0].sqlStatements?.[0]).toContain(
      `trim("sort_order"::text) !~ '^[+-]?[0-9]+$'`,
    );
    expect(typeUpgrades[0].sqlStatements?.[1]).toContain(
      'USING trim("sort_order"::text)::integer',
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
    expect(typeUpgrades[0].sql).toContain('TYPE INTEGER');
    expect(typeUpgrades[0].sql).toContain('USING "target_clicks"::integer');
    expect(typeUpgrades[0].sqlStatements).toHaveLength(2);
    expect(typeUpgrades[0].sqlStatements?.[0]).toContain(
      'DO $$ BEGIN IF EXISTS',
    );
    expect(typeUpgrades[0].sqlStatements?.[0]).toContain(
      '"target_clicks" IS NOT NULL AND "target_clicks" <> trunc("target_clicks")',
    );
    expect(typeUpgrades[0].sqlStatements?.[1]).toContain(
      'USING "target_clicks"::integer',
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
          sql: 'ALTER TABLE "ad_campaigns" ALTER COLUMN "target_clicks" TYPE INTEGER USING "target_clicks"::integer',
          sqlStatements: [
            'DO $$ BEGIN IF EXISTS (SELECT 1 FROM "ad_campaigns" WHERE "target_clicks" IS NOT NULL AND "target_clicks" <> trunc("target_clicks")) THEN RAISE EXCEPTION \'Cannot convert ad_campaigns.target_clicks to INTEGER: found non-integer values\'; END IF; END $$',
            'ALTER TABLE "ad_campaigns" ALTER COLUMN "target_clicks" TYPE INTEGER USING "target_clicks"::integer',
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
