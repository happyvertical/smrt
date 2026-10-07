/**
 * #3634: two `smrt db:migrate` runs against one PostgreSQL database at the
 * same time, driven through the real CLI handler (same harness pattern as
 * `db-migrate-force-postgres.test.ts`).
 *
 * Before the migration lock, both runs compared the live schema, planned the
 * same batch, and the loser failed part way with `42701 column ... already
 * exists` (Ergot production, 2026-09-25). With the lock, the second run waits,
 * then compares a current schema and applies nothing.
 */

import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import {
  acquireMigrationLock,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { parseCliCommandArgs } from '../../cli-generator.js';
import { utilityCommands } from '../utilities.js';

// `getDatabase` caches one pool per connection identity within a process, so
// two in-process handler runs would otherwise share — and the first to finish
// would close — a single pool. A distinct `dbid` per call gives each run its
// own pool, which is what two separate processes have.
vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();
  let sequence = 0;
  return {
    ...actual,
    // The CLI handler always passes a `{ type, url }` options object.
    getDatabase: (options: { type: string; url: string }) =>
      actual.getDatabase({
        ...options,
        dbid: `cm3634-pool-${process.pid}-${++sequence}`,
      } as Parameters<typeof actual.getDatabase>[0]),
  };
});

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(async () => ({
    discovered: [
      {
        path: '/tmp/concurrent-migrate-3634/.smrt/manifest.json',
        source: 'project',
        objectCount: 2,
      },
    ],
    totalObjects: 2,
  })),
}));

const hasPostgres = Boolean(process.env.DATABASE_URL);
const describePostgres = hasPostgres ? describe : describe.skip;

