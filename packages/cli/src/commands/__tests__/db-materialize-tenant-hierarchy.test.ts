/**
 * `db:materialize-tenant-hierarchy` handler tests (smrt#3036), against a real
 * SQLite database carrying the legacy shape: correct `parent_tenant_id`,
 * never-materialized `hierarchy_path` / `hierarchy_level`.
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMaterializeTenantHierarchyCommand } from '../db-materialize-tenant-hierarchy.js';
import { utilityCommands } from '../utilities.js';

describe('db:materialize-tenant-hierarchy command', () => {
  it('is registered in the utility command map with --dry-run', () => {
    expect(utilityCommands['db:materialize-tenant-hierarchy']).toBe(
      dbMaterializeTenantHierarchyCommand,
    );
    expect(dbMaterializeTenantHierarchyCommand.aliases).toContain(
      'tenancy:materialize-hierarchy',
    );
    expect(
      dbMaterializeTenantHierarchyCommand.options?.['dry-run'],
    ).toBeDefined();
  });

  describe('handler (real SQLite)', () => {
    let dbUrl: string;
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    async function withDb<T>(
      fn: (db: Awaited<ReturnType<typeof getDatabase>>) => Promise<T>,
    ): Promise<T> {
      const db = await getDatabase({ type: 'sqlite', url: dbUrl });
      try {
        return await fn(db);
      } finally {
        await db.close?.();
      }
    }

    async function seed(rows: Array<[string, string | null]>) {
      await withDb(async (db) => {
        await db.query(`CREATE TABLE tenants (
          id TEXT PRIMARY KEY,
          parent_tenant_id TEXT,
          hierarchy_path TEXT NOT NULL DEFAULT '',
          hierarchy_level INTEGER NOT NULL DEFAULT 0
        )`);
        for (const [id, parent] of rows) {
          await db.query(
            'INSERT INTO tenants (id, parent_tenant_id) VALUES (?, ?)',
            id,
            parent,
          );
        }
      });
    }

    async function stored() {
      return await withDb(async (db) => {
        const { rows } = await db.query(
          'SELECT id, hierarchy_path, hierarchy_level FROM tenants ORDER BY id',
        );
        return Object.fromEntries(
          rows.map((row: Record<string, unknown>) => [
            row.id,
            [row.hierarchy_path, Number(row.hierarchy_level)],
          ]),
        );
      });
    }

    const output = () =>
      logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const errorOutput = () =>
      errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');

    beforeEach(() => {
      process.exitCode = undefined;
      dbUrl = join(
        tmpdir(),
        `smrt-3036-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
      process.exitCode = undefined;
      rmSync(dbUrl, { force: true });
    });

    it('dry-run reports the plan and writes nothing', async () => {
      await seed([
        ['net', null],
        ['pub', 'net'],
        ['desk', 'pub'],
      ]);

      await dbMaterializeTenantHierarchyCommand.handler([], {
        'dry-run': true,
      });

      expect(process.exitCode).toBeUndefined();
      expect(output()).toContain(
        'DRY RUN: 3 tenant(s) examined; 2 would be updated',
      );
      expect(await stored()).toEqual({
        desk: ['', 0],
        net: ['', 0],
        pub: ['', 0],
      });
    });

    it('applies once and is a no-op on the second run', async () => {
      await seed([
        ['net', null],
        ['pub', 'net'],
        ['desk', 'pub'],
      ]);

      await dbMaterializeTenantHierarchyCommand.handler([], {});
      expect(process.exitCode).toBeUndefined();
      expect(output()).toContain('Materialized the hierarchy for 2 of 3');
      expect(await stored()).toEqual({
        desk: ['net/pub', 2],
        net: ['', 0],
        pub: ['net', 1],
      });

      logSpy.mockClear();
      await dbMaterializeTenantHierarchyCommand.handler([], {});
      expect(process.exitCode).toBeUndefined();
      expect(output()).toContain('nothing to do');
    });

    it('refuses a broken chain without writing and exits non-zero', async () => {
      await seed([
        ['net', null],
        ['pub', 'net'],
        ['a', 'b'],
        ['b', 'a'],
      ]);

      await dbMaterializeTenantHierarchyCommand.handler([], {});

      expect(process.exitCode).toBe(1);
      expect(errorOutput()).toContain('CIRCULAR_REFERENCE');
      expect(errorOutput()).toContain('No changes were made');
      expect((await stored()).pub).toEqual(['', 0]);
    });

    it('requires a configured database', async () => {
      clearCache();
      setConfig({
        packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
      } as any);

      await dbMaterializeTenantHierarchyCommand.handler([], {});

      expect(process.exitCode).toBe(1);
      expect(errorOutput()).toContain('Database configuration required');
    });
  });
});
