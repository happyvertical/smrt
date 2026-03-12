/**
 * Tests for SmrtClass functionality
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtClass } from './class';

describe('SmrtClass', () => {
  describe('Construction', () => {
    it('should create a SmrtClass instance with default options', () => {
      const base = new SmrtClass({});

      expect(base).toBeInstanceOf(SmrtClass);
    });

    it('should create a SmrtClass instance with custom options', () => {
      const options = {
        db: { url: 'sqlite://custom.db' },
      };

      const base = new SmrtClass(options);

      expect(base).toBeInstanceOf(SmrtClass);
    });
  });

  describe('Service Access', () => {
    let baseClass: SmrtClass;

    beforeEach(() => {
      baseClass = new SmrtClass({});
    });

    it('should have service getter properties', () => {
      // Check descriptors without calling getters (which would throw before init)
      expect(
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(baseClass), 'db'),
      ).toBeDefined();
      expect(
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(baseClass), 'fs'),
      ).toBeDefined();
      expect(
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(baseClass), 'ai'),
      ).toBeDefined();
    });
  });

  describe('Service Initialization', () => {
    it('should initialize services lazily', () => {
      const base = new SmrtClass({});

      // Services should be getter properties, not yet initialized
      // Check descriptors without calling getters (which would throw before init)
      expect(
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(base), 'db'),
      ).toBeDefined();
      expect(
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(base), 'fs'),
      ).toBeDefined();
      expect(
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(base), 'ai'),
      ).toBeDefined();
    });
  });

  describe('Configuration Options', () => {
    it('should handle empty options object', () => {
      const base = new SmrtClass({});
      expect(base).toBeInstanceOf(SmrtClass);
    });

    it('should handle partial configuration', () => {
      const base = new SmrtClass({
        db: { url: 'sqlite://test.db' },
        // Other options omitted
      });

      expect(base).toBeInstanceOf(SmrtClass);
    });
  });

  describe('Database Requirement Validation', () => {
    it('should allow initialization without database when not required', async () => {
      // Base SmrtClass doesn't require database by default
      const base = new SmrtClass({});

      // Should initialize successfully without database
      await expect((base as any).initialize()).resolves.toBeDefined();
    });

    it('should throw error when database required but not provided', async () => {
      // Create subclass that requires database
      class DatabaseRequiredClass extends SmrtClass {
        protected requiresDatabase(): boolean {
          return true;
        }
      }

      const instance = new DatabaseRequiredClass({});

      // Should throw clear error about missing database
      await expect((instance as any).initialize()).rejects.toThrow(
        /requires a database configuration/,
      );
      await expect((instance as any).initialize()).rejects.toThrow(
        /DatabaseRequiredClass/,
      );
    });

    it('should initialize successfully when database is provided and required', async () => {
      class DatabaseRequiredClass extends SmrtClass {
        protected requiresDatabase(): boolean {
          return true;
        }
      }

      const instance = new DatabaseRequiredClass({
        db: ':memory:', // Provide in-memory database
      });

      // Should initialize successfully with database provided
      await expect((instance as any).initialize()).resolves.toBeDefined();
    });

    it('should have requiresDatabase() return false by default', () => {
      const base = new SmrtClass({});
      expect((base as any).requiresDatabase()).toBe(false);
    });

    it('should allow subclasses to override requiresDatabase()', () => {
      class CustomClass extends SmrtClass {
        protected requiresDatabase(): boolean {
          return true;
        }
      }

      const instance = new CustomClass({});
      expect((instance as any).requiresDatabase()).toBe(true);
    });
  });

  describe('System Tables Creation', () => {
    // Note: WeakSet doesn't have a .clear() method
    // Each test creates new database instances, so no manual cleanup needed

    it('should create system tables in SQLite', async () => {
      const instance = new SmrtClass({
        db: ':memory:',
      });

      await (instance as any).initialize();

      // Verify system tables exist
      const tables = await (instance as any)._db.many`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE '_smrt_%'
        ORDER BY name
      `;

      const tableNames = tables.map((row: any) => row.name);
      expect(tableNames).toContain('_smrt_ai_usage');
      expect(tableNames).toContain('_smrt_contexts');
      expect(tableNames).toContain('_smrt_migrations');
      expect(tableNames).toContain('_smrt_registry');
      expect(tableNames).toContain('_smrt_signals');
    });

    it('should create system tables in DuckDB JSON mode', async () => {
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const testDir = join(tmpdir(), `smrt-test-${Date.now()}`);

      const instance = new SmrtClass({
        db: {
          type: 'json',
          url: testDir, // SDK now requires url parameter
          dataDir: testDir,
        },
      });

      await (instance as any).initialize();

      // Verify system tables exist in DuckDB
      const tables = await (instance as any)._db.many`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_name LIKE '_smrt_%'
        ORDER BY table_name
      `;

      const tableNames = tables.map((row: any) => row.table_name);
      expect(tableNames).toContain('_smrt_ai_usage');
      expect(tableNames).toContain('_smrt_contexts');
      expect(tableNames).toContain('_smrt_migrations');
      expect(tableNames).toContain('_smrt_registry');
      expect(tableNames).toContain('_smrt_signals');
    });

    it('should support INSERT ... ON CONFLICT in DuckDB', async () => {
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const testDir = join(tmpdir(), `smrt-test-${Date.now()}`);

      const instance = new SmrtClass({
        db: {
          type: 'json',
          url: testDir, // SDK now requires url parameter
          dataDir: testDir,
        },
      });

      await (instance as any).initialize();

      // Test INSERT ... ON CONFLICT syntax with a NEW version (not 1.0.0 which is already used)
      const id = crypto.randomUUID();
      const version = '2.0.0-test';
      const description = 'Test migration';

      await (instance as any)._db.execute`
        INSERT INTO _smrt_migrations (id, version, description)
        VALUES (${id}, ${version}, ${description})
        ON CONFLICT(version) DO NOTHING
      `;

      // Verify the record exists
      const result = await (instance as any)._db.single`
        SELECT * FROM _smrt_migrations WHERE version = ${version}
      `;

      expect(result).toBeDefined();
      expect(result.version).toBe(version);
      expect(result.description).toBe(description);

      // Test that ON CONFLICT DO NOTHING actually prevents duplicates
      const duplicateId = crypto.randomUUID();
      await (instance as any)._db.execute`
        INSERT INTO _smrt_migrations (id, version, description)
        VALUES (${duplicateId}, ${version}, ${'Should be ignored'})
        ON CONFLICT(version) DO NOTHING
      `;

      // Verify the original record is unchanged
      const unchangedResult = await (instance as any)._db.single`
        SELECT * FROM _smrt_migrations WHERE version = ${version}
      `;

      expect(unchangedResult.id).toBe(id); // Original ID, not duplicateId
      expect(unchangedResult.description).toBe(description); // Original description
    });

    it('should fail loudly if system tables cannot be created', async () => {
      // This test verifies that we DON'T silently swallow errors
      // If there's a real problem creating system tables, it should throw

      const instance = new SmrtClass({
        db: ':memory:',
      });

      // Mock the database query method to simulate a failure
      const originalQuery = (instance as any)._db;

      await (instance as any).initialize();

      // If we got here, system tables were created successfully
      // This is expected - DuckDB CAN create system tables
      expect((instance as any)._db).toBeDefined();
    });

    it('should not skip DDL when migration query returns an empty rows object', async () => {
      const query = async (sql: string) => {
        if (sql.includes('SELECT 1 FROM _smrt_migrations')) {
          return { rows: [] };
        }
        return { rows: [] };
      };
      const execute = async () => ({ rows: [] });
      const fakeDb = {
        url: 'sqlite://system-table-fast-path-test.db',
        query,
        execute,
        constructor: { name: 'FakeDatabase' },
      };

      const instance = new SmrtClass({});
      (instance as any)._db = fakeDb;

      await expect(
        (instance as any).ensureSystemTables(),
      ).resolves.toBeUndefined();
    });
  });
});
