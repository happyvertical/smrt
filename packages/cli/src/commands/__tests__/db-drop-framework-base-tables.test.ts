/**
 * `db:drop-framework-base-tables` handler tests (#2647), against a real
 * SQLite database.
 *
 * Covers command registration, config validation, the dry-run plan (no
 * mutation), the happy path (five tables + companion indexes dropped, a
 * real application table untouched), every refusal path (non-empty table,
 * unexpected column, inbound foreign key), and the "nothing present"
 * no-op.
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { FRAMEWORK_BASE_TABLE_NAMES } from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbDropFrameworkBaseTablesCommand } from '../db-drop-framework-base-tables.js';
import { utilityCommands } from '../utilities.js';

function createFrameworkBaseTableDDL(table: string): string[] {
  return [
    `CREATE TABLE "${table}" (
      "id" TEXT PRIMARY KEY,
      "slug" TEXT NOT NULL,
      "context" TEXT NOT NULL DEFAULT '',
      "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX "${table}_slug_context_idx" ON "${table}" ("slug", "context")`,
    `CREATE INDEX "${table}_created_at_idx" ON "${table}" ("created_at")`,
  ];
}

describe('db:drop-framework-base-tables command', () => {
  it('is registered in the utility command map', () => {
    expect(utilityCommands['db:drop-framework-base-tables']).toBe(
      dbDropFrameworkBaseTablesCommand,
    );
    expect(dbDropFrameworkBaseTablesCommand.name).toBe(
      'db:drop-framework-base-tables',
    );
    expect(dbDropFrameworkBaseTablesCommand.aliases).toContain(
      'drop-framework-base-tables',
    );
    expect(dbDropFrameworkBaseTablesCommand.options?.['dry-run']).toBeDefined();
    expect(dbDropFrameworkBaseTablesCommand.options?.verbose).toBeDefined();
  });

  describe('handler (real SQLite)', () => {
    let dbUrl: string;
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    async function freshDb(): Promise<any> {
      return getDatabase({ type: 'sqlite', url: dbUrl });
    }

    async function tableExists(table: string): Promise<boolean> {
      const db = await freshDb();
      const { rows } = await db.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
        table,
      );
      await db.close?.();
      return (rows as unknown[]).length > 0;
    }

    async function createAllFrameworkBaseTables(): Promise<void> {
      const db = await freshDb();
      for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
        for (const statement of createFrameworkBaseTableDDL(table)) {
          await db.query(statement);
        }
      }
      await db.close?.();
    }

    beforeEach(() => {
      process.exitCode = undefined;
      dbUrl = join(
        tmpdir(),
        `cov-2647-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
      );
      clearCache();
      setConfig({
        packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
      } as any);
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
      clearCache();
      try {
        rmSync(dbUrl, { force: true });
      } catch {
        // ignore
      }
    });

    function output(): string {
      return logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    }

    function errorOutput(): string {
      return errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    }

    it('errors out when the database is configured as :memory:', async () => {
      clearCache();
      setConfig({
        packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
      } as any);

      await dbDropFrameworkBaseTablesCommand.handler([], {});

      expect(process.exitCode).toBe(1);
      expect(errorOutput()).toContain('Database configuration required');
    });

    it('reports nothing to do when none of the five tables exist', async () => {
      await dbDropFrameworkBaseTablesCommand.handler([], {});

      expect(process.exitCode).toBeUndefined();
      expect(output()).toContain('Nothing to do');
      expect(errorOutput()).toBe('');
    });

    it('prints the plan and drops nothing on --dry-run', async () => {
      await createAllFrameworkBaseTables();

      await dbDropFrameworkBaseTablesCommand.handler([], { 'dry-run': true });

      expect(process.exitCode).toBeUndefined();
      expect(output()).toContain('DRY RUN — would execute 15 statement(s)');
      expect(output()).toContain('Dry run complete');
      expect(output()).toContain('DROP TABLE IF EXISTS "smrt_classes"');

      for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
        expect(await tableExists(table)).toBe(true);
      }
    });

    it('drops all five tables and their companion indexes, leaving a real application table untouched', async () => {
      await createAllFrameworkBaseTables();
      const db = await freshDb();
      await db.query(
        'CREATE TABLE "articles" (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
      );
      await db.query(
        "INSERT INTO \"articles\" (id, title) VALUES ('a1', 'Hello')",
      );
      await db.close?.();

      await dbDropFrameworkBaseTablesCommand.handler([], {});

      expect(process.exitCode).toBeUndefined();
      expect(output()).toContain(
        'Dropped 5 table(s) and 10 companion index(es)',
      );

      for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
        expect(await tableExists(table)).toBe(false);
      }
      expect(await tableExists('articles')).toBe(true);
    });

    it('refuses and drops nothing when a target table has rows', async () => {
      await createAllFrameworkBaseTables();
      const db = await freshDb();
      await db.query(
        `INSERT INTO "smrt_classes" (id, slug, context) VALUES ('c1', 'thing', '')`,
      );
      await db.close?.();

      await dbDropFrameworkBaseTablesCommand.handler([], {});

      expect(process.exitCode).toBe(1);
      expect(errorOutput()).toContain('remediation failed');
      expect(output()).toContain('UNSAFE');
      expect(output()).toContain('has 1 row(s)');

      for (const table of FRAMEWORK_BASE_TABLE_NAMES) {
        expect(await tableExists(table)).toBe(true);
      }
    });

    it('refuses when a target table has an unexpected column', async () => {
      await createAllFrameworkBaseTables();
      const db = await freshDb();
      await db.query('ALTER TABLE "smrt_objects" ADD COLUMN "extra" TEXT');
      await db.close?.();

      await dbDropFrameworkBaseTablesCommand.handler([], {});

      expect(process.exitCode).toBe(1);
      expect(output()).toContain('unexpected column(s) [extra]');

      expect(await tableExists('smrt_objects')).toBe(true);
    });

    it('refuses when another live table has a foreign key onto a target table', async () => {
      await createAllFrameworkBaseTables();
      const db = await freshDb();
      await db.query(
        'CREATE TABLE "widgets" (id TEXT PRIMARY KEY, class_id TEXT REFERENCES "smrt_classes"(id))',
      );
      await db.close?.();

      await dbDropFrameworkBaseTablesCommand.handler([], {});

      expect(process.exitCode).toBe(1);
      expect(output()).toContain(
        'is referenced by foreign key(s) from: widgets.class_id',
      );
      expect(await tableExists('smrt_classes')).toBe(true);
    });

    it('lists absent tables under --verbose', async () => {
      const db = await freshDb();
      for (const statement of createFrameworkBaseTableDDL('smrt_classes')) {
        await db.query(statement);
      }
      await db.close?.();

      await dbDropFrameworkBaseTablesCommand.handler([], { verbose: true });

      expect(output()).toContain('smrt_objects: not present, nothing to do');
      expect(output()).toContain('smrt_classes: safe to drop');
    });
  });
});
