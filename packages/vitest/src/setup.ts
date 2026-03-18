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

import { afterAll, beforeAll, vi } from 'vitest';

// Type alias for any to avoid conflicts with smrt-core's globalThis declarations
type CacheState = unknown;
type VitestDatabaseOptions = Parameters<
  typeof import('@happyvertical/sql')['getDatabase']
>[0] & {
  __smrtSkipVitestSchemaPreparation?: boolean;
};

const preparedSchemasByDb = new WeakMap<object, string>();
const preparedSchemasByConfig = new Map<string, string>();

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

async function loadSmrtCoreModule(): Promise<any> {
  try {
    const module = (await import('@happyvertical/smrt-core')) as Record<
      string,
      any
    >;
    if (
      module.ObjectRegistry &&
      module.detectEngine &&
      module.generateDDLForEngine
    ) {
      return module;
    }
  } catch {
    // Fall through to the monorepo source fallback below.
  }

  try {
    const fallbackHref = new URL('../../core/src/index.ts', import.meta.url)
      .href;
    return await import(/* @vite-ignore */ fallbackHref);
  } catch {
    throw new Error('Unable to load smrt-core schema helpers');
  }
}

function normalizeSchemaStatement(statement: string): string {
  const trimmed = statement.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function buildSchemaSqlBatches(
  smrtCore: {
    ObjectRegistry: {
      getAllSchemasAsDefinitions(): Record<string, any>;
    };
    detectEngine(url: string, type?: string): string;
    generateDDLForEngine(
      schema: any,
      engine: 'sqlite' | 'duckdb' | 'postgres',
    ): {
      createTable: string;
      indexes: string[];
      triggers: string[];
    };
  },
  db: { url?: string; exportTable?: unknown },
  options: VitestDatabaseOptions,
): string[] {
  const dbConfig =
    options && typeof options === 'object' && !('query' in options)
      ? (options as { type?: string; url?: string })
      : {};
  const engine =
    typeof db.exportTable === 'function'
      ? 'duckdb'
      : (smrtCore.detectEngine(
          dbConfig.url || db.url || ':memory:',
          dbConfig.type,
        ) as 'sqlite' | 'duckdb' | 'postgres');

  return Object.values(
    smrtCore.ObjectRegistry.getAllSchemasAsDefinitions(),
  ).map((schema) => {
    const ddl = smrtCore.generateDDLForEngine(schema, engine);
    return [
      ddl.createTable,
      ...ddl.indexes,
      ...(engine === 'duckdb' ? [] : ddl.triggers),
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

      const db = await actual.getDatabase(options);
      let schemaSqlBatches: string[] = [];

      try {
        const smrtCore = await loadSmrtCoreModule();
        schemaSqlBatches = buildSchemaSqlBatches(
          smrtCore,
          db as { url?: string; exportTable?: unknown },
          options,
        );
      } catch {
        return db;
      }

      const schemaSql = schemaSqlBatches.filter(Boolean).join('\n-- smrt --\n');
      if (!schemaSql) {
        return db;
      }

      const dbObject = db as object;
      if (preparedSchemasByDb.get(dbObject) === schemaSql) {
        return db;
      }

      const preparationKey = getSchemaPreparationKey(options);
      if (
        preparationKey &&
        preparedSchemasByConfig.get(preparationKey) === schemaSql
      ) {
        preparedSchemasByDb.set(dbObject, schemaSql);
        return db;
      }

      for (const schemaBatch of schemaSqlBatches) {
        if (!schemaBatch) {
          continue;
        }
        await actual.syncSchema({ db, schema: schemaBatch });
      }
      preparedSchemasByDb.set(dbObject, schemaSql);
      if (preparationKey) {
        preparedSchemasByConfig.set(preparationKey, schemaSql);
      }

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
    const { resetVerifiedTables } = await loadSmrtCoreModule();
    resetVerifiedTables();
  } catch {
    // smrt-core may not be available in all test environments
  }
});
