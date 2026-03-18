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

const preparedSchemasByDb = new WeakMap<object, string>();
const preparedSchemasByConfig = new Map<string, string>();

function getSchemaPreparationKey(options: any): string | undefined {
  if (!options || typeof options !== 'object') {
    return undefined;
  }

  const dbUrl = options.url;
  if (
    !dbUrl ||
    dbUrl === ':memory:' ||
    dbUrl === 'memory' ||
    dbUrl === 'file::memory:'
  ) {
    return undefined;
  }

  return options.dbid || `${options.type || 'sqlite'}:${dbUrl}`;
}

async function loadSmrtCoreModule(): Promise<any> {
  try {
    return await import('@happyvertical/smrt-core');
  } catch {
    const fallbackHref = new URL('../../core/src/index.ts', import.meta.url)
      .href;
    return await import(/* @vite-ignore */ fallbackHref);
  }
}

vi.mock('@happyvertical/sql', async () => {
  const actual =
    await vi.importActual<typeof import('@happyvertical/sql')>(
      '@happyvertical/sql',
    );

  return {
    ...actual,
    async getDatabase(options: any) {
      if (
        options?.__smrtSkipVitestSchemaPreparation === true ||
        process.env.SMRT_VITEST_AUTO_SCHEMA === '0'
      ) {
        return actual.getDatabase(options);
      }

      const db = await actual.getDatabase(options);

      const { ObjectRegistry } = await loadSmrtCoreModule();
      const allSchemas = ObjectRegistry.getAllSchemas();
      const skipIndexes = typeof (db as any).exportTable === 'function';
      const schemaStatements = Object.values(allSchemas).flatMap(
        (schema: any) =>
          [schema.ddl, ...(skipIndexes ? [] : schema.indexes || [])].filter(
            Boolean,
          ),
      );

      if (schemaStatements.length === 0) {
        return db;
      }

      const schemaSql = schemaStatements.join('\n');
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

      await actual.syncSchema({ db, schema: schemaSql });
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
