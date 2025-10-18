import type { SmrtConfig } from './types.js';

// Runtime config overrides
let runtimeConfig: Partial<SmrtConfig> = {};

/**
 * Deep merge two objects
 * Later values override earlier values
 */
function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
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
      ) as T[Extract<keyof T, string>];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[Extract<keyof T, string>];
    }
  }

  return result;
}

/**
 * Set runtime configuration
 * These override file-based configs
 */
export function setConfig(config: Partial<SmrtConfig>): void {
  runtimeConfig = deepMerge(runtimeConfig, config);
}

/**
 * Get runtime configuration
 */
export function getRuntimeConfig(): Partial<SmrtConfig> {
  return runtimeConfig;
}

/**
 * Clear runtime configuration
 * Useful for testing
 */
export function clearRuntimeConfig(): void {
  runtimeConfig = {};
}

/**
 * Merge configurations with priority:
 * 1. Runtime config (highest)
 * 2. File config
 * 3. Defaults (lowest)
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
