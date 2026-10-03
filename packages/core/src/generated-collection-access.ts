/**
 * Collection access for generated SvelteKit routes (#3416).
 *
 * The `smrt()` Vite plugin generates `<configPath>/smrt-collections.ts`, which
 * imports the generated registration module and the application's server
 * config module (`smrt.ts` by default) and hands that module to
 * {@link createGeneratedCollectionAccess}. Generated `/api/*` routes import
 * `getCollection`/`getSmrtConfig` from the generated module, so the
 * application no longer hand-writes them.
 *
 * Resolution happens on every call and nothing is cached here: under
 * `database-rls` isolation the runtime's collection options carry the
 * request's transaction-bound database, which must never outlive the request.
 */

import { createLogger } from '@happyvertical/logger';
import type { SmrtClassOptions } from './class';
import type { SmrtCollection } from './collection';
import type { SmrtObject } from './object';

/** The part of an application runtime that generated routes need. */
export interface GeneratedCollectionRuntime {
  /** A collection built from the per-request class options. */
  getCollection<T extends SmrtObject = SmrtObject>(
    className: string,
  ): Promise<SmrtCollection<T>>;
  /** Per-request collection options (RLS transaction inside a request). */
  classOptions(className: string): SmrtClassOptions;
}

/** Accessors exported by the generated route-access module. */
export interface GeneratedCollectionAccess {
  getCollection<T extends SmrtObject = SmrtObject>(
    className: string,
  ): Promise<SmrtCollection<T>>;
  getSmrtConfig(className: string): SmrtClassOptions;
}

type LegacyGetCollection = <T extends SmrtObject = SmrtObject>(
  className: string,
) => Promise<SmrtCollection<T>>;
type LegacyGetSmrtConfig = (className: string) => SmrtClassOptions;

const logger = createLogger({ level: 'info' });
const warnedSources = new Set<string>();

function warnLegacyExport(source: string, name: string): void {
  if (warnedSources.has(source)) return;
  warnedSources.add(source);
  logger.warn(
    `[smrt] Deprecated: generated routes are calling ${name}() exported by ` +
      `${source}. Export the application runtime instead ` +
      '(`export const runtime = createSmrtSvelteKitRuntime({ ... })` from ' +
      '`@happyvertical/smrt-app-runtime/sveltekit`) and delete the ' +
      'getCollection()/getSmrtConfig() exports: generated routes then use ' +
      '`runtime.getCollection()`, which resolves the request-scoped database ' +
      'on every call. The exported helpers stop being honoured after the next ' +
      'release.',
  );
}

function runtimeOf(
  module: Record<string, unknown>,
): GeneratedCollectionRuntime | undefined {
  const runtime = module.runtime as
    | Partial<GeneratedCollectionRuntime>
    | null
    | undefined;
  if (
    runtime &&
    typeof runtime.getCollection === 'function' &&
    typeof runtime.classOptions === 'function'
  ) {
    return runtime as GeneratedCollectionRuntime;
  }
  return undefined;
}

function missingAccessor(source: string): Error {
  return new Error(
    `[smrt] Generated routes cannot resolve collections: ${source} must ` +
      'export `runtime` created by createSmrtSvelteKitRuntime() from ' +
      '`@happyvertical/smrt-app-runtime/sveltekit`.',
  );
}

/**
 * Build the accessors exported by the generated route-access module.
 *
 * - A `getCollection`/`getSmrtConfig` function exported by the application
 *   module is honoured first (deprecated, warned once per module).
 * - Otherwise the exported `runtime`'s `getCollection()`/`classOptions()` is
 *   used.
 * - A module exporting neither fails the call with an error naming the module.
 *
 * @param applicationModule - namespace of the application's server config module
 * @param source - project-relative path of that module, for messages
 */
export function createGeneratedCollectionAccess(
  applicationModule: unknown,
  source: string,
): GeneratedCollectionAccess {
  const module = (applicationModule ?? {}) as Record<string, unknown>;
  return {
    getCollection<T extends SmrtObject = SmrtObject>(
      className: string,
    ): Promise<SmrtCollection<T>> {
      const legacy = module.getCollection;
      if (typeof legacy === 'function') {
        warnLegacyExport(source, 'getCollection');
        return (legacy as LegacyGetCollection)<T>(className);
      }
      const runtime = runtimeOf(module);
      if (!runtime) return Promise.reject(missingAccessor(source));
      return runtime.getCollection<T>(className);
    },
    getSmrtConfig(className: string): SmrtClassOptions {
      const legacy = module.getSmrtConfig;
      if (typeof legacy === 'function') {
        warnLegacyExport(source, 'getSmrtConfig');
        return (legacy as LegacyGetSmrtConfig)(className);
      }
      const runtime = runtimeOf(module);
      if (!runtime) throw missingAccessor(source);
      return runtime.classOptions(className);
    },
  };
}
