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
