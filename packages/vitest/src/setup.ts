/**
 * Vitest setup file for globalThis state isolation
 *
 * Import this file in your vitest.config.ts to prevent
 * manifest cache and registry state from bleeding across test files.
 *
 * @example
 * ```typescript
 * // vitest.config.ts
 * import { defineConfig } from 'vitest/config';
 *
 * export default defineConfig({
 *   test: {
 *     setupFiles: ['@happyvertical/smrt-vitest/setup'],
 *   },
 * });
 * ```
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SchemaDefinition } from '@happyvertical/smrt-core';
import { afterAll, beforeAll, vi } from 'vitest';
import {
  getDatabaseFromSqliteSchemaTemplate,
  getLocalSqliteFilePath,
} from './sqlite-schema-template.js';

// Type alias for any to avoid conflicts with smrt-core's globalThis declarations
type CacheState = unknown;
type VitestDatabaseOptions = Parameters<
  typeof import('@happyvertical/sql')['getDatabase']
>[0] & {
  __smrtSkipVitestSchemaPreparation?: boolean;
};

/**
 * The subset of the `@happyvertical/smrt-core` public API that the vitest
 * schema-preparation hook depends on. smrt-core is loaded dynamically (with a
 * monorepo source fallback) so it may be absent in some test environments;
 * this captures the exact shape consumed by {@link buildSchemaSqlBatches}.
 */
interface SmrtCoreSchemaModule {
  ObjectRegistry: {
    getAllSchemasAsDefinitions(): Record<string, SchemaDefinition>;
  };
  detectEngine(
    url: string,
    type?: string,
  ): 'sqlite' | 'duckdb' | 'json' | 'postgres';
  generateDDLForEngine(
    schema: SchemaDefinition,
    engine: 'sqlite' | 'duckdb' | 'json' | 'postgres',
  ): {
    createTable: string;
    indexes: string[];
    triggers: string[];
  };
}

