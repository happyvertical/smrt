/**
 * MigrationGenerator Tests
 *
 * Tests for migration file generation from diffs.
 */

import { describe, expect, it } from 'vitest';
import type { SchemaDefinition, SchemaDiff } from '../../schema/types.js';
import {
  createMigrationDefinition,
  generateMigrationSequence,
  generateMigrationTimestamp,
  MigrationGenerator,
} from '../generator.js';

describe('MigrationGenerator', () => {
  describe('generateFromDiff', () => {
    it('should generate SQL migration from diff with new table', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [
          {
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
          } as SchemaDefinition,
        ],
        dropped_tables: [],
        changes: [],
      };

      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateFromDiff(diff, {
        name: '0001_add_users',
        description: 'Add users table',
      });

      expect(migration.filename).toBe('0001_add_users.sql');
      expect(migration.up.join('\n')).toContain('CREATE TABLE');
      expect(migration.down.join('\n')).toContain('DROP TABLE');
      expect(migration.content).toContain('-- @up');
      expect(migration.content).toContain('-- @down');
      expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate SQL migration for column additions', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'add_column',
            table: 'users',
            name: 'email',
            column: { type: 'TEXT', notNull: false },
          },
          {
            type: 'add_column',
            table: 'users',
            name: 'age',
            column: { type: 'INTEGER', notNull: true },
          },
        ],
      };

      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateFromDiff(diff, {
        name: '0002_add_user_fields',
        description: 'Add email and age to users',
      });

      expect(migration.up.join('\n')).toContain('ADD COLUMN');
      expect(migration.up.join('\n')).toContain('email');
      expect(migration.up.join('\n')).toContain('age');
    });

    it('should generate SQL migration for index additions', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'add_index',
            table: 'users',
            name: 'idx_users_email',
            index: {
              name: 'idx_users_email',
              columns: ['email'],
              unique: false,
            },
          },
          {
            type: 'add_index',
            table: 'users',
            name: 'idx_users_name_unique',
            index: {
              name: 'idx_users_name_unique',
              columns: ['name'],
              unique: true,
            },
          },
        ],
      };

      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateFromDiff(diff, {
        name: '0003_add_indexes',
        description: 'Add indexes to users',
      });

      expect(migration.up.join('\n')).toContain('CREATE INDEX');
      expect(migration.up.join('\n')).toContain('idx_users_email');
      expect(migration.up.join('\n')).toContain('UNIQUE INDEX');
      expect(migration.down.join('\n')).toContain('DROP INDEX');
    });

    it('should generate TypeScript migration format', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [
          {
            tableName: 'profiles',
            ddl: 'CREATE TABLE profiles (id TEXT PRIMARY KEY);',
            columns: { id: { type: 'TEXT', primaryKey: true } },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            dependencies: [],
            version: '1.0.0',
          } as SchemaDefinition,
        ],
        dropped_tables: [],
        changes: [],
      };

      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'typescript',
        includeDown: true,
      });

      const migration = generator.generateFromDiff(diff, {
        name: '0001_add_profiles',
        description: 'Add profiles table',
        format: 'typescript',
      });

      expect(migration.filename).toBe('0001_add_profiles.ts');
      expect(migration.content).toContain('import type { Migration }');
      expect(migration.content).toContain('export default {');
      expect(migration.content).toContain("id: '0001_add_profiles'");
      expect(migration.content).toContain('up:');
      expect(migration.content).toContain('down:');
    });

    it('should handle empty diff', () => {
      const diff: SchemaDiff = {
        has_changes: false,
        added_tables: [],
        dropped_tables: [],
        changes: [],
      };

      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateFromDiff(diff, {
        name: '0001_empty',
        description: 'Empty migration',
      });

      expect(migration.up).toHaveLength(0);
      expect(migration.down).toHaveLength(0);
    });
  });

  describe('generateFromSQL', () => {
    it('should wrap SQL in migration format', () => {
      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateFromSQL(
        ['CREATE TABLE test (id TEXT);', 'CREATE INDEX idx_test ON test(id);'],
        ['DROP INDEX idx_test;', 'DROP TABLE test;'],
        {
          name: '0001_test',
          description: 'Test migration',
        },
      );

      expect(migration.up).toHaveLength(2);
      expect(migration.down).toHaveLength(2);
      expect(migration.content).toContain('CREATE TABLE test');
      expect(migration.content).toContain('DROP TABLE test');
    });
  });

  describe('generateEmpty', () => {
    it('should create empty SQL migration template', () => {
      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateEmpty({
        name: '0001_placeholder',
        description: 'Placeholder migration',
      });

      expect(migration.filename).toBe('0001_placeholder.sql');
      expect(migration.content).toContain('-- @id: 0001_placeholder');
      expect(migration.content).toContain('-- @up');
      expect(migration.content).toContain('-- @down');
      expect(migration.content).toContain('-- Add your UP statements here');
    });

    it('should create empty TypeScript migration template', () => {
      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'typescript',
        includeDown: true,
      });

      const migration = generator.generateEmpty({
        name: '0001_placeholder',
        description: 'Placeholder migration',
        format: 'typescript',
      });

      expect(migration.filename).toBe('0001_placeholder.ts');
      expect(migration.content).toContain("id: '0001_placeholder'");
      expect(migration.content).toContain('// Add your UP statements here');
    });
  });

  describe('type_upgrade handling', () => {
    it('should include executable SQL for type upgrades', () => {
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

      const generator = new MigrationGenerator({
        engine: 'postgres',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateFromDiff(diff, {
        name: '0001_upgrade_types',
        description: 'Upgrade TEXT to JSON types',
      });

      expect(migration.up).toHaveLength(1);
      expect(migration.up[0]).toContain('ALTER TABLE');
      expect(migration.up[0]).toContain('TYPE JSONB');
    });

    it('should skip comment-only SQL for no-op type upgrades', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'type_upgrade',
            table: 'items',
            name: 'data',
            mismatch: { expected: 'JSON', actual: 'TEXT' },
            // SQLite returns a comment since TEXT and JSON are equivalent
            sql: '-- SQLite: "data" already stores JSON as TEXT (no change needed)',
          },
        ],
      };

      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateFromDiff(diff, {
        name: '0001_no_op',
        description: 'No-op migration for SQLite',
      });

      // Comment-only SQL should be skipped
      expect(migration.up).toHaveLength(0);
    });

    it('should not generate DOWN for type upgrades', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'type_upgrade',
            table: 'records',
            name: 'metadata',
            mismatch: { expected: 'JSON', actual: 'TEXT' },
            sql: 'ALTER TABLE "records" ALTER COLUMN "metadata" TYPE JSON',
          },
        ],
      };

      const generator = new MigrationGenerator({
        engine: 'duckdb',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateFromDiff(diff, {
        name: '0001_type_upgrade',
        description: 'Upgrade to JSON type',
      });

      // No DOWN generated for type changes (could lose data)
      expect(migration.down).toHaveLength(0);
    });
  });

  describe('PostgreSQL engine', () => {
    it('should use CONCURRENTLY for indexes', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'add_index',
            table: 'users',
            name: 'idx_users_email',
            index: {
              name: 'idx_users_email',
              columns: ['email'],
              unique: false,
            },
          },
        ],
      };

      const generator = new MigrationGenerator({
        engine: 'postgres',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateFromDiff(diff, {
        name: '0001_add_index',
        description: 'Add email index',
      });

      expect(migration.up.join('\n')).toContain('CONCURRENTLY');
      expect(migration.down.join('\n')).toContain('CONCURRENTLY');
    });
  });
});

