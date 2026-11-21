/**
 * #5325: `db:migrate --dry-run` reports a retry the real run would refuse, on
 * real PostgreSQL SQL in-process (PGlite), and changes nothing.
 */
import { PGlite } from '@electric-sql/pglite';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { parseCliCommandArgs } from '../../cli-generator.js';
import { utilityCommands } from '../utilities.js';

const h = vi.hoisted(() => ({
  db: undefined as DatabaseInterface | undefined,
}));
vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();
  return {
    ...actual,
    getDatabase: (options: Parameters<typeof actual.getDatabase>[0]) =>
      options && 'type' in options && options.type === 'postgres'
        ? Promise.resolve(h.db)
        : actual.getDatabase(options),
  };
});
vi.mock('@happyvertical/smrt-core/migrations', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@happyvertical/smrt-core/migrations')
    >();
  return {
    ...actual,
    acquireMigrationLock: vi.fn(async () => ({
      held: false,
      waitedMs: 0,
      assertHeld: async () => {},
      release: async () => {},
    })),
  };
});
vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(async () => ({
    discovered: [
      { path: '/fake/.smrt/manifest.json', source: 'project', objectCount: 1 },
    ],
    totalObjects: 1,
  })),
}));

const url = 'postgresql://pglite/5325';
function postgresView(db: DatabaseInterface): DatabaseInterface {
  return {
    ...db,
    url,
    close: async () => {},
    transaction: async <T>(work: (tx: DatabaseInterface) => Promise<T>) => {
      if (!db.transaction) throw new Error('Transaction support required');
      return db.transaction((tx) => work(postgresView(tx)));
    },
  };
}

const titled: SchemaDefinition = {
  tableName: 'titled',
  columns: {
    id: { type: 'TEXT', primaryKey: true },
    title: { type: 'TEXT' },
  },
  indexes: [{ name: 'titled_title_unique', columns: ['title'], unique: true }],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '5325',
};

describe('db:migrate --dry-run and a refused retry (#5325)', () => {
  let db: DatabaseInterface;
  let client: PGlite;
  let logs: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    client = new PGlite();
    db = await getDatabase({ type: 'pglite', client });
    h.db = postgresView(db);
    clearCache();
    setConfig({ packages: { cli: { database: { type: 'postgres', url } } } });
    await db.query('CREATE TABLE titled (id TEXT PRIMARY KEY, title TEXT)');
    await db.query("INSERT INTO titled VALUES ('a', 'same'), ('b', 'same')");
    const schemas = { titled };
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockImplementation(
      () => schemas,
    );
    vi.spyOn(ObjectRegistry, 'getInitializationOrder').mockReturnValue(
      Object.keys(schemas),
    );
    vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation(
      (name: string) => name,
    );
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    await client?.close();
    h.db = undefined;
    clearCache();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
  async function run(...flags: string[]) {
    process.exitCode = undefined;
    logs.mockClear();
    errors.mockClear();
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate', ...flags], [command]);
    await requireCommandHandler(command)(parsed.args, parsed.options);
    return {
      output: [...logs.mock.calls, ...errors.mock.calls]
        .map((c) => c.join(' '))
        .join('\n'),
      exitCode: process.exitCode,
    };
  }
  const record = async () =>
    (
      await db.query(
        "SELECT status, attempts FROM _smrt_schema_migrations WHERE name LIKE '%titled_title_unique%'",
      )
    ).rows;

  it('reports the refusal the real run would give, and changes nothing', async () => {
    const first = await run('--postgres-safe');
    expect(first.exitCode, first.output).toBe(1);
    const recorded = await record();
    expect(recorded).toEqual([expect.objectContaining({ status: 'failed' })]);
    await db.query("UPDATE titled SET title = 'different' WHERE id = 'b'");

    const preview = await run('--dry-run');

    expect(preview.exitCode, preview.output).toBe(1);
    expect(preview.output).toContain('was not retried');
    expect(preview.output).not.toContain('Dry-run complete');
    expect(await record()).toEqual(recorded);
    const real = await run();
    expect(real.exitCode, real.output).toBe(1);
    expect(real.output).toContain('was not retried');
  });

  it('previews without creating or altering anything, ahead of the timestamp conversion', async () => {
    const first = await run('--postgres-safe');
    expect(first.exitCode, first.output).toBe(1);
    await db.query("UPDATE titled SET title = 'different' WHERE id = 'b'");
    await db.query('DROP INDEX idx_smrt_schema_migrations_batch');
    // The conversion the preview is meant to show before it runs.
    await db.query(
      'ALTER TABLE _smrt_schema_migrations ALTER COLUMN rolled_back_at TYPE timestamp without time zone',
    );

    const preview = await run(
      '--dry-run',
      '--postgres-safe',
      '--postgres-timestamp-legacy-timezone',
      'UTC',
    );

    expect(preview.output).not.toContain('Legacy SMRT system timestamps');
    expect(preview.exitCode ?? 0, preview.output).toBe(0);
    expect(preview.output).toContain('Dry-run complete');
    expect(
      (
        await db.query(
          "SELECT to_regclass('idx_smrt_schema_migrations_batch') AS found",
        )
      ).rows[0]?.found,
    ).toBeNull();
  });

  it('previews a retry the real run accepts as before', async () => {
    const first = await run('--postgres-safe');
    expect(first.exitCode, first.output).toBe(1);
    await db.query("UPDATE titled SET title = 'different' WHERE id = 'b'");

    const preview = await run('--dry-run', '--postgres-safe');

    expect(preview.exitCode ?? 0, preview.output).toBe(0);
    expect(preview.output).toContain('Dry-run complete');
  });
});
