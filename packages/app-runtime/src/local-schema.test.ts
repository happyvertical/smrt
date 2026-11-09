import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { UserCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  initializeLocalApplicationRuntime,
  type LocalPrepareDatabaseContext,
  LocalRuntimeError,
  MIGRATION_FAILED_MESSAGE,
  SCHEMA_CREATION_FAILED_MESSAGE,
} from './index.js';
import { createSmrtSvelteKitRuntime } from './sveltekit/runtime.js';

const frameworkStep = vi.hoisted(() => ({
  failBeforeWriting: false,
  failAfterWriting: false,
  calls: 0,
}));

// The framework step is the real `migrateSmrtSchemas`; the mock only lets a
// test make it fail AFTER it has written, to prove the rollback.
vi.mock('@happyvertical/smrt-core/migrations', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@happyvertical/smrt-core/migrations')
    >();
  return {
    ...actual,
    migrateSmrtSchemas: async (
      ...args: Parameters<typeof actual.migrateSmrtSchemas>
    ) => {
      frameworkStep.calls += 1;
      if (frameworkStep.failBeforeWriting) {
        throw new Error('driver text with /private/path and CREATE TABLE');
      }
      const result = await actual.migrateSmrtSchemas(...args);
      if (frameworkStep.failAfterWriting) {
        throw new Error(
          'driver text with /private/path/application.sqlite and CREATE TABLE secrets',
        );
      }
      return result;
    },
  };
});

// The shared test setup pre-creates every registered table whenever a database
// opens, which would hide exactly what these tests prove: the RUNTIME creating
// the schema on an empty data directory.
const originalAutoSchema = process.env.SMRT_VITEST_AUTO_SCHEMA;
beforeAll(() => {
  process.env.SMRT_VITEST_AUTO_SCHEMA = '0';
});
afterAll(() => {
  if (originalAutoSchema === undefined) {
    delete process.env.SMRT_VITEST_AUTO_SCHEMA;
  } else {
    process.env.SMRT_VITEST_AUTO_SCHEMA = originalAutoSchema;
  }
});

const temporaryRoots: string[] = [];
const lockPaths = new Set<string>();

async function directories(label: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `smrt-schema-${label}-`)),
  );
  temporaryRoots.push(root);
  const sourceRoot = join(root, 'source');
  const dataDirectory = join(root, 'data');
  await mkdir(sourceRoot);
  registerLegacyLock(dataDirectory);
  return {
    sourceRoot,
    dataDirectory,
    database: join(dataDirectory, 'application.sqlite'),
  };
}

function registerLegacyLock(dataDirectory: string) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Tests require a numeric uid.');
  const identity =
    platform() === 'darwin' ? dataDirectory.toLowerCase() : dataDirectory;
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  lockPaths.add(join('/tmp', `.smrt-${uid}`, key, 'initialization.sqlite'));
}

afterEach(async () => {
  frameworkStep.failBeforeWriting = false;
  frameworkStep.failAfterWriting = false;
  frameworkStep.calls = 0;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  for (const lockPath of lockPaths) {
    for (const suffix of ['', '-journal', '-shm', '-wal']) {
      await rm(`${lockPath}${suffix}`, { force: true });
    }
    await rm(dirname(lockPath), { recursive: true, force: true });
  }
  lockPaths.clear();
});

async function tableNames(db: DatabaseInterface): Promise<string[]> {
  const result = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return (result.rows as { name: string }[]).map((row) => row.name);
}