describe('generateMigrationSequence', () => {
  it('should return 0001 for empty array', () => {
    expect(generateMigrationSequence([])).toBe('0001');
  });

  it('should increment from last sequence', () => {
    expect(generateMigrationSequence(['0001_initial', '0002_users'])).toBe(
      '0003',
    );
  });

  it('should handle gaps in sequence', () => {
    expect(generateMigrationSequence(['0001_a', '0005_b'])).toBe('0006');
  });

  it('should handle non-sequential IDs', () => {
    expect(generateMigrationSequence(['abc', 'def', '0010_x'])).toBe('0011');
  });

  it('should pad to 4 digits', () => {
    const ids = Array.from(
      { length: 99 },
      (_, i) => `${String(i + 1).padStart(4, '0')}_test`,
    );
    expect(generateMigrationSequence(ids)).toBe('0100');
  });
});

describe('generateMigrationTimestamp', () => {
  it('should return 14-digit timestamp', () => {
    const timestamp = generateMigrationTimestamp();

    expect(timestamp).toMatch(/^\d{14}$/);
  });

  it('should return increasing timestamps', () => {
    const t1 = generateMigrationTimestamp();
    const t2 = generateMigrationTimestamp();

    expect(Number(t2)).toBeGreaterThanOrEqual(Number(t1));
  });
});

describe('createMigrationDefinition', () => {
  it('should create definition from SQL arrays', () => {
    const def = createMigrationDefinition(
      '0001_test',
      ['CREATE TABLE test (id TEXT);'],
      ['DROP TABLE test;'],
      {
        description: 'Test migration',
        version: '1.0.0',
      },
    );

    expect(def.id).toBe('0001_test');
    expect(def.description).toBe('Test migration');
    expect(def.version).toBe('1.0.0');
    expect(def.up).toHaveLength(1);
    expect(def.down).toHaveLength(1);
  });

  it('should use default description if not provided', () => {
    const def = createMigrationDefinition(
      '0001_test',
      ['CREATE TABLE test (id TEXT);'],
      ['DROP TABLE test;'],
    );

    expect(def.description).toBe('Migration: 0001_test');
    expect(def.version).toBe('1.0.0');
  });
});
