/**
 * SchemaComparer Tests
 *
 * Tests for schema comparison and diff generation.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

    it('should detect JSON→TEXT as type_upgrade', async () => {
      // Create table with JSON column (some engines support this natively)
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

      // JSON → TEXT is a safe type upgrade
      const typeUpgrades = diff.changes.filter(
        (c) => c.type === 'type_upgrade',
      );
      expect(typeUpgrades).toHaveLength(1);
      expect(typeUpgrades[0].name).toBe('metadata');
      expect(typeUpgrades[0].mismatch?.expected).toBe('TEXT');
      expect(typeUpgrades[0].mismatch?.actual).toBe('JSON');
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
