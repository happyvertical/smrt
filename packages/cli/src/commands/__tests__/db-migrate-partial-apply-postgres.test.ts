/**
 * #2748: `smrt db:migrate --apply-unblocked` and `--null-orphans` against
 * real PostgreSQL, driven through the actual CLI handler (not the pure
 * functions directly) — same harness pattern as
 * `db-migrate-force-postgres.test.ts`.
 */
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
        path: '/tmp/partial-apply-2748/.smrt/manifest.json',
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
  'db:migrate --apply-unblocked / --null-orphans (real PostgreSQL, #2748)',
  () => {
    const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const parents = `pa2748_parents_${suffix}`;
    const children = `pa2748_children_${suffix}`;
    const unrelated = `pa2748_unrelated_${suffix}`;
    const requiredChildren = `pa2748_required_${suffix}`;
    const allTables = [parents, children, unrelated, requiredChildren];
    const registrySpies: Array<ReturnType<typeof vi.spyOn>> = [];

    async function freshDb(): Promise<any> {
      return getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
    }

    function foreignKey() {
      return {
        column: 'parent_id',
        referencesTable: parents,
        referencesColumn: 'id',
      };
    }

    function parentSchema(): SchemaDefinition {
      return {
        tableName: parents,
        columns: { id: { type: 'UUID', primaryKey: true } },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        version: '2748-test',
        dependencies: [],
      };
    }

    function childSchema(nullableParent: boolean): SchemaDefinition {
      const fk = foreignKey();
      return {
        tableName: children,
        columns: {
          id: { type: 'UUID', primaryKey: true },
          parent_id: {
            type: 'UUID',
            notNull: !nullableParent,
            foreignKey: fk,
          },
        },
        // Directly on the blocked FK's child column: must stay withheld
        // under --apply-unblocked.
        indexes: [
          { name: `${children}_parent_id_idx`, columns: ['parent_id'] },
        ],
        triggers: [],
        foreignKeys: [fk],
        version: '2748-test',
        dependencies: [parents],
      };
    }

    function unrelatedSchema(): SchemaDefinition {
      return {
        tableName: unrelated,
        columns: {
          id: { type: 'UUID', primaryKey: true },
          status: { type: 'TEXT' },
        },
        // Independent of the blocked FK: must apply under --apply-unblocked
        // and, per the CLI's unflagged default, applies unconditionally too.
        indexes: [{ name: `${unrelated}_status_idx`, columns: ['status'] }],
        triggers: [],
        foreignKeys: [],
        version: '2748-test',
        dependencies: [],
      };
    }

    function installManifest(schemas: Record<string, SchemaDefinition>): void {
      const tableNames = Object.keys(schemas);
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

    async function runMigrate(argv: string[]): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | undefined;
    }> {
      const command = utilityCommands['db:migrate'];
      const parsed = parseCliCommandArgs(argv, [command]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      process.exitCode = undefined;
      await command.handler(parsed.args, parsed.options);
      const result = {
        stdout: [...logSpy.mock.calls, ...warnSpy.mock.calls]
          .map((call) => call.join(' '))
          .join('\n'),
        stderr: errorSpy.mock.calls.map((call) => call.join(' ')).join('\n'),
        exitCode: process.exitCode,
      };
      process.exitCode = undefined;
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      return result;
    }

    async function indexExists(
      tableName: string,
      indexName: string,
    ): Promise<boolean> {
      const db = await freshDb();
      const result = await db.query(
        `SELECT 1 FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
        [tableName, indexName],
      );
      return result.rows.length > 0;
    }

    async function fkExists(tableName: string): Promise<boolean> {
      const db = await freshDb();
      const result = await db.query(
        `SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = $1 AND constraint_type = 'FOREIGN KEY'`,
        [tableName],
      );
      return result.rows.length > 0;
    }

    beforeEach(async () => {
      clearCache();
      setConfig({
        packages: {
          cli: {
            database: { type: 'postgres', url: process.env.DATABASE_URL },
          },
        },
      } as any);

      const db = await freshDb();
      for (const tableName of allTables) {
        await db.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
      }
      await db.query(`CREATE TABLE "${parents}" (id UUID PRIMARY KEY)`);
      await db.query(
        `CREATE TABLE "${children}" (id UUID PRIMARY KEY, parent_id UUID)`,
      );
      await db.query(
        `CREATE TABLE "${unrelated}" (id UUID PRIMARY KEY, status TEXT)`,
      );
      await db.query(
        `CREATE TABLE "${requiredChildren}" (id UUID PRIMARY KEY, parent_id UUID NOT NULL)`,
      );
      await new MigrationTracker({ db }).initialize();
    });

    afterEach(async () => {
      for (const spy of registrySpies.splice(0)) spy.mockRestore();
      try {
        const db = await freshDb();
        for (const tableName of allTables) {
          await db.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
        }
      } finally {
        clearCache();
        process.exitCode = undefined;
        vi.restoreAllMocks();
      }
    });

    it('withholds the dependent index by default but applies the unrelated one either way, and --apply-unblocked also skips the dependent one explicitly', async () => {
      const goodParentId = (await freshDb()).query(
        `INSERT INTO "${parents}" (id) VALUES (gen_random_uuid()) RETURNING id`,
      );
      await goodParentId;
      // Orphan child row: references a parent that does not exist.
      await (await freshDb()).query(
        `INSERT INTO "${children}" (id, parent_id) VALUES (gen_random_uuid(), gen_random_uuid())`,
      );

      installManifest({
        [parents]: parentSchema(),
        [children]: childSchema(true),
        [unrelated]: unrelatedSchema(),
      });

      const plain = await runMigrate(['db:migrate']);
      expect(plain.exitCode).toBe(1); // manual intervention (orphan-blocked FK) present
      expect(plain.stdout).toContain('Manual migration required');
      expect(await fkExists(children)).toBe(false);
      // Unflagged default: every independent/dependent safe DDL still
      // applies together (the blocked FK itself never enters the batch).
      expect(await indexExists(unrelated, `${unrelated}_status_idx`)).toBe(
        true,
      );

      // Reset for a clean --apply-unblocked run.
      const db = await freshDb();
      await db.query(`DROP INDEX IF EXISTS "${unrelated}_status_idx"`);
      await db.query(`DROP INDEX IF EXISTS "${children}_parent_id_idx"`);
      await db.query(
        `DELETE FROM _smrt_schema_migrations WHERE name LIKE 'add_index_%'`,
      );

      const unblocked = await runMigrate(['db:migrate', '--apply-unblocked']);
      expect(unblocked.exitCode).toBe(1); // the FK is still a manual intervention
      expect(unblocked.stdout).toContain('Withheld');
      expect(await indexExists(unrelated, `${unrelated}_status_idx`)).toBe(
        true,
      );
      expect(await indexExists(children, `${children}_parent_id_idx`)).toBe(
        false,
      );
      expect(await fkExists(children)).toBe(false);
    }, 60_000);

    it('--null-orphans nulls a nullable orphan reference, then adds the FK', async () => {
      const db = await freshDb();
      const goodParent = await db.query(
        `INSERT INTO "${parents}" (id) VALUES (gen_random_uuid()) RETURNING id`,
      );
      const goodParentId = goodParent.rows[0].id;
      await db.query(
        `INSERT INTO "${children}" (id, parent_id) VALUES (gen_random_uuid(), gen_random_uuid())`,
      );
      await db.query(
        `INSERT INTO "${children}" (id, parent_id) VALUES (gen_random_uuid(), $1)`,
        [goodParentId],
      );

      installManifest({
        [parents]: parentSchema(),
        [children]: { ...childSchema(true), indexes: [] },
      });

      const migrate = await runMigrate(['db:migrate', '--null-orphans']);

      expect(migrate.stdout).toContain('Orphan-FK disposition');
      expect(await fkExists(children)).toBe(true);
      const verifyDb = await freshDb();
      const rows = await verifyDb.query(
        `SELECT parent_id FROM "${children}" ORDER BY parent_id NULLS FIRST`,
      );
      expect(rows.rows).toEqual([
        { parent_id: null },
        { parent_id: goodParentId },
      ]);
      // Never deletes rows.
      const count = await verifyDb.query(
        `SELECT COUNT(*) AS c FROM "${children}"`,
      );
      expect(Number(count.rows[0].c)).toBe(2);
    }, 60_000);

    it('--null-orphans refuses a NOT NULL child column and leaves rows untouched', async () => {
      const db = await freshDb();
      await db.query(
        `INSERT INTO "${requiredChildren}" (id, parent_id) VALUES (gen_random_uuid(), gen_random_uuid())`,
      );

      installManifest({
        [parents]: parentSchema(),
        [requiredChildren]: {
          tableName: requiredChildren,
          columns: {
            id: { type: 'UUID', primaryKey: true },
            parent_id: {
              type: 'UUID',
              notNull: true,
              foreignKey: foreignKey(),
            },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [foreignKey()],
          version: '2748-test',
          dependencies: [parents],
        },
      });

      const migrate = await runMigrate(['db:migrate', '--null-orphans']);

      expect(migrate.exitCode).toBe(1);
      expect(migrate.stdout).toContain('Manual migration required');
      expect(await fkExists(requiredChildren)).toBe(false);
      const verifyDb = await freshDb();
      const count = await verifyDb.query(
        `SELECT COUNT(*) AS c FROM "${requiredChildren}"`,
      );
      expect(Number(count.rows[0].c)).toBe(1);
    }, 60_000);

    it('--dry-run shows the identical partition a real run applies when --null-orphans resolves a dependency for --apply-unblocked (review, #2748)', async () => {
      const db = await freshDb();
      const goodParent = await db.query(
        `INSERT INTO "${parents}" (id) VALUES (gen_random_uuid()) RETURNING id`,
      );
      const goodParentId = goodParent.rows[0].id;
      await db.query(
        `INSERT INTO "${children}" (id, parent_id) VALUES (gen_random_uuid(), gen_random_uuid())`,
      );
      await db.query(
        `INSERT INTO "${children}" (id, parent_id) VALUES (gen_random_uuid(), $1)`,
        [goodParentId],
      );

      // childSchema(true) declares an index directly on parent_id — the
      // FK's own child column. Once --null-orphans resolves the FK, that
      // index is no longer dependent on a blocked column and must show
      // as applied in the dry-run preview too, not just in a real run.
      installManifest({
        [parents]: parentSchema(),
        [children]: childSchema(true),
      });

      const dryRun = await runMigrate([
        'db:migrate',
        '--dry-run',
        '--null-orphans',
        '--apply-unblocked',
      ]);
      expect(dryRun.stdout).toContain('would null');
      expect(dryRun.stdout).not.toContain('Withheld');
      expect(dryRun.stdout).toContain(`${children}_parent_id_idx`);
      // Nothing executed on --dry-run.
      expect(await fkExists(children)).toBe(false);
      expect(await indexExists(children, `${children}_parent_id_idx`)).toBe(
        false,
      );

      const real = await runMigrate([
        'db:migrate',
        '--null-orphans',
        '--apply-unblocked',
      ]);
      expect(real.stdout).not.toContain('Withheld');
      expect(await fkExists(children)).toBe(true);
      expect(await indexExists(children, `${children}_parent_id_idx`)).toBe(
        true,
      );
    }, 60_000);
  },
);
