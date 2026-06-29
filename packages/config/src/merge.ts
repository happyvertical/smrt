import type { SmrtConfig } from './types.js';

declare global {
  // eslint-disable-next-line no-var
  var __smrtRuntimeConfig: Partial<SmrtConfig> | undefined;
}

// Runtime config overrides
globalThis.__smrtRuntimeConfig ??= {};

// Keys that must never be written when merging untrusted / DB-exported config,
// to avoid prototype pollution.
const UNSAFE_KEYS = new Set<string>(['__proto__', 'constructor', 'prototype']);

/**
 * True only for plain config maps (prototype is `Object.prototype` or `null`),
 * not arrays, `Date`/`RegExp`, or class instances.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Recursively clone arrays and plain objects so the result shares no mutable
 * container with its input (#1579). Non-plain leaves — primitives, and crucially
 * **functions / class instances** — are passed through by reference: config
 * sections are typed `Record<string, unknown>` and may legitimately hold
 * callbacks, which are neither structured-cloneable nor the mutable containers
 * the aliasing guarantee targets.
 */
function deepClone<V>(value: V): V {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as V;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) {
        continue;
      }
      out[key] = deepClone(value[key]);
    }
    return out as V;
  }
  return value;
}

/**
 * Deep-merge two plain objects, with `source` values taking precedence over
 * `target` values at each key level.
 *
 * Rules:
 * - Both values are plain objects → recurse.
 * - `source` value is `null` or `undefined` → keep the `target` value.
 * - Otherwise → `source` value replaces `target` value (including `false`, `0`, `''`).
 *
 * The returned object owns all of its data: arrays and plain objects from both
 * inputs are deep-cloned, so mutating an input later can't leak into the result
 * (or the global runtime store via {@link setConfig}) and vice versa (#1579).
 * Each value is cloned exactly once — carried-over target keys and overriding
 * source leaves are cloned here, and shared object keys are produced by the
 * recursive call rather than re-cloned.
 *
 * @param target - Base object (lower priority).
 * @param source - Override object (higher priority).
 * @returns A new merged object.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  // Typed as Record<string, unknown> (not the generic T) so the own-key writes
  // below are well-typed — indexing a generic T for *write* is a TS2862 error.
  const result: Record<string, unknown> = {};
  const tgt = target as Record<string, unknown>;
  const src = source as Record<string, unknown>;

  // Carry over target-only keys, cloned so the result never aliases `target`.
  for (const key of Object.keys(tgt)) {
    if (UNSAFE_KEYS.has(key) || key in src) {
      continue;
    }
    result[key] = deepClone(tgt[key]);
  }

  for (const key of Object.keys(src)) {
    if (UNSAFE_KEYS.has(key)) {
      continue;
    }
    const sourceValue = src[key];
    const targetValue = tgt[key];

    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      // Recurse — the child call returns a fully-owned object (no re-clone).
      result[key] = deepMerge(targetValue, sourceValue);
    } else if (sourceValue !== undefined && sourceValue !== null) {
      // `source` wins — clone its (possibly nested) value so we don't alias it.
      result[key] = deepClone(sourceValue);
    } else if (targetValue !== undefined) {
      // `source` is null/undefined — keep the (cloned) target value.
      result[key] = deepClone(targetValue);
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
