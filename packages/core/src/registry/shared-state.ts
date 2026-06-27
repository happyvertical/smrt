/**
 * Shared state accessors for the SMRT ObjectRegistry.
 *
 * All registry sub-modules share state via globalThis to ensure
 * cross-module consistency in monorepo environments.
 *
 * Extracted from registry.ts as part of issue #1006.
 * @see https://github.com/happyvertical/smrt/issues/1006
 * @see https://github.com/happyvertical/smrt/issues/543
 */

import { createLogger } from '@happyvertical/logger';
import type { SmrtCollection } from '../collection';
import {
  getSmrtModuleConfig,
  type SmrtGlobalConfig,
} from '../config/global-config.js';
import type { SmrtObject } from '../object';
import { LRUCache } from '../utils/lru-cache';
import type { RegisteredClass, SmrtObjectConstructor } from './types';

// Re-export the globalThis augmentation so it's visible everywhere
declare global {
  // eslint-disable-next-line no-var
  var __smrtRegistryClasses: Map<string, RegisteredClass> | undefined;
  // eslint-disable-next-line no-var
  var __smrtRegistryCollections: Map<string, typeof SmrtCollection> | undefined;
  // eslint-disable-next-line no-var
  // Heterogeneous cache: stores collections of many different item types keyed
  // by class name. `SmrtCollection` is invariant in its item type (it has
  // `create(options: SmrtCreateInput<ModelType>)`), so this cannot be narrowed
  // to `SmrtCollection<SmrtObject>` — the type argument stays `any` (read sites
  // cast back to the concrete collection type).
  var __smrtRegistryCollectionCache:
    | LRUCache<string, SmrtCollection<any>>
    | undefined;
  // eslint-disable-next-line no-var
  var __smrtRegistryDbInstanceIds: WeakMap<object, number> | undefined;
  // eslint-disable-next-line no-var
  var __smrtRegistryNextDbId: number | undefined;
  // eslint-disable-next-line no-var
  var __smrtRegistryInheritanceChainCache:
    | LRUCache<string, string[]>
    | undefined;
  // eslint-disable-next-line no-var
  var __smrtRegistryFieldDecorators:
    | Map<string, Map<string, Record<string, unknown>>>
    | undefined;
  // eslint-disable-next-line no-var
  var __smrtRegistryStiSiblingsLoaded: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __smrtRegistryCollectionTableNames: Map<string, string> | undefined;
  // Release B (#1133) removed __smrtRegistryClassNameMap — case-insensitive
  // lookups now iterate the `classes` Map directly. The globalThis slot is
  // left undeclared so any leftover code that reaches for it gets a clean
  // TS error instead of silently stale data.
  // eslint-disable-next-line no-var
  var __smrtRegistrySchemasInitialized: WeakSet<object> | undefined;
  // eslint-disable-next-line no-var
  var __smrtRegistryConstructorIndex:
    | WeakMap<SmrtObjectConstructor, string>
    | undefined;
  // eslint-disable-next-line no-var
  var __smrtRegistryDiscoveryAttemptCache: Map<string, boolean> | undefined;
}

/**
 * Cached verbose flag evaluated once at module load time.
 * Checks SMRT_VERBOSE=true or DEBUG containing 'smrt'.
 * Avoids repeated env var parsing on every log statement.
 * @see https://github.com/happyvertical/smrt/issues/782
 */
export const VERBOSE_ENABLED =
  process.env.SMRT_VERBOSE === 'true' ||
  (process.env.DEBUG?.includes('smrt') ?? false);

// verboseLog() is gated by VERBOSE_ENABLED, so the level must allow debug when
// it's set (a fixed 'info' would filter the trace out and break SMRT_VERBOSE).
const logger = createLogger({ level: VERBOSE_ENABLED ? 'debug' : 'info' });

/**
 * Log a message only when verbose mode is enabled.
 * Used throughout registry modules to reduce noise during normal operation.
 * @param args - Arguments to pass to console.log
 */
export function verboseLog(...args: unknown[]): void {
  if (VERBOSE_ENABLED) {
    const [message, ...rest] = args;
    logger.debug(
      typeof message === 'string' ? message : String(message),
      rest.length > 0 ? { args: rest } : undefined,
    );
  }
}

/**
 * Get inheritance config synchronously.
 * Uses the config package's sync accessor which returns already-loaded config.
 */
export function getInheritanceConfig() {
  const config = getSmrtModuleConfig<SmrtGlobalConfig>('smrt', {});
  return {
    cacheSize: config.inheritance?.cacheSize ?? 200,
    onMissingAncestor:
      config.inheritance?.onMissingAncestor ?? ('warn' as 'warn' | 'error'),
  };
}

/**
 * Extract the source file path from the call stack.
 *
 * Used to identify where a class was defined for collision detection.
 * This allows the same class to be re-registered when modules are re-evaluated
 * (e.g., during vitest test file collection with isolation enabled).
 *
 * @returns The file path where the @smrt() decorator was called, or undefined
 */
