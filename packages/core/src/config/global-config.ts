import type { SmrtConfig } from '@happyvertical/smrt-config';

export type { SmrtGlobalConfig } from '@happyvertical/smrt-config';

declare global {
  // eslint-disable-next-line no-var
  var __smrtConfigCache: SmrtConfig | null | undefined;
  // eslint-disable-next-line no-var
  var __smrtRuntimeConfig: Partial<SmrtConfig> | undefined;
}

function deepMerge<T extends Record<string, unknown>>(
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
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
      ) as T[Extract<keyof T, string>];
    } else if (sourceValue !== undefined && sourceValue !== null) {
      result[key] = sourceValue as T[Extract<keyof T, string>];
    }
  }

  return result;
}

export function getSmrtModuleConfig<T extends Record<string, unknown>>(
  moduleName: string,
  defaults?: T,
): T {
  const fileConfig = globalThis.__smrtConfigCache ?? {};
  const runtimeConfig = globalThis.__smrtRuntimeConfig ?? {};

  const globalConfig = (fileConfig.smrt || {}) as Partial<T>;
  const moduleConfig = (fileConfig.modules?.[moduleName] || {}) as Partial<T>;
  const runtimeModuleConfig = (runtimeConfig.modules?.[moduleName] ||
    {}) as Partial<T>;

  let result = { ...(defaults || ({} as T)) };
  result = deepMerge(result, globalConfig);
  result = deepMerge(result, moduleConfig);
  result = deepMerge(result, runtimeModuleConfig);

  return result;
}
