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
import type { SmrtVitestPluginOptions } from './index.js';
import {
  applySqliteSpeedPragmas,
  getDatabaseFromSqliteSchemaTemplate,
  getLocalSqliteFilePath,
} from './sqlite-schema-template.js';

/**
 * `SMRT_VITEST_SETUP_OPTIONS_ENV_KEY` mirrored from `./index.ts` (kept as a
 * plain string literal, not a static import — see the note on
 * {@link ensureManifestsRegisteredInThisProcess} for why this file avoids a
 * static, module-load-time import of `./index.js`).
 */
const SETUP_OPTIONS_ENV_KEY = '__SMRT_VITEST_SETUP_OPTIONS__';

declare global {
  // eslint-disable-next-line no-var
  var __smrtVitestSetupRegisteredClassNames: string[] | undefined;
  // eslint-disable-next-line no-var
  var __smrtVitestSetupResolvedOptions:
    | SmrtVitestPluginOptions
    | null
    | undefined;
}

/**
 * Re-run `smrtVitestPlugin()`'s manifest registration inside THIS worker
 * process (#2750). `configResolved()`/`config()` in `./index.ts` only ever
 * run in Vitest's main/orchestrator process; `ObjectRegistry` is a
 * `globalThis` singleton, which is not shared across the OS
 * processes/worker threads that actually execute test files. Without this,
 * test code sees an empty registry even though the plugin logged classes as
 * loaded.
 *
 * Self-healing rather than register-once: guarded by a `globalThis` list of
 * the qualified class names this function itself registered last time, not
 * a plain boolean. `ObjectRegistry` is a `globalThis` singleton that
 * persists across test files within one worker process (the same
 * assumption this file's own `beforeAll`/`afterAll` already rely on for
 * `__smrtManifestCache`), and any test file may call
 * `ObjectRegistry.clear()` — several plugin-consuming packages' suites do.
 * A plain "registered once" flag would then leave every later test file in
 * that worker silently back at the pre-#2750 empty-registry state for
 * manifest-only classes (the ones never imported directly, so no decorator
 * re-registers them on the next file's fresh module graph). Re-checking
 * `hasClass()` for the previously-registered set on every `beforeAll` and
 * only skipping when they are all still present keeps the common case
 * (nothing cleared) cheap while self-healing after a `clear()`.
 *
 * Run from a `beforeAll` hook rather than a module-top-level `await`: a
 * top-level `await` in a `setupFiles` entry changes how Vitest sequences
 * module loading and shifted the async call-stack frames
 * `getSourceFileFromStack()` (`packages/core/src/registry/shared-state.ts`)
 * relies on to attribute a `@smrt()` class to its declaring package —
 * observed as spurious `@vitest/runner:<Class>` qualified names in core's
 * own test suite. `beforeAll` still runs before every test in the file (and
 * before the mocked `getDatabase()` is first exercised), without disturbing
 * module-load-time stack shape.
 *
 * `setupSmrtManifests`/`ObjectRegistry` are loaded with a dynamic
 * `import('./index.js')` / `loadSmrtCoreModule()` here, not a static
 * top-level import, for the same reason: `./index.ts` is the full
 * Vite-plugin module (workspace aliasing, manifest generation, the
 * `configResolved` hook, ~1300 lines with its own transitive import graph).
 * A *static* import of it from this setup file was enough on its own to
 * reproduce the exact same stack-attribution corruption in `smrt-core`'s own
 * suite (`sti-registry.test.ts`, `transform-json-hook.test.ts` —
 * `@vitest/runner:<Class>` instead of `@happyvertical/smrt-core:<Class>`)
 * even with registration itself moved into `beforeAll` — confirmed by A/B
 * testing against this exact base commit with only that one import changed.
 * Deferring the import to inside this already-lazy, already-`beforeAll`-gated
 * function keeps this file's *static* import graph identical to its
 * pre-#2750 shape; every other lazy loader in this file
 * (`loadSmrtCoreModule`, `loadSmrtTableCacheModule`) follows the same
 * dynamic-import pattern for the same class of reason.
 */