export function getSourceFileFromStack(): string | undefined {
  const error = new Error();
  const stack = error.stack || '';
  const stackLines = stack.split('\n');

  // Look for the first file path that's NOT from smrt-core internal files
  // Stack trace format: "    at FunctionName (file:///path/to/file.ts:line:col)"
  // or "    at file:///path/to/file.ts:line:col"
  for (const line of stackLines) {
    // Match file paths in stack trace (include all JS/TS file extensions)
    const fileMatch = line.match(
      /(?:file:\/\/)?([^)\s]+\.(?:js|ts|mjs|mts|jsx|tsx|cjs|cts))(?::\d+:\d+)?/,
    );
    if (fileMatch) {
      const rawPath = fileMatch[1];
      // Normalize the path:
      // - remove any leading file:// or file:/// prefix
      // - convert Windows backslashes to POSIX-style forward slashes
      const normalizedPath = rawPath
        .replace(/^file:\/+/, '')
        .replace(/\\/g, '/');
      const lowerPath = normalizedPath.toLowerCase();

      // Skip smrt-core internal files using specific path patterns
      // to avoid false positives with user files containing "registry" in name
      if (
        // Installed package form: node_modules/@happyvertical/smrt-core/...
        lowerPath.includes('/node_modules/@happyvertical/smrt-core/') ||
        // Monorepo/workspace form: packages/core/src/...
        (lowerPath.includes('/packages/core/src/') &&
          !lowerPath.includes('__tests__')) ||
        // Specific manifest loader internals
        lowerPath.includes('/manifest/manifest-loader')
      ) {
        continue;
      }
      return normalizedPath;
    }
  }
  return undefined;
}

// ── Shared state accessor functions ──────────────────────────────────────

export function getClasses(): Map<string, RegisteredClass> {
  if (!globalThis.__smrtRegistryClasses) {
    globalThis.__smrtRegistryClasses = new Map<string, RegisteredClass>();
  }
  return globalThis.__smrtRegistryClasses;
}

export function getCollections(): Map<string, typeof SmrtCollection> {
  if (!globalThis.__smrtRegistryCollections) {
    globalThis.__smrtRegistryCollections = new Map<
      string,
      typeof SmrtCollection
    >();
  }
  return globalThis.__smrtRegistryCollections;
}

export function getCollectionTableNames(): Map<string, string> {
  if (!globalThis.__smrtRegistryCollectionTableNames) {
    globalThis.__smrtRegistryCollectionTableNames = new Map<string, string>();
  }
  return globalThis.__smrtRegistryCollectionTableNames;
}

export function getCollectionCache(): LRUCache<string, SmrtCollection<any>> {
  if (!globalThis.__smrtRegistryCollectionCache) {
    globalThis.__smrtRegistryCollectionCache = new LRUCache<
      string,
      SmrtCollection<any>
    >(100);
  }
  return globalThis.__smrtRegistryCollectionCache;
}

export function getDbInstanceIds(): WeakMap<object, number> {
  if (!globalThis.__smrtRegistryDbInstanceIds) {
    globalThis.__smrtRegistryDbInstanceIds = new WeakMap<object, number>();
  }
  return globalThis.__smrtRegistryDbInstanceIds;
}

export function getNextDbId(): number {
  if (globalThis.__smrtRegistryNextDbId === undefined) {
    globalThis.__smrtRegistryNextDbId = 1;
  }
  return globalThis.__smrtRegistryNextDbId;
}

export function setNextDbId(value: number): void {
  globalThis.__smrtRegistryNextDbId = value;
}

export function getFieldDecorators(): Map<
  string,
  Map<string, Record<string, unknown>>
> {
  if (!globalThis.__smrtRegistryFieldDecorators) {
    globalThis.__smrtRegistryFieldDecorators = new Map<
      string,
      Map<string, Record<string, unknown>>
    >();
  }
  return globalThis.__smrtRegistryFieldDecorators;
}

export function getStiSiblingsLoaded(): Set<string> {
  if (!globalThis.__smrtRegistryStiSiblingsLoaded) {
    globalThis.__smrtRegistryStiSiblingsLoaded = new Set<string>();
  }
  return globalThis.__smrtRegistryStiSiblingsLoaded;
}

// getClassNameMap removed in Release B (#1133). The eagerly-maintained
// lowercase-simple-name → qualified-key[] index was replaced by on-demand
// iteration over the `classes` Map in name-resolver.ts. Any remaining
// consumer should switch to `findClassesByName`, `getCanonicalClassName`,
// or `findClass`.

export function getSchemasInitialized(): WeakSet<object> {
  if (!globalThis.__smrtRegistrySchemasInitialized) {
    globalThis.__smrtRegistrySchemasInitialized = new WeakSet<object>();
  }
  return globalThis.__smrtRegistrySchemasInitialized;
}

export function getConstructorIndex(): WeakMap<SmrtObjectConstructor, string> {
  if (!globalThis.__smrtRegistryConstructorIndex) {
    globalThis.__smrtRegistryConstructorIndex = new WeakMap<
      SmrtObjectConstructor,
      string
    >();
  }
  return globalThis.__smrtRegistryConstructorIndex;
}

export function getInheritanceCache(): LRUCache<string, string[]> {
  if (!globalThis.__smrtRegistryInheritanceChainCache) {
    const config = getInheritanceConfig();
    globalThis.__smrtRegistryInheritanceChainCache = new LRUCache<
      string,
      string[]
    >(config.cacheSize);
  }
  return globalThis.__smrtRegistryInheritanceChainCache;
}

export function getDiscoveryAttemptCache(): Map<string, boolean> {
  if (!globalThis.__smrtRegistryDiscoveryAttemptCache) {
    globalThis.__smrtRegistryDiscoveryAttemptCache = new Map<string, boolean>();
  }
  return globalThis.__smrtRegistryDiscoveryAttemptCache;
}