async function count(db: DatabaseInterface, table: string): Promise<number> {
  const result = await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number((result.rows[0] as { n: unknown }).n);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function failureOf(
  promise: Promise<unknown>,
): Promise<LocalRuntimeError> {
  const failure = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(LocalRuntimeError);
  return failure as LocalRuntimeError;
}

describe('first-start schema creation (smrt#4835)', () => {
  it('creates the schema on an empty data directory and then serves', async () => {
    const dirs = await directories('first');
    const seen: {
      firstRun: boolean;
      profile: string;
      root: string;
      sameDb: boolean;
    }[] = [];
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'schema-app',
      ...dirs,
      createSchema: true,
      prepareDatabase: async (db, context) => {
        seen.push({
          firstRun: context.firstRun,
          profile: context.profile,
          root: context.paths.root,
          sameDb: context.db === db,
        });
      },
    });

    expect(seen).toEqual([
      {
        firstRun: true,
        profile: 'local',
        root: dirs.dataDirectory,
        sameDb: true,
      },
    ]);
    const tables = await tableNames(initialized.runtime.db);
    expect(tables).toContain('_smrt_schema_migrations');
    expect(tables).toContain('_smrt_local_owner_bootstrap');
    expect(tables.length).toBeGreaterThan(8);
    // The framework's own collections work: this is the schema a user needs.
    const users = await UserCollection.create({ db: initialized.runtime.db });
    await expect(users.list({ limit: 1 })).resolves.toEqual([]);
    expect(initialized.bootstrap?.token).toBeTruthy();
    await initialized.runtime.db.close?.();
  });

  it('is a no-op on the second start and runs the app step again with firstRun false', async () => {
    const dirs = await directories('second');
    const firstRuns: boolean[] = [];
    const options = {
      appId: 'schema-app',
      ...dirs,
      createSchema: true,
      prepareDatabase: async (
        _db: DatabaseInterface,
        context: LocalPrepareDatabaseContext,
      ) => {
        firstRuns.push(context.firstRun);
      },
    };
    const first = await initializeLocalApplicationRuntime(options);
    const tablesAfterFirst = await tableNames(first.runtime.db);
    const migrationRows = await count(
      first.runtime.db,
      '_smrt_schema_migrations',
    );
    await first.runtime.db.close?.();

    const second = await initializeLocalApplicationRuntime(options);
    expect(firstRuns).toEqual([true, false]);
    expect(await tableNames(second.runtime.db)).toEqual(tablesAfterFirst);
    expect(await count(second.runtime.db, '_smrt_schema_migrations')).toBe(
      migrationRows,
    );
    await second.runtime.db.close?.();
  });

  it('does not race: two concurrent starts create the schema once', async () => {
    const dirs = await directories('race');
    const firstRuns: boolean[] = [];
    let active = 0;
    let maximumActive = 0;
    const options = {
      appId: 'schema-app',
      ...dirs,
      createSchema: true,
      prepareDatabase: async (
        _db: DatabaseInterface,
        context: LocalPrepareDatabaseContext,
      ) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        firstRuns.push(context.firstRun);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active -= 1;
      },
    };
    const [a, b] = await Promise.all([
      initializeLocalApplicationRuntime(options),
      initializeLocalApplicationRuntime(options),
    ]);
    expect(maximumActive).toBe(1);
    expect([...firstRuns].sort()).toEqual([false, true]);
    expect(await count(a.runtime.db, '_smrt_schema_migrations')).toBe(1);
    await a.runtime.db.close?.();
    await b.runtime.db.close?.();
  });

  it('lets the app add its own tables and seeds through the same hook', async () => {
    const dirs = await directories('app-step');
    const prepareDatabase = async (db: DatabaseInterface) => {
      await db.query(
        'CREATE TABLE IF NOT EXISTS app_notes (id INTEGER PRIMARY KEY, body TEXT)',
      );
      await db.query(
        "INSERT INTO app_notes (id, body) VALUES (1, 'seed') ON CONFLICT (id) DO NOTHING",
      );
    };
    const options = {
      appId: 'schema-app',
      ...dirs,
      createSchema: true,
      prepareDatabase,
    };
    const first = await initializeLocalApplicationRuntime(options);
    await first.runtime.db.close?.();
    const second = await initializeLocalApplicationRuntime(options);
    expect(await count(second.runtime.db, 'app_notes')).toBe(1);
    await second.runtime.db.close?.();
  });

  it('exposes the framework migration runner to the app step', async () => {
    const dirs = await directories('runner');
    let applied: boolean | undefined;
    const initialized = await initializeLocalApplicationRuntime({
      appId: 'schema-app',
      ...dirs,
      createSchema: true,
      // The framework step already ran: the runner finds nothing to apply.
      prepareDatabase: async (_db, context) => {
        applied = (await context.migrateSchemas()).applied;
      },
    });
    expect(applied).toBe(false);
    await initialized.runtime.db.close?.();
  });

  it('rolls back and removes the database when the framework step fails on a first run', async () => {
    const dirs = await directories('framework-fail');
    frameworkStep.failAfterWriting = true;
    const hook = vi.fn(async () => undefined);
    const failure = await failureOf(
      initializeLocalApplicationRuntime({
        appId: 'schema-app',
        ...dirs,
        createSchema: true,
        prepareDatabase: hook,
      }),
    );

    expect(failure.code).toBe('schema_creation_failed');
    expect(failure.message).toBe(SCHEMA_CREATION_FAILED_MESSAGE);
    expect(failure.message).not.toContain('/private/path');
    expect(failure.message).not.toContain('CREATE TABLE');
    expect(Object.keys(failure)).not.toContain('cause');
    expect(hook).not.toHaveBeenCalled();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      expect(await exists(`${dirs.database}${suffix}`)).toBe(false);
    }

    // The same data directory is retryable and behaves as a first run.
    frameworkStep.failAfterWriting = false;
    const retried = await initializeLocalApplicationRuntime({
      appId: 'schema-app',
      ...dirs,
      createSchema: true,
      prepareDatabase: hook,
    });
    expect(await tableNames(retried.runtime.db)).toContain(
      '_smrt_schema_migrations',
    );
    expect(hook).toHaveBeenCalledOnce();
    await retried.runtime.db.close?.();
  });

  it('rolls back and removes the database when the app step fails on a first run', async () => {
    const dirs = await directories('app-fail');
    const failure = await failureOf(
      initializeLocalApplicationRuntime({
        appId: 'schema-app',
        ...dirs,
        createSchema: true,
        prepareDatabase: async (db) => {
          await db.query('CREATE TABLE app_things (id INTEGER PRIMARY KEY)');
          throw new Error('postgres://admin:hunter2@db/private');
        },
      }),
    );
    expect(failure.code).toBe('migration_failed');
    expect(failure.message).toBe(MIGRATION_FAILED_MESSAGE);
    expect(failure.message).not.toContain('hunter2');
    expect(await exists(dirs.database)).toBe(false);
    expect(await exists(`${dirs.database}-wal`)).toBe(false);
  });

  it('keeps an existing database as it was when an upgrade step fails', async () => {
    const dirs = await directories('upgrade-fail');
    const first = await initializeLocalApplicationRuntime({
      appId: 'schema-app',
      ...dirs,
      createSchema: true,
    });
    const tablesBefore = await tableNames(first.runtime.db);
    const rowsBefore = await count(first.runtime.db, '_smrt_schema_migrations');
    await first.runtime.db.close?.();

    // App step: a table it creates before failing must not survive.
    const appFailure = await failureOf(
      initializeLocalApplicationRuntime({
        appId: 'schema-app',
        ...dirs,
        createSchema: true,
        prepareDatabase: async (db) => {
          await db.query('CREATE TABLE app_things (id INTEGER PRIMARY KEY)');
          throw new Error('app step failed');
        },
      }),
    );
    expect(appFailure.code).toBe('migration_failed');

    // Framework step: a failed upgrade batch changes nothing.
    frameworkStep.failBeforeWriting = true;
    const frameworkFailure = await failureOf(
      initializeLocalApplicationRuntime({
        appId: 'schema-app',
        ...dirs,
        createSchema: true,
      }),
    );
    expect(frameworkFailure.code).toBe('schema_creation_failed');
    frameworkStep.failBeforeWriting = false;

    expect(await exists(dirs.database)).toBe(true);
    const again = await initializeLocalApplicationRuntime({
      appId: 'schema-app',
      ...dirs,
      createSchema: true,
    });
    expect(await tableNames(again.runtime.db)).toEqual(tablesBefore);
    expect(await count(again.runtime.db, '_smrt_schema_migrations')).toBe(
      rowsBefore,
    );
    await again.runtime.db.close?.();
  });

  it('upgrades an older database through the same migration path', async () => {
    const dirs = await directories('upgrade');
    const first = await initializeLocalApplicationRuntime({
      appId: 'schema-app',
      ...dirs,
      createSchema: true,
    });
    // Simulate a database from an older release: a framework column is gone.
    await first.runtime.db.query('ALTER TABLE tenants DROP COLUMN description');
    await first.runtime.db.close?.();

    const second = await initializeLocalApplicationRuntime({
      appId: 'schema-app',
      ...dirs,
      createSchema: true,
    });
    const columns = await second.runtime.db.query('PRAGMA table_info(tenants)');
    expect(
      (columns.rows as { name: string }[]).map((row) => row.name),
    ).toContain('description');
    await second.runtime.db.close?.();
  });

  it('does not create schema unless asked: an empty directory still fails with DB_SCHEMA_MISSING', async () => {
    const dirs = await directories('off');
    const hook = vi.fn(async () => undefined);
    // The historical behaviour operator tooling relies on (it migrates through
    // `smrt db:migrate`): nothing is created, the first read fails closed.
    await expect(
      initializeLocalApplicationRuntime({
        appId: 'schema-app',
        ...dirs,
        prepareDatabase: hook,
      }),
    ).rejects.toMatchObject({ code: 'DB_SCHEMA_MISSING' });
    expect(frameworkStep.calls).toBe(0);
    expect(hook).toHaveBeenCalledOnce();
  });

  it('serves from an empty data directory through the SvelteKit runtime', async () => {
    const dirs = await directories('sveltekit');
    const firstRuns: boolean[] = [];
    const runtime = createSmrtSvelteKitRuntime({
      appId: 'schema-app',
      sourceRoot: dirs.sourceRoot,
      dataDirectory: dirs.dataDirectory,
      runtime: resolveApplicationRuntime({ profile: 'local' }),
      env: { NODE_ENV: 'development' },
      acquireWriterLease: false,
      enableTenancy: false,
      prepareDatabase: async (_db, context) => {
        firstRuns.push(context.firstRun);
      },
    });
    await runtime.init();
    const local = await runtime.localRuntime();
    expect(firstRuns).toEqual([true]);
    expect(await tableNames(local.db)).toContain('_smrt_schema_migrations');
    const users = await UserCollection.create({ db: local.db });
    await expect(users.list({ limit: 1 })).resolves.toEqual([]);
    await local.db.close?.();
  });

  it('refuses a data root that fails custody before it creates anything', async () => {
    const dirs = await directories('custody');
    await mkdir(dirs.dataDirectory, { mode: 0o755 });
    await chmod(dirs.dataDirectory, 0o755);
    const hook = vi.fn(async () => undefined);
    await expect(
      initializeLocalApplicationRuntime({
        appId: 'schema-app',
        ...dirs,
        createSchema: true,
        prepareDatabase: hook,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(hook).not.toHaveBeenCalled();
    expect(frameworkStep.calls).toBe(0);
    expect(await exists(dirs.database)).toBe(false);
  });
});