async function ensureManifestsRegisteredInThisProcess(): Promise<void> {
  const raw = process.env[SETUP_OPTIONS_ENV_KEY];
  if (!raw) {
    return;
  }

  try {
    // Resolve (and cache on `globalThis`) this worker's matching options
    // exactly once per process: `import('./index.js')` -- needed here only
    // for `normalizeRootKey` -- is the ~1300-line Vite-plugin module with
    // its own transitive graph, and under `isolate: true` this function
    // re-runs fresh on every test file. Re-importing it every file (even on
    // the eventual no-op path) reintroduced per-file overhead and widened
    // exposure to the exact class of module this file otherwise avoids a
    // *static* import of (see the doc comment above). `undefined` means
    // "not resolved yet"; `null` means "resolved, no match for this cwd" --
    // both distinct from a real options object so a legitimate empty-ish
    // options value is never mistaken for "not yet checked".
    let options = globalThis.__smrtVitestSetupResolvedOptions;
    if (options === undefined) {
      const byRoot = JSON.parse(raw) as Record<string, SmrtVitestPluginOptions>;
      // The plugin's `config()` keys its entry by its resolved, normalized
      // `root` (default `process.cwd()` at the time it ran, in the same
      // project). This worker's own `process.cwd()` is that same project's
      // directory in the standard case, so match on that alone (also
      // normalized the same way) -- deliberately NOT falling back to "the
      // map's one entry" when there is no exact match: this module's
      // setupFiles-standalone mode (no `smrtVitestPlugin()` in `plugins`)
      // promises to be a no-op when there is nothing to register for THIS
      // project, and a same-process, unrelated project's entry (e.g. a
      // Vitest multi-project run mixing a plugin-using project with a
      // plugin-less one) is not this project's options. A consumer passing
      // a custom non-default `root` to the plugin simply gets no
      // registration here (matching the pre-#2750 behavior for that
      // project) rather than risking cross-project registry contamination.
      const { normalizeRootKey } = await import('./index.js');
      options = byRoot[normalizeRootKey(process.cwd())] ?? null;
      globalThis.__smrtVitestSetupResolvedOptions = options;
    }
    if (!options) {
      return;
    }

    const { ObjectRegistry } = await loadSmrtCoreModule();
    const previouslyRegistered =
      globalThis.__smrtVitestSetupRegisteredClassNames;
    if (previouslyRegistered?.every((name) => ObjectRegistry.hasClass(name))) {
      return;
    }

    const { setupSmrtManifests } = await import('./index.js');
    await setupSmrtManifests(options);
    globalThis.__smrtVitestSetupRegisteredClassNames =
      ObjectRegistry.getQualifiedClassNames();
  } catch (error) {
    console.warn(
      '[smrt-vitest] setup: failed to register manifests in this test process:',
      error,
    );
  }
}

beforeAll(async () => {
  await ensureManifestsRegisteredInThisProcess();
});

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
    hasClass(name: string): boolean;
    getQualifiedClassNames(): string[];
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
// applySqliteSpeedPragmas (#2221) lives in sqlite-schema-template.ts so the
// isolated test-db factories can share it without importing this setup
// file's vi.mock/beforeAll side effects.

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

  return Object.values(smrtCore.ObjectRegistry.getAllSchemasAsDefinitions())
    .map((schema) => {
      // Generate DDL per-schema, in isolation: `ObjectRegistry` in this
      // process now holds every manifest-registered class from every
      // discovered smrt package (#2750's worker-side re-registration fix),
      // not just the classes this particular test file happens to import.
      // A handful of those classes are legitimately incompatible with a
      // given engine by design (e.g. a cross-package foreign key using
      // `ON DELETE CASCADE`, which DuckDB's strategy deliberately rejects —
      // see `duckdb-strategy.ts`) and `generateDDLForEngine` throws for
      // them. Before the worker-side fix, those unrelated classes were
      // simply never registered in this process, so the throw never
      // happened. Letting one such throw escape here aborts
      // `Promise.all`/`.map` for the WHOLE batch, silently skipping table
      // creation even for the class this test actually needs — reproduced
      // for `packages/events` (`EventType`/`event_types`) via an unrelated
      // `EventAsset` FK, and for `packages/analytics`
      // (`AnalyticsProperty`/`analytics_properties`) the same way. Catch and
      // skip only the offending schema so every other registered class,
      // including the one under test, still gets its table.
      try {
        const ddl = smrtCore.generateDDLForEngine(schema, engine);
        return [
          ddl.createTable,
          ...ddl.indexes,
          ...(engine === 'duckdb' || engine === 'json' ? [] : ddl.triggers),
        ]
          .filter(Boolean)
          .map(normalizeSchemaStatement)
          .join('\n');
      } catch (error) {
        warnOnceForSchemaDdlFailure(schema.tableName, engine, error);
        return '';
      }
    })
    .filter(Boolean);
}

/**
 * De-duplicates the per-schema DDL-generation warning from
 * {@link buildSchemaSqlBatches} across repeated `getDatabase()` calls in one
 * worker process (every `beforeEach` in a JSON/DuckDB-backed test file can
 * trigger it again for the same offending table) so it is reported once,
 * not once per test.
 */
const warnedSchemaDdlFailures = new Set<string>();

function warnOnceForSchemaDdlFailure(
  tableName: string,
  engine: string,
  error: unknown,
): void {
  const key = `${engine}:${tableName}`;
  if (warnedSchemaDdlFailures.has(key)) {
    return;
  }
  warnedSchemaDdlFailures.add(key);
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[smrt-vitest] setup: skipping automatic schema creation for table ` +
      `'${tableName}' on engine '${engine}' -- ${message}`,
  );
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
