import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSchema } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeSqliteSchemaTemplateState,
  getDatabaseFromSqliteSchemaTemplate,
} from '../sqlite-schema-template.js';
import {
  createIsolatedTestDb,
  createIsolatedTestDbFromManifest,
} from '../test-db.js';

const { getDatabaseMock } = vi.hoisted(() => ({
  getDatabaseMock: vi.fn(),
}));

vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();

  return {
    ...actual,
    getDatabase: getDatabaseMock.mockImplementation(actual.getDatabase),
    syncSchema: vi.fn(actual.syncSchema),
  };
});

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalTestDbAdapter = process.env.TEST_DB_ADAPTER;
const lifecycleFixtureRoot = fileURLToPath(
  new URL('./fixtures/schema-template-worker-lifecycle', import.meta.url),
);
const lifecycleVitestBin = fileURLToPath(
  new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
);

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('SQLite isolated test database schema templates', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    process.env.TEST_DB_ADAPTER = 'sqlite';
    vi.mocked(syncSchema).mockClear();
    getDatabaseMock.mockClear();
  });

  afterEach(() => {
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('TEST_DB_ADAPTER', originalTestDbAdapter);
  });

  it('builds identical schema once while returning isolated databases', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const tableName = `schema_template_${suffix}`;
    const schema = `CREATE TABLE "${tableName}" ("id" TEXT PRIMARY KEY, "value" TEXT);`;

    const first = await createIsolatedTestDb({ schema, prefix: 'template-a' });
    try {
      await first.db.insert(tableName, { id: 'first', value: 'persisted' });
      expect(await first.db.list(tableName, {})).toHaveLength(1);
    } finally {
      await first.cleanup();
    }

    const second = await createIsolatedTestDb({
      schema,
      prefix: 'template-b',
    });
    try {
      expect(await second.db.list(tableName, {})).toHaveLength(0);
    } finally {
      await second.cleanup();
    }

    expect(syncSchema).toHaveBeenCalledTimes(1);
  });

  it('coordinates concurrent template creation for the same schema', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const tableName = `schema_template_concurrent_${suffix}`;
    const schema = `CREATE TABLE "${tableName}" ("id" TEXT PRIMARY KEY, "value" TEXT);`;

    const databases = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createIsolatedTestDb({
          schema,
          prefix: `template-concurrent-${index}`,
        }),
      ),
    );

    try {
      expect(new Set(databases.map(({ config }) => config.url)).size).toBe(4);

      await Promise.all(
        databases.map(async ({ db }, index) => {
          await db.insert(tableName, {
            id: `database-${index}`,
            value: `value-${index}`,
          });
          expect(await db.list(tableName, {})).toEqual([
            expect.objectContaining({ id: `database-${index}` }),
          ]);
        }),
      );
    } finally {
      await Promise.all(databases.map(({ cleanup }) => cleanup()));
    }

    expect(syncSchema).toHaveBeenCalledTimes(1);
  });

  it('uses separate templates when schema content differs', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const firstTable = `schema_template_first_${suffix}`;
    const secondTable = `schema_template_second_${suffix}`;

    const first = await createIsolatedTestDb({
      schema: `CREATE TABLE "${firstTable}" ("id" TEXT PRIMARY KEY);`,
      prefix: 'template-first-schema',
    });
    const second = await createIsolatedTestDb({
      schema: `CREATE TABLE "${secondTable}" ("id" TEXT PRIMARY KEY);`,
      prefix: 'template-second-schema',
    });

    try {
      expect(await first.db.list(firstTable, {})).toEqual([]);
      expect(await second.db.list(secondTable, {})).toEqual([]);
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }

    expect(syncSchema).toHaveBeenCalledTimes(2);
  });

  it('closes a failed preparation without deleting a caller-owned SQLite file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-vitest-template-test-'));
    const targetPath = join(directory, 'caller-owned.db');
    writeFileSync(targetPath, '');
    const close = vi.fn().mockResolvedValue(undefined);
    const prepareError = new Error('prepare failed');

    try {
      await expect(
        getDatabaseFromSqliteSchemaTemplate({
          cacheKey: `failure-${randomUUID()}`,
          databaseOptions: { type: 'sqlite', url: targetPath },
          getDatabase: async () => ({ query: vi.fn(), close }),
          prepare: async () => {
            throw prepareError;
          },
        }),
      ).rejects.toBe(prepareError);

      expect(close).toHaveBeenCalledOnce();
      expect(existsSync(targetPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('closes the base handle when PostgreSQL schema setup fails', async () => {
    process.env.TEST_DB_ADAPTER = 'postgres';
    const close = vi.fn().mockResolvedValue(undefined);
    getDatabaseMock.mockResolvedValue({ close, query: vi.fn() });
    vi.mocked(syncSchema).mockRejectedValueOnce(new Error('schema failed'));

    await expect(
      createIsolatedTestDb({ schema: 'CREATE TABLE cleanup_probe (id TEXT)' }),
    ).rejects.toThrow('schema failed');

    expect(close).toHaveBeenCalledOnce();
    expect(getDatabaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ cache: false }),
    );
  });

  it('closes the base handle when manifest schema preparation lacks transactions', async () => {
    process.env.TEST_DB_ADAPTER = 'postgres';
    const directory = mkdtempSync(join(tmpdir(), 'smrt-vitest-manifest-test-'));
    const manifestPath = join(directory, 'manifest.json');
    const close = vi.fn().mockResolvedValue(undefined);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        objects: {
          CleanupProbe: {
            className: 'CleanupProbe',
            schema: {
              tableName: 'cleanup_probe',
              ddl: 'CREATE TABLE cleanup_probe (id TEXT PRIMARY KEY)',
            },
          },
        },
      }),
    );
    getDatabaseMock.mockResolvedValue({ close, query: vi.fn() });

    try {
      await expect(
        createIsolatedTestDbFromManifest({ manifestPath }),
      ).rejects.toThrow('does not support beginTransaction');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves schema failure when manifest transaction rollback also fails', async () => {
    process.env.TEST_DB_ADAPTER = 'postgres';
    const directory = mkdtempSync(join(tmpdir(), 'smrt-vitest-manifest-test-'));
    const manifestPath = join(directory, 'manifest.json');
    const close = vi.fn().mockResolvedValue(undefined);
    const rollback = vi.fn().mockRejectedValue(new Error('rollback failed'));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        objects: {
          CleanupProbe: {
            className: 'CleanupProbe',
            schema: {
              tableName: 'cleanup_probe',
              ddl: 'CREATE TABLE cleanup_probe (id TEXT PRIMARY KEY)',
            },
          },
        },
      }),
    );
    getDatabaseMock.mockResolvedValue({
      close,
      query: vi.fn(),
      beginTransaction: vi.fn().mockResolvedValue({
        query: vi.fn().mockRejectedValue(new Error('schema failed')),
        isActive: () => true,
        rollback,
      }),
    });

    try {
      await expect(
        createIsolatedTestDbFromManifest({ manifestPath }),
      ).rejects.toThrow(
        'PostgreSQL manifest schema preparation and rollback failed',
      );
      expect(rollback).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const pool of ['forks', 'threads'] as const) {
    it(`disposes worker-owned template state after a ${pool} worker run`, () => {
      const reportDirectory = mkdtempSync(
        join(tmpdir(), `smrt-vitest-${pool}-lifecycle-`),
      );
      const stateDirectoryPath = join(
        reportDirectory,
        'template-directory.txt',
      );
      try {
        execFileSync(process.execPath, [lifecycleVitestBin, 'run'], {
          cwd: lifecycleFixtureRoot,
          env: {
            ...process.env,
            SMRT_TEMPLATE_POOL: pool,
            SMRT_TEMPLATE_STATE_PATH: stateDirectoryPath,
          },
          stdio: 'pipe',
        });
        const templateDirectory = readFileSync(stateDirectoryPath, 'utf8');
        expect(templateDirectory).toBeTruthy();
        expect(existsSync(templateDirectory)).toBe(false);
      } finally {
        rmSync(reportDirectory, { recursive: true, force: true });
      }
    });
  }

  it('disposes a worker-owned template cache only once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-vitest-dispose-test-'));
    const targetPath = join(directory, 'owned.db');
    try {
      await getDatabaseFromSqliteSchemaTemplate({
        cacheKey: `dispose-${randomUUID()}`,
        databaseOptions: { type: 'sqlite', url: targetPath },
        getDatabase: async () => ({
          query: async (_sql: string, snapshotPath?: unknown) => {
            if (typeof snapshotPath === 'string')
              writeFileSync(snapshotPath, '');
          },
        }),
        prepare: async () => {},
      });
      const state = globalThis as typeof globalThis & {
        __smrtVitestSqliteSchemaTemplates?: { directory: string };
      };
      const templateDirectory =
        state.__smrtVitestSqliteSchemaTemplates?.directory;
      expect(templateDirectory).toBeTruthy();

      disposeSqliteSchemaTemplateState();
      disposeSqliteSchemaTemplateState();

      expect(existsSync(templateDirectory ?? '')).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
