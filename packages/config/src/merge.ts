import type { SmrtConfig } from './types.js';

declare global {
  // eslint-disable-next-line no-var
  var __smrtRuntimeConfig: Partial<SmrtConfig> | undefined;
}

// Runtime config overrides
globalThis.__smrtRuntimeConfig ??= {};

/**
 * Deep-merge two plain objects, with `source` values taking precedence over
 * `target` values at each key level.
 *
 * Rules:
 * - Both values are non-array objects → recurse.
 * - `source` value is `null` or `undefined` → keep the `target` value.
 * - Otherwise → `source` value replaces `target` value (including `false`, `0`, `''`).
 *
 * @param target - Base object (lower priority).
 * @param source - Override object (higher priority).
 * @returns A new merged object.
 */
function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>,
): T {
  // Typed as Record<string, unknown> (not the generic T) so the own-key writes
  // below are well-typed — indexing a generic T for *write* is a TS2862 error.
  const result: Record<string, unknown> = { ...target };
  const src = source as Record<string, unknown>;

  for (const key of Object.keys(src)) {
    // Guard against prototype pollution when merging untrusted/DB-exported
    // input: never write to __proto__/constructor/prototype keys.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    const sourceValue = src[key];
    const targetValue = result[key];

    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, any>,
        sourceValue as Record<string, any>,
      );
    } else if (sourceValue !== undefined && sourceValue !== null) {
      result[key] = sourceValue;
    }
  }

  return result as T;
}

/**
 * Deep-merge `config` into the in-memory runtime override store.
 *
 * Runtime overrides take the highest priority in the merge order:
 * runtime > file config > defaults. Subsequent calls accumulate — they do not
 * replace previous overrides. Call {@link clearRuntimeConfig} to reset.
 *
 * This is the low-level setter; consumer code should call {@link setConfig}
 * from `index.ts` which delegates here.
 *
 * @param config - Partial config to merge into the runtime store.
 *
 * @see {@link clearRuntimeConfig}
 * @see {@link getRuntimeConfig}
 */
export function setConfig(config: Partial<SmrtConfig>): void {
  globalThis.__smrtRuntimeConfig = deepMerge(
    globalThis.__smrtRuntimeConfig || {},
    config,
  );
}

/**
 * Return the current runtime configuration override store.
 *
 * Used internally by {@link getModuleConfig} and {@link getPackageConfig} to
 * layer runtime overrides on top of file-based config. Prefer those helpers
 * for reading config; this is a low-level accessor.
 *
 * @returns The accumulated runtime config partial.
 */
export function getRuntimeConfig(): Partial<SmrtConfig> {
  return globalThis.__smrtRuntimeConfig || {};
}

/**
 * Reset the runtime configuration override store to an empty object.
 *
 * Called by {@link clearCache} in `index.ts` as part of a full cache reset.
 * Useful in tests to ensure a clean state between cases.
 *
 * @see {@link setConfig}
 */
export function clearRuntimeConfig(): void {
  globalThis.__smrtRuntimeConfig = {};
}

/**
 * Merge three config layers in ascending priority order.
 *
 * Priority (highest to lowest):
 * 1. `runtime` — runtime overrides set via {@link setConfig}
 * 2. `fileConfig` — values loaded from `smrt.config.js`
 * 3. `defaults` — caller-supplied fallback values
 *
 * Uses {@link deepMerge} internally, so `null` / `undefined` source values
 * never overwrite existing target values.
 *
 * @param defaults - Lowest-priority base values (caller defaults).
 * @param fileConfig - Mid-priority values from the loaded config file.
 * @param runtime - Highest-priority runtime override values.
 * @returns A new object with all three layers merged.
 *
 * @example
 * ```ts
 * const merged = mergeConfigs(
 *   { timeout: 5000, retries: 3 },
 *   { retries: 5 },
 *   { timeout: 1000 },
 * );
 * // => { timeout: 1000, retries: 5 }
 * ```
 */
export function mergeConfigs<T extends Record<string, unknown>>(
  defaults: T,
  fileConfig: Partial<T>,
  runtime: Partial<T>,
): T {
  let result = { ...defaults };
  result = deepMerge(result, fileConfig);
  result = deepMerge(result, runtime);
  return result;
}
