import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import { MigrationTracker } from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCliCommandArgs } from '../../cli-generator.js';
import { utilityCommands } from '../utilities.js';

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(async () => ({
    discovered: [
      {
        path: '/tmp/multiple-force-migrations/.smrt/manifest.json',
        source: 'project',
        objectCount: 3,
      },
    ],
    totalObjects: 3,
  })),
}));

const hasPostgres = Boolean(process.env.DATABASE_URL);
const describePostgres = hasPostgres ? describe : describe.skip;

describePostgres(
  'db:migrate multiple exact checksum recovery (real PostgreSQL)',
  () => {
    const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const commissions = `fm_commissions_${suffix}`;
    const referralLinks = `fm_referral_links_${suffix}`;
    const unrelated = `fm_unrelated_${suffix}`;
    const allTables = [commissions, referralLinks, unrelated];
    const registrySpies: Array<ReturnType<typeof vi.spyOn>> = [];

    function migrationId(tableName: string): string {
      return `create_table_${tableName}`;
    }

    function legacyTable(tableName: string): string {
      return `${tableName}_legacy`;
    }

    function schema(tableName: string): SchemaDefinition {
      return {
        tableName,
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          value: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        version: 'multiple-force-test',
        dependencies: [],
      };
    }

    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    async function tableExists(tableName: string): Promise<boolean> {
      const db = await freshDb();
      const result = await db.query(
        `SELECT 1
           FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1`,
        tableName,
      );
      return result.rows.length > 0;
    }

    async function history(tableNames: string[]): Promise<
      Array<{
        name: string;
        checksum: string;
        attempts: number;
        status: string;
      }>
    > {
      const db = await freshDb();
      const result = await db.query(
        `SELECT name, checksum, attempts, status
           FROM _smrt_schema_migrations
          WHERE name = ANY($1::text[])
          ORDER BY name`,
        tableNames.map(migrationId),
      );
      return result.rows as Array<{
        name: string;
        checksum: string;
        attempts: number;
        status: string;
      }>;
    }

    function installManifest(tableNames: string[]): void {
      const schemas = Object.fromEntries(
        tableNames.map((tableName) => [tableName, schema(tableName)]),
      );
      const classNames = tableNames.map((tableName) => `Test_${tableName}`);
      const tableByClass = new Map(
        classNames.map((className, index) => [className, tableNames[index]]),
      );

      registrySpies.push(
        vi
          .spyOn(ObjectRegistry, 'getInitializationOrder')
          .mockReturnValue(classNames),
        vi
          .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
          .mockReturnValue(schemas),
        vi
          .spyOn(ObjectRegistry, 'getTableName')
          .mockImplementation(
            (className: string) => tableByClass.get(className) ?? className,
          ),
      );
    }

    async function prepareRenamedHistory(
      tableNames: string[],
    ): Promise<Map<string, string>> {
      const db = await freshDb();
      const tracker = new MigrationTracker({ db });
      const results = await tracker.applyAll(
        tableNames.map((tableName) => ({
          id: migrationId(tableName),
          description: `Legacy create ${tableName}`,
          version: '0.40.8',
          // Deliberately differs byte-for-byte from the current generated DDL
          // while creating the same legacy table shape.
          up: [`CREATE TABLE "${tableName}" (id text PRIMARY KEY, value text)`],
          down: [`DROP TABLE IF EXISTS "${tableName}"`],
        })),
        { atomic: true },
      );
      expect(results.every((result) => result.success)).toBe(true);

      for (const tableName of tableNames) {
        await db.query(
          `ALTER TABLE "${tableName}" RENAME TO "${legacyTable(tableName)}"`,
        );
      }

      return new Map(
        (await history(tableNames)).map((row) => [row.name, row.checksum]),
      );
    }

    async function runMigrate(argv: string[]): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | undefined;
    }> {
      const command = utilityCommands['db:migrate'];
      const parsed = parseCliCommandArgs(argv, [command]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      process.exitCode = undefined;
      await command.handler(parsed.args, parsed.options);
      const result = {
        stdout: logSpy.mock.calls.flat().join('\n'),
        stderr: errorSpy.mock.calls.flat().join('\n'),
        exitCode: process.exitCode,
      };
      process.exitCode = undefined;
      logSpy.mockRestore();
      errorSpy.mockRestore();
      return result;
    }

    beforeEach(async () => {
      clearCache();
      setConfig({
        packages: {
          cli: {
            database: {
              type: 'postgres',
              url: process.env.DATABASE_URL,
            },
          },
        },
      } as any);

      const db = await freshDb();
      for (const tableName of allTables) {
        await db.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
        await db.query(
          `DROP TABLE IF EXISTS "${legacyTable(tableName)}" CASCADE`,
        );
      }
      await new MigrationTracker({ db }).initialize();
      await db.query(
        `DELETE FROM _smrt_schema_migrations
          WHERE name = ANY($1::text[])`,
        allTables.map(migrationId),
      );
    });

    afterEach(async () => {
      for (const spy of registrySpies.splice(0)) {
        spy.mockRestore();
      }
      try {
        const db = await freshDb();
        for (const tableName of allTables) {
          await db.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
          await db.query(
            `DROP TABLE IF EXISTS "${legacyTable(tableName)}" CASCADE`,
          );
        }
        await db.query(
          `DELETE FROM _smrt_schema_migrations
            WHERE name = ANY($1::text[])`,
          allTables.map(migrationId),
        );
      } finally {
        clearCache();
        process.exitCode = undefined;
        vi.restoreAllMocks();
      }
    });

    it('recovers two renamed-table histories in one CLI batch, applies data, and reruns cleanly', async () => {
      const targets = [commissions, referralLinks];
      installManifest(targets);
      const staleChecksums = await prepareRenamedHistory(targets);

      const migrate = await runMigrate([
        'db:migrate',
        '--force-migration',
        migrationId(commissions),
        '--force-migration',
        migrationId(referralLinks),
      ]);

      expect(migrate.exitCode).toBeUndefined();
      expect(await tableExists(commissions)).toBe(true);
      expect(await tableExists(referralLinks)).toBe(true);
      expect(await tableExists(legacyTable(commissions))).toBe(true);
      expect(await tableExists(legacyTable(referralLinks))).toBe(true);

      const recoveredHistory = await history(targets);
      expect(recoveredHistory).toHaveLength(2);
      for (const row of recoveredHistory) {
        expect(row.status).toBe('completed');
        expect(Number(row.attempts)).toBe(2);
        expect(row.checksum).not.toBe(staleChecksums.get(row.name));
      }

      // Downstream apply phase: data is written only after both schema targets
      // exist. A subsequent unforced CLI rerun must preserve it and stay clean.
      const db = await freshDb();
      await db.query(
        `INSERT INTO "${commissions}" (id, value) VALUES ($1, $2)`,
        'commission-1',
        'applied',
      );
      await db.query(
        `INSERT INTO "${referralLinks}" (id, value) VALUES ($1, $2)`,
        'referral-link-1',
        'applied',
      );

      const rerun = await runMigrate(['db:migrate']);
      expect(rerun.exitCode).toBeUndefined();
      expect(rerun.stdout).toContain('Database schema is up to date');

      const commissionRows = await (await freshDb()).query(
        `SELECT id, value FROM "${commissions}"`,
      );
      const referralRows = await (await freshDb()).query(
        `SELECT id, value FROM "${referralLinks}"`,
      );
      expect(commissionRows.rows).toEqual([
        { id: 'commission-1', value: 'applied' },
      ]);
      expect(referralRows.rows).toEqual([
        { id: 'referral-link-1', value: 'applied' },
      ]);
    }, 60_000);

    it('keeps an unrelated checksum guard enforced and rolls back the selected targets', async () => {
      installManifest(allTables);
      const staleChecksums = await prepareRenamedHistory(allTables);

      const migrate = await runMigrate([
        'db:migrate',
        '--force-migration',
        migrationId(commissions),
        '--force-migration',
        migrationId(referralLinks),
      ]);

      expect(migrate.exitCode).toBe(1);
      expect(migrate.stderr).toContain(migrationId(unrelated));
      expect(migrate.stderr).toContain('checksum mismatch');

      for (const tableName of allTables) {
        expect(await tableExists(tableName)).toBe(false);
        expect(await tableExists(legacyTable(tableName))).toBe(true);
      }

      const guardedHistory = await history(allTables);
      expect(guardedHistory).toHaveLength(3);
      for (const row of guardedHistory) {
        expect(row.status).toBe('completed');
        expect(Number(row.attempts)).toBe(1);
        expect(row.checksum).toBe(staleChecksums.get(row.name));
      }
    }, 60_000);
  },
);
