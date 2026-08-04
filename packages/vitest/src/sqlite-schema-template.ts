import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SqliteSchemaTemplateState {
  directory: string;
  templates: Map<string, Promise<string>>;
}

interface SqliteSchemaTemplateDatabase {
  query: (sql: string, ...values: unknown[]) => Promise<unknown>;
  close?: () => Promise<void>;
}

interface SqliteSchemaTemplateOptions<
  Database extends SqliteSchemaTemplateDatabase,
> {
  cacheKey: string;
  databaseOptions: Record<string, unknown> & { url?: string };
  getDatabase: (
    options: Record<string, unknown> & { url?: string },
  ) => Promise<Database>;
  prepare: (database: Database) => Promise<void>;
}

type GlobalWithSqliteSchemaTemplates = typeof globalThis & {
  __smrtVitestSqliteSchemaTemplates?: SqliteSchemaTemplateState;
};

function removeSqliteFiles(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function getSqliteSchemaTemplateState(): SqliteSchemaTemplateState {
  const globalState = globalThis as GlobalWithSqliteSchemaTemplates;
  const existing = globalState.__smrtVitestSqliteSchemaTemplates;
  if (existing) {
    return existing;
  }

  const directory = join(
    tmpdir(),
    `smrt-vitest-schema-templates-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(directory, { recursive: true });

  const state: SqliteSchemaTemplateState = {
    directory,
    templates: new Map(),
  };
  globalState.__smrtVitestSqliteSchemaTemplates = state;

  process.once('exit', () => {
    rmSync(directory, { recursive: true, force: true });
  });

  return state;
}

/** Resolve a local SQLite URL to the file copied from a schema template. */
export function getLocalSqliteFilePath(
  options: { type?: string; url?: string } | undefined,
): string | undefined {
  if (!options?.url || (options.type && options.type !== 'sqlite')) {
    return undefined;
  }

  const { url } = options;
  if (
    url === ':memory:' ||
    url === 'memory' ||
    url === 'file::memory:' ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('libsql://')
  ) {
    return undefined;
  }

  if (url.startsWith('file:')) {
    try {
      return fileURLToPath(url);
    } catch {
      return undefined;
    }
  }

  return isAbsolute(url) ? url : resolve(url);
}

const speedPragmasApplied = new WeakSet<object>();

/**
 * Strip durability from local file-backed SQLite test databases.
 *
 * Test databases are created fresh per test and discarded afterwards, so
 * crash durability buys nothing — but SQLite's defaults (`synchronous=FULL`,
 * DELETE journal) cost 2-3 fsyncs per transaction. On runners with slow
 * fsync that dominates wall time: 9.5 ms/fsync measured on the metal CI
 * fleet turned the users package's catalog-seeding tests (~41k fsyncs) into
 * 200-400 s timeouts (#2221). `synchronous=OFF` removes fsync entirely,
 * `journal_mode=MEMORY` removes journal-file I/O (per-connection, safe for
 * the single-connection chains test databases use), and `temp_store=MEMORY`
 * keeps sort/temp b-trees off disk.
 *
 * Only file-backed local SQLite is touched: PostgreSQL and DuckDB reject
 * these pragmas, in-memory SQLite never fsyncs, and a thrown pragma must
 * never fail a test, so everything is guarded and best-effort. Applied by
 * the setup file's `getDatabase` mock and by the isolated test-db factories;
 * a test that needs real durability semantics must open its database with
 * `getDatabase` and `__smrtSkipVitestSchemaPreparation` directly.
 */
export async function applySqliteSpeedPragmas(
  db: unknown,
  options: { type?: string; url?: string } | undefined,
): Promise<void> {
  if (!db || typeof db !== 'object' || speedPragmasApplied.has(db)) {
    return;
  }
  const isConfigObject =
    options && typeof options === 'object' && !('query' in options);
  if (!isConfigObject || !getLocalSqliteFilePath(options)) {
    return;
  }
  const query = (db as { query?: (sql: string) => Promise<unknown> }).query;
  if (typeof query !== 'function') {
    return;
  }
  // Marked before execution on purpose: a handle whose pragmas failed once
  // (e.g. transient SQLITE_BUSY) stays best-effort-configured rather than
  // retrying on every getDatabase call.
  speedPragmasApplied.add(db);
  try {
    await query.call(db, 'PRAGMA synchronous = OFF');
    await query.call(db, 'PRAGMA journal_mode = MEMORY');
    await query.call(db, 'PRAGMA temp_store = MEMORY');
  } catch {
    // Best-effort: an adapter that rejects pragmas keeps its defaults.
  }
}

/**
 * Open a fresh local SQLite database using an immutable schema-only template.
 *
 * The first caller prepares its own target database and snapshots it with
 * `VACUUM INTO`. Concurrent and later callers copy that snapshot before
 * opening their independent connection. Existing database files are never
 * replaced; they retain the normal additive schema-preparation path.
 */
export async function getDatabaseFromSqliteSchemaTemplate<
  Database extends SqliteSchemaTemplateDatabase,
>({
  cacheKey,
  databaseOptions,
  getDatabase,
  prepare,
}: SqliteSchemaTemplateOptions<Database>): Promise<Database> {
  const targetPath = getLocalSqliteFilePath(databaseOptions);
  if (!targetPath) {
    const database = await getDatabase(databaseOptions);
    await prepare(database);
    return database;
  }

  // Never replace a fixture or a database already populated by this test.
  if (existsSync(targetPath) && statSync(targetPath).size > 0) {
    const database = await getDatabase(databaseOptions);
    await prepare(database);
    return database;
  }

  const state = getSqliteSchemaTemplateState();
  const templateHash = createHash('sha256')
    .update('smrt-vitest-sqlite-template-v1\0')
    .update(cacheKey)
    .digest('hex');
  const templatePath = join(state.directory, `${templateHash}.db`);
  let templatePromise = state.templates.get(templateHash);

  if (templatePromise || existsSync(templatePath)) {
    if (!templatePromise) {
      templatePromise = Promise.resolve(templatePath);
      state.templates.set(templateHash, templatePromise);
    }
    await templatePromise;

    try {
      copyFileSync(templatePath, targetPath);
      return await getDatabase(databaseOptions);
    } catch (error) {
      removeSqliteFiles(targetPath);
      throw error;
    }
  }

  let resolveTemplate!: (path: string) => void;
  let rejectTemplate!: (error: unknown) => void;
  templatePromise = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveTemplate = resolvePromise;
    rejectTemplate = rejectPromise;
  });
  // The builder rethrows failures itself; this prevents an unhandled rejection
  // when no concurrent caller is awaiting the same schema.
  void templatePromise.catch(() => {});
  state.templates.set(templateHash, templatePromise);

  const snapshotPath = join(state.directory, `${randomUUID()}.snapshot.db`);
  let database: Database | undefined;

  try {
    database = await getDatabase(databaseOptions);
    await prepare(database);

    // Public SQL API only: VACUUM INTO captures committed schema from a live
    // SQLite/WAL connection without reaching into the adapter's raw client.
    await database.query('VACUUM INTO ?', snapshotPath);
    renameSync(snapshotPath, templatePath);
    resolveTemplate(templatePath);
    return database;
  } catch (error) {
    rejectTemplate(error);
    if (state.templates.get(templateHash) === templatePromise) {
      state.templates.delete(templateHash);
    }
    try {
      await database?.close?.();
    } catch {
      // Best effort: older SQLite adapters do not expose close().
    }
    removeSqliteFiles(targetPath);
    throw error;
  } finally {
    removeSqliteFiles(snapshotPath);
  }
}