describePostgres('db:migrate concurrent runs (real PostgreSQL, #3634)', () => {
  const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const existing = `cm3634_existing_${suffix}`;
  const created = `cm3634_created_${suffix}`;
  const allTables = [existing, created];
  // Enough added columns that two unserialized runs reliably overlap.
  const addedColumns = Array.from({ length: 40 }, (_, i) => `extra_${i}`);
  const registrySpies: Array<ReturnType<typeof vi.spyOn>> = [];
  const pools: any[] = [];

  async function freshDb(): Promise<any> {
    const db = await getDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL as string,
    });
    pools.push(db);
    return db;
  }

  function schemas(): Record<string, SchemaDefinition> {
    const extra = Object.fromEntries(
      addedColumns.map((name) => [name, { type: 'TEXT' }]),
    );
    return {
      [existing]: {
        tableName: existing,
        columns: { id: { type: 'UUID', primaryKey: true }, ...extra },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        version: '3634-test',
        dependencies: [],
      },
      [created]: {
        tableName: created,
        columns: {
          id: { type: 'UUID', primaryKey: true },
          label: { type: 'TEXT' },
        },
        indexes: [{ name: `${created}_label_idx`, columns: ['label'] }],
        triggers: [],
        foreignKeys: [],
        version: '3634-test',
        dependencies: [],
      },
    };
  }

  function installManifest(): void {
    const all = schemas();
    const tableNames = Object.keys(all);
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
        .mockReturnValue(all),
      vi
        .spyOn(ObjectRegistry, 'getTableName')
        .mockImplementation(
          (className: string) => tableByClass.get(className) ?? className,
        ),
    );
  }

  /**
   * Run several `db:migrate` invocations concurrently. Console output is
   * shared, so callers assert on the combined transcript; `process.exitCode`
   * is likewise global, and any failing run leaves it at 1.
   */
  async function runConcurrently(
    runs: Array<Promise<void> | (() => Promise<void>)>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.exitCode = undefined;
    try {
      await Promise.all(
        runs.map((run) => (typeof run === 'function' ? run() : run)),
      );
      return {
        stdout: [...logSpy.mock.calls, ...warnSpy.mock.calls]
          .map((call) => call.join(' '))
          .join('\n'),
        stderr: errorSpy.mock.calls.map((call) => call.join(' ')).join('\n'),
        exitCode: process.exitCode,
      };
    } finally {
      process.exitCode = undefined;
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }

  function migrate(): () => Promise<void> {
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate'], [command]);
    return async () => {
      await requireCommandHandler(command)(parsed.args, parsed.options);
    };
  }

  async function columnNames(tableName: string): Promise<string[]> {
    const db = await freshDb();
    const result = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      tableName,
    );
    return result.rows.map((row: { column_name: string }) => row.column_name);
  }

  async function appliedRows(): Promise<
    Array<{ name: string; attempts: number; batch: number }>
  > {
    const db = await freshDb();
    const result = await db.query(
      `SELECT name, attempts::int AS attempts, batch::int AS batch
         FROM _smrt_schema_migrations
        WHERE name LIKE $1 AND status = 'completed'`,
      `%cm3634_%${suffix}%`,
    );
    return result.rows;
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
    await db.query(`CREATE TABLE "${existing}" (id UUID PRIMARY KEY)`);
    await new MigrationTracker({ db }).initialize();
    installManifest();
  });

  afterEach(async () => {
    for (const spy of registrySpies.splice(0)) spy.mockRestore();
    try {
      const db = await freshDb();
      for (const tableName of allTables) {
        await db.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
      }
      await db.query(
        `DELETE FROM _smrt_schema_migrations WHERE name LIKE $1`,
        `%cm3634_%${suffix}%`,
      );
    } finally {
      for (const pool of pools.splice(0)) await pool.close?.();
      clearCache();
      process.exitCode = undefined;
      vi.restoreAllMocks();
    }
  });

  it('two simultaneous runs both succeed and apply the batch exactly once', async () => {
    const result = await runConcurrently([migrate(), migrate()]);

    expect(result.stderr).not.toContain('Migration failed');
    expect(result.stderr).not.toMatch(/already exists/i);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain(
      'Another db:migrate run holds the migration lock',
    );

    const columns = await columnNames(existing);
    for (const name of addedColumns) expect(columns).toContain(name);
    expect(await columnNames(created)).toEqual(
      expect.arrayContaining(['id', 'label']),
    );
    // Whichever run held the lock applied every change on its first attempt,
    // in one batch; the other run found nothing left to apply.
    const rows = await appliedRows();
    expect(rows.length).toBeGreaterThan(addedColumns.length);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(new Set(rows.map((row) => row.batch)).size).toBe(1);
  });

  it('waits behind a held lock without touching the schema, then migrates once it is released', async () => {
    const holderDb = await freshDb();
    const holder = await acquireMigrationLock(holderDb);
    let finished = false;

    const run = migrate()().then(() => {
      finished = true;
    });
    const resultPromise = runConcurrently([run]);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(finished).toBe(false);
    expect(await columnNames(existing)).toEqual(['id']);

    await holder.release();
    const result = await resultPromise;
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain(
      'Another db:migrate run holds the migration lock',
    );
    expect(result.stdout).toMatch(/Migration lock acquired after \d+s/);
    expect(await columnNames(existing)).toEqual(
      expect.arrayContaining(addedColumns),
    );
  });

  it('releases the lock when the run finishes', async () => {
    const result = await runConcurrently([migrate()]);
    expect(result.exitCode).toBeUndefined();

    const probe = await freshDb();
    const lock = await acquireMigrationLock(probe, { timeoutMs: 1000 });
    expect(lock.waitedMs).toBe(0);
    await lock.release();
  });

  it('a dry run never waits behind a real run', async () => {
    const holderDb = await freshDb();
    const holder = await acquireMigrationLock(holderDb);
    try {
      const command = utilityCommands['db:migrate'];
      const parsed = parseCliCommandArgs(
        ['db:migrate', '--dry-run'],
        [command],
      );
      const result = await runConcurrently([
        requireCommandHandler(command)(parsed.args, parsed.options),
      ]);
      expect(result.stdout).not.toContain('holds the migration lock');
      expect(await columnNames(existing)).toEqual(['id']);
    } finally {
      await holder.release();
    }
  });
});
