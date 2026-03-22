import {
  getConfig,
  getRuntimeConfig,
  mergeConfigs,
} from '@happyvertical/smrt-config';

export type { SmrtGlobalConfig } from '@happyvertical/smrt-config';

export function getSmrtModuleConfig<T extends Record<string, unknown>>(
  moduleName: string,
  defaults?: T,
): T {
  const fileConfig = getConfig() || {};
  const runtimeConfig = getRuntimeConfig();

  const globalConfig = (fileConfig.smrt || {}) as Partial<T>;
  const moduleConfig = (fileConfig.modules?.[moduleName] || {}) as Partial<T>;
  const runtimeModuleConfig = (runtimeConfig.modules?.[moduleName] ||
    {}) as Partial<T>;

  const defaultsWithGlobal = mergeConfigs(
    defaults || ({} as T),
    globalConfig,
    {},
  );
  const withModuleConfig = mergeConfigs(defaultsWithGlobal, moduleConfig, {});

  return mergeConfigs(withModuleConfig, runtimeModuleConfig, {});
}