const preparedSchemasByDb = new WeakMap<object, string>();
const preparedSchemasByConfig = new Map<string, string>();
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
 * never fail a test, so everything is guarded and best-effort.
 *
 * @internal exported for regression testing only (#2221)
 */
export async function applySqliteSpeedPragmas(
  db: unknown,
  options: VitestDatabaseOptions,
): Promise<void> {
  if (!db || typeof db !== 'object' || speedPragmasApplied.has(db)) {
    return;
  }
  const isConfigObject =
    options && typeof options === 'object' && !('query' in options);
  if (
    !isConfigObject ||
    !getLocalSqliteFilePath(options as { type?: string; url?: string })
  ) {
    return;
  }
  const query = (db as { query?: (sql: string) => Promise<unknown> }).query;
  if (typeof query !== 'function') {
    return;
  }
  speedPragmasApplied.add(db);
  try {
    await query.call(db, 'PRAGMA synchronous = OFF');
    await query.call(db, 'PRAGMA journal_mode = MEMORY');
    await query.call(db, 'PRAGMA temp_store = MEMORY');
  } catch {
    // Best-effort: an adapter that rejects pragmas keeps its defaults.
  }
}

function findWorkspaceRoot(startDir: string): string | null {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function importWorkspaceSourceModule<T>(href: string): Promise<T> {
  const { register } = await import('tsx/esm/api');
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const tsconfigPath =
    workspaceRoot &&
    existsSync(join(workspaceRoot, 'tsconfig.package-build.json'))
      ? join(workspaceRoot, 'tsconfig.package-build.json')
      : null;
  const unregister = register(
    tsconfigPath ? { tsconfig: tsconfigPath } : undefined,
  );

  try {
    return (await import(href)) as T;
  } finally {
    await unregister();
  }
}

function getSchemaPreparationKey(
  options: VitestDatabaseOptions | undefined,
): string | undefined {
  if (!options || typeof options !== 'object' || 'query' in options) {
    return undefined;
  }

  const dbConfig = options as {
    dbid?: string;
    type?: string;
    url?: string;
  };
  const dbUrl = dbConfig.url;
  if (
    !dbUrl ||
    dbUrl === ':memory:' ||
    dbUrl === 'memory' ||
    dbUrl === 'file::memory:'
  ) {
    return undefined;
  }

  return dbConfig.dbid || `${dbConfig.type || 'sqlite'}:${dbUrl}`;
}

async function loadSmrtCoreModule(): Promise<SmrtCoreSchemaModule> {
  const specifier = '@happyvertical/smrt-core';

  try {
    const module = (await import(specifier)) as Record<string, unknown>;
    if (
      module.ObjectRegistry &&
      module.detectEngine &&
      module.generateDDLForEngine
    ) {
      return module as unknown as SmrtCoreSchemaModule;
    }
  } catch {
    // Fall through to the monorepo source fallback below.
  }

  try {
    const fallbackHref = new URL('../../core/src/index.ts', import.meta.url)
      .href;
    return await importWorkspaceSourceModule<SmrtCoreSchemaModule>(
      fallbackHref,
    );
  } catch {
    throw new Error('Unable to load smrt-core schema helpers');
  }
}

async function loadSmrtTableCacheModule(): Promise<{
  resetVerifiedTables?: () => void;
}> {
  try {
    const tableCacheSpecifier = '@happyvertical/smrt-core/table-cache';
    const module = (await import(
      /* @vite-ignore */ tableCacheSpecifier
    )) as Record<string, unknown>;
    if (typeof module.resetVerifiedTables === 'function') {
      return module as { resetVerifiedTables?: () => void };
    }
  } catch {
    // Fall through to the monorepo source fallback below.
  }

  try {
    const fallbackHref = new URL(
      '../../core/src/table-cache.ts',
      import.meta.url,
    ).href;
    return await importWorkspaceSourceModule(fallbackHref);
  } catch {
    // Fall through to the legacy full-core import for older smrt-core versions.
  }

  try {
    // Legacy full-core modules may expose resetVerifiedTables directly; narrow
    // to the table-cache slice since SmrtCoreSchemaModule does not model it.
    const legacyCore = (await loadSmrtCoreModule()) as unknown as {
      resetVerifiedTables?: () => void;
    };
    return legacyCore;
  } catch {
    return {};
  }
}

function normalizeSchemaStatement(statement: string): string {
  const trimmed = statement.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function buildSchemaSqlBatches(
  smrtCore: SmrtCoreSchemaModule,
  db: { url?: string; exportTable?: unknown },
  options: VitestDatabaseOptions,
): string[] {
  const dbConfig =
    options && typeof options === 'object' && !('query' in options)
      ? (options as { type?: string; url?: string })
      : {};
  const engine =
    typeof db.exportTable === 'function'
      ? 'json'
      : smrtCore.detectEngine(
          dbConfig.url || db.url || ':memory:',
          dbConfig.type,
        );

  return Object.values(
    smrtCore.ObjectRegistry.getAllSchemasAsDefinitions(),
  ).map((schema) => {
    const ddl = smrtCore.generateDDLForEngine(schema, engine);
    return [
      ddl.createTable,
      ...ddl.indexes,
      ...(engine === 'duckdb' || engine === 'json' ? [] : ddl.triggers),
    ]
      .filter(Boolean)
      .map(normalizeSchemaStatement)
      .join('\n');
  });
}

vi.mock('@happyvertical/sql', async () => {
  const actual =
    await vi.importActual<typeof import('@happyvertical/sql')>(
      '@happyvertical/sql',
    );

  return {
    ...actual,
    async getDatabase(options: VitestDatabaseOptions = {}) {
      if (
        options?.__smrtSkipVitestSchemaPreparation === true ||
        process.env.SMRT_VITEST_AUTO_SCHEMA === '0'
      ) {
        return actual.getDatabase(options);
      }

      const canUseSqliteSchemaTemplate = Boolean(
        options &&
          typeof options === 'object' &&
          !('query' in options) &&
          getLocalSqliteFilePath(options as { type?: string; url?: string }),
      );
      let db: Awaited<ReturnType<typeof actual.getDatabase>> | undefined =
        canUseSqliteSchemaTemplate
          ? undefined
          : await actual.getDatabase(options);
      let schemaSqlBatches: string[] = [];

      try {
        const smrtCore = await loadSmrtCoreModule();
        if (canUseSqliteSchemaTemplate) {
          const dbConfig = options as { url?: string };
          schemaSqlBatches = buildSchemaSqlBatches(
            smrtCore,
            { url: dbConfig.url },
            options,
          );
        } else {
          db ??= await actual.getDatabase(options);
          schemaSqlBatches = buildSchemaSqlBatches(
            smrtCore,
            db as { url?: string; exportTable?: unknown },
            options,
          );
        }
      } catch {
        const fallbackDb = db ?? (await actual.getDatabase(options));
        await applySqliteSpeedPragmas(fallbackDb, options);
        return fallbackDb;
      }

      const schemaSql = schemaSqlBatches.filter(Boolean).join('\n-- smrt --\n');
      if (!schemaSql) {
        const bareDb = db ?? (await actual.getDatabase(options));
        await applySqliteSpeedPragmas(bareDb, options);
        return bareDb;
      }

      if (db && preparedSchemasByDb.get(db as object) === schemaSql) {
        await applySqliteSpeedPragmas(db, options);
        return db;
      }

      const preparationKey = getSchemaPreparationKey(options);
      if (
        preparationKey &&
        preparedSchemasByConfig.get(preparationKey) === schemaSql
      ) {
        db ??= await actual.getDatabase(options);
        preparedSchemasByDb.set(db as object, schemaSql);
        await applySqliteSpeedPragmas(db, options);
        return db;
      }

      const prepareSchema = async (
        database: Awaited<ReturnType<typeof actual.getDatabase>>,
      ): Promise<void> => {
        await applySqliteSpeedPragmas(database, options);
        for (const schemaBatch of schemaSqlBatches) {
          if (!schemaBatch) {
            continue;
          }
          await actual.syncSchema({ db: database, schema: schemaBatch });
        }
      };

      if (canUseSqliteSchemaTemplate) {
        db = await getDatabaseFromSqliteSchemaTemplate({
          cacheKey: `automatic-schema\0${schemaSql}`,
          databaseOptions: options as Record<string, unknown> & {
            url?: string;
          },
          getDatabase: (databaseOptions) =>
            actual.getDatabase(databaseOptions as VitestDatabaseOptions),
          prepare: prepareSchema,
        });
      } else {
        db ??= await actual.getDatabase(options);
        await prepareSchema(db);
      }

      preparedSchemasByDb.set(db as object, schemaSql);
      if (preparationKey) {
        preparedSchemasByConfig.set(preparationKey, schemaSql);
      }

      // Template-cloned databases arrive on a fresh connection that never
      // passed through prepareSchema, so the pragmas are (re)applied here;
      // the WeakSet makes this a no-op for connections already configured.
      await applySqliteSpeedPragmas(db, options);
      return db;
    },
  };
});

// Snapshot original state before tests
let originalManifestCache: CacheState;
let originalLocalTest: CacheState;

beforeAll(() => {
  // Capture original state using type-safe accessors
  const g = globalThis as Record<string, CacheState>;
  originalManifestCache = g.__smrtManifestCache;
  originalLocalTest = g.__smrtManifestLocalTest;
});

afterAll(async () => {
  // Restore original state to prevent cross-file pollution
  const g = globalThis as Record<string, CacheState>;
  g.__smrtManifestCache = originalManifestCache;
  g.__smrtManifestLocalTest = originalLocalTest;

  // Reset table existence cache to prevent cross-file contamination (issue #970)
  // Dynamic import to avoid hard dependency on smrt-core from vitest package
  try {
    const { resetVerifiedTables } = await loadSmrtTableCacheModule();
    resetVerifiedTables?.();
  } catch {
    // smrt-core may not be available in all test environments
  }
});
