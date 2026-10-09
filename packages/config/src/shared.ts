import {
  type ResolveAIProviderOptions,
  type ResolvedAIProviderConfig,
  resolveAIProviderConfig,
  tryResolveAIProviderConfig,
} from './ai.js';
import {
  type ResolvedCliDatabase,
  resolveCliDatabase,
} from './database-environment.js';
import { getLoadedConfig, setLoadedConfig } from './loaded-config.js';
import { clearConfigCache } from './loader-state.js';
import {
  setConfig as _setConfig,
  clearRuntimeConfig,
  getRuntimeConfig,
  mergeConfigs,
} from './merge.js';
import {
  RuntimeProfileValidationError as _RuntimeProfileValidationError,
  resolveApplicationRuntime as _resolveApplicationRuntime,
  validateApplicationRuntimeConfigShape as _validateApplicationRuntimeConfigShape,
  type ApplicationRuntimeConfig,
  type ResolvedApplicationRuntime,
} from './runtime-profile.js';
import type { AIConfigBlock, SmrtConfig } from './types.js';

// Re-export AI provider resolution
export {
  AI_PROVIDER_KEY_ENV,
  type AIConfigField,
  type AIConfigSource,
  type AIExplicitConfig,
  type AIProviderClientOptions,
  AIProviderNotConfiguredError,
  canonicalizeAIConfig,
  DEFAULT_AI_ENV_PREFIXES,
  describeAIProviderConfig,
  getDefaultAIKeyEnvName,
  mergeAIConfigObjects,
  type ResolveAIProviderOptions,
  type ResolvedAIProviderConfig,
  redactBaseUrl,
  resolveAIProviderConfig,
  toAIClientOptions,
  tryResolveAIProviderConfig,
  withAIAliases,
} from './ai.js';

// Re-export the CLI database environment fallback types
export type {
  CliDatabaseSource,
  CliDatabaseType,
  ResolvedCliDatabase,
} from './database-environment.js';

// Re-export config export utilities
export {
  type ExportConfigOptions,
  exportConfig,
  mergeExportedConfig,
  parseExportedConfig,
  sanitizeConfig,
} from './export.js';
export { clearRuntimeConfig, getRuntimeConfig, mergeConfigs } from './merge.js';
export type {
  ApplicationRuntimeConfig,
  ApplicationRuntimeProfile,
  AssetOwnership,
  AssetStorageProvider,
  AuthenticationProvider,
  BackupProvider,
  ConnectionOwnership,
  DatabaseEngine,
  JobTopology,
  NetworkExposure,
  OwnerBootstrapMode,
  ResolvedApplicationRuntime,
  RuntimeAssetProvider,
  RuntimeAuthenticationProvider,
  RuntimeCapabilities,
  RuntimeDatabaseProvider,
  RuntimeInvariants,
  RuntimeJobProvider,
  RuntimeNetworkProvider,
  RuntimeOverrideReport,
  RuntimePortabilityProvider,
  RuntimeProfileValidationIssue,
  RuntimeProviderOverrides,
  RuntimeProviders,
  RuntimeSecretProvider,
  RuntimeTenancyProvider,
  SecretOwnership,
  SecretProvider,
  TenancyMode,
  TenantContextMode,
  TenantIsolation,
} from './runtime-profile.js';
export {
  getApplicationRuntimePreset,
  RuntimeProfileValidationError,
  resolveApplicationRuntime,
} from './runtime-profile.js';

// Re-export types
export type {
  AIConfigBlock,
  // CLI and migrations configuration types
  CliConfig,
  DatabaseConfig,
  // Export configuration types
  ExportConfig,
  ExportFileConfig,
  ExportFilterValue,
  LoadConfigOptions,
  MigrationsConfig,
  MigrationsPostgresConfig,
  PostgresPermissionsConfig,
  SchemaContractConfig,
  // Site configuration types
  SiteConfig,
  SiteLocation,
  SiteNavigation,
  SiteNavigationLink,
  SitePublisher,
  SiteTheme,
  SmrtConfig,
  SmrtGlobalConfig,
} from './types.js';

/**
 * Return the loaded file configuration synchronously.
 *
 * Reads from `globalThis.__smrtConfigCache` without triggering a file search.
 * Returns `null` when {@link loadConfig} has not been called yet (or after
 * {@link clearCache} resets the cache).
 *
 * @returns The cached {@link SmrtConfig}, or `null` if not yet loaded.
 *
 * @example
 * ```ts
 * const config = getConfig();
 * if (config?.smrt?.logLevel === 'debug') {
 *   console.log('Debug logging enabled');
 * }
 * ```
 *
 * @see {@link loadConfig}
 * @see {@link resolveConfiguredApplicationRuntime}
 * @see {@link getSiteConfig}
 * @see {@link getModuleConfig}
 */
export function getConfig(): SmrtConfig | null {
  return getLoadedConfig();
}

/**
 * Resolve the effective application runtime using the documented config
 * priority: runtime overrides set by {@link setConfig} > loaded file config >
 * profile defaults.
 *
 * This accessor is intentionally separate from {@link getConfig}, whose legacy
 * contract returns the loaded file object only. When a runtime override selects
 * a different profile, lower-priority provider overrides are discarded so they
 * cannot leak profile-specific choices (for example local files or inline jobs)
 * into the new profile. Provider overrides still deep-merge when the profile is
 * unchanged.
 *
 * @returns A validated, deterministic, secret-free runtime snapshot.
 * @throws {RuntimeProfileValidationError} When no profile is configured or the
 * effective provider composition violates a profile invariant.
 */
export function resolveConfiguredApplicationRuntime(): Readonly<ResolvedApplicationRuntime> {
  return resolveRuntimeLayers(getLoadedConfig());
}

/**
 * Resolve the runtime an application actually runs with, from its loaded
 * file config plus {@link setConfig} runtime overrides.
 *
 * The one rule `smrt app` and the SvelteKit runtime share (#3446): when
 * neither layer declares a `runtime` block — the property is absent, or
 * explicitly `undefined` — the application runs the `local` profile.
 * Otherwise this is {@link resolveConfiguredApplicationRuntime}, so a present
 * value that is not a runtime block (`null`, `false`, `0`, `''`, a string, an
 * array) fails closed with the same {@link RuntimeProfileValidationError}
 * instead of silently selecting `local`.
 *
 * @param config - The file configuration returned by {@link loadConfig};
 * `null`/`undefined` means no file configuration.
 * @returns A validated, deterministic, secret-free runtime snapshot.
 * @throws {RuntimeProfileValidationError} When a declared runtime block is not
 * an object or violates a profile invariant.
 *
 * @example
 * ```ts
 * const runtime = resolveEffectiveApplicationRuntime(await loadConfig());
 * ```
 */
export function resolveEffectiveApplicationRuntime(
  config: SmrtConfig | null | undefined,
): Readonly<ResolvedApplicationRuntime> {
  if (
    !declaresRuntime(config ?? null) &&
    !declaresRuntime(getRuntimeConfig())
  ) {
    return _resolveApplicationRuntime({ profile: 'local' });
  }
  return resolveRuntimeLayers(config ?? null);
}

/** An own `runtime` property whose value is anything but `undefined`. */
function declaresRuntime(layer: Partial<SmrtConfig> | null): boolean {
  return (
    layer !== null &&
    Object.hasOwn(layer, 'runtime') &&
    layer.runtime !== undefined
  );
}

function resolveRuntimeLayers(
  loadedConfig: SmrtConfig | null,
): Readonly<ResolvedApplicationRuntime> {
  const runtimeConfig = getRuntimeConfig();
  const fileRuntime = (
    loadedConfig && Object.hasOwn(loadedConfig, 'runtime')
      ? loadedConfig.runtime
      : undefined
  ) as (ApplicationRuntimeConfig & Record<string, unknown>) | undefined;
  const runtimeOverride = (
    Object.hasOwn(runtimeConfig, 'runtime') ? runtimeConfig.runtime : undefined
  ) as
    | (Partial<ApplicationRuntimeConfig> & Record<string, unknown>)
    | undefined;

  for (const layer of [fileRuntime, runtimeOverride]) {
    if (layer === undefined) continue;
    const shapeIssues = _validateApplicationRuntimeConfigShape(layer);
    if (shapeIssues.length > 0) {
      throw new _RuntimeProfileValidationError([...shapeIssues]);
    }
  }

  const fileHasProfile =
    fileRuntime !== undefined && Object.hasOwn(fileRuntime, 'profile');
  const runtimeSelectsProfile =
    runtimeOverride !== undefined && Object.hasOwn(runtimeOverride, 'profile');
  const profileChanged =
    runtimeSelectsProfile &&
    runtimeOverride.profile !==
      (fileHasProfile ? fileRuntime.profile : undefined);

  // A profile switch intentionally resets provider selectors from the lower
  // priority profile, but it must not make invalid file configuration vanish.
  // Validate that layer before removing its profile-specific providers, then
  // preserve every root field so the effective resolver remains fail-closed.
  if (profileChanged && fileHasProfile) {
    _resolveApplicationRuntime(fileRuntime as ApplicationRuntimeConfig);
  }
  const fileRuntimeWithoutProviders = { ...(fileRuntime ?? {}) };
  delete fileRuntimeWithoutProviders.providers;

  const effective = mergeConfigs<Record<string, unknown>>(
    {},
    profileChanged ? fileRuntimeWithoutProviders : (fileRuntime ?? {}),
    runtimeOverride ?? {},
  );

  return _resolveApplicationRuntime(
    effective as unknown as ApplicationRuntimeConfig,
  );
}

/**
 * Return the `site` section of the loaded configuration.
 *
 * Equivalent to `getConfig()?.site ?? null`. Returns `null` both when no
 * config has been loaded and when the loaded config has no `site` key.
 *
 * @returns The {@link SiteConfig} object, or `null` if not defined.
 *
 * @example
 * ```ts
 * const site = getSiteConfig();
 * const title = site?.name ?? 'Untitled Site';
 * ```
 *
 * @see {@link SiteConfig}
 * @see {@link getConfig}
 */
export function getSiteConfig(): import('./types.js').SiteConfig | null {
  const config = getLoadedConfig() || {};
  return config.site || null;
}

/**
 * Return the resolved configuration for a named module.
 *
 * Merges four layers in ascending priority order:
 * 1. `defaults` (caller-supplied fallbacks)
 * 2. Global `smrt` section of the loaded config
 * 3. `modules[moduleName]` section of the loaded config
 * 4. Runtime `modules[moduleName]` overrides set via {@link setConfig}
 *
 * Works synchronously — call {@link loadConfig} first to populate the cache.
 * If no config has been loaded, only `defaults` are returned.
 *
 * @param moduleName - Key in `config.modules` (e.g., `'praeco'`).
 * @param defaults - Optional fallback values used when a key is absent from all
 *   higher-priority layers.
 * @returns The fully merged module config typed as `T`.
 *
 * @example
 * ```ts
 * const config = getModuleConfig('praeco', {
 *   rssLimit: 50,
 *   fetchTimeout: 10_000,
 * });
 * // config.rssLimit may be overridden by smrt.config.js or setConfig()
 * ```
 *
 * @see {@link getPackageConfig}
 * @see {@link setConfig}
 * @see {@link SmrtConfig.modules}
 */
export function getModuleConfig<T extends Record<string, unknown>>(
  moduleName: string,
  defaults?: T,
): T {
  // Ensure config is loaded (will use empty config if not loaded)
  const fileConfig = getLoadedConfig() || {};
  const runtime = getRuntimeConfig();

  // Get global smrt config
  const globalConfig = (fileConfig.smrt || {}) as Partial<T>;

  // Get module-specific config
  const moduleConfig = (fileConfig.modules?.[moduleName] || {}) as Partial<T>;

  // Get runtime module config
  const runtimeModuleConfig = (runtime.modules?.[moduleName] ||
    {}) as Partial<T>;

  // Merge: defaults < global < module < runtime
  const defaultsWithGlobal = mergeConfigs(
    defaults || ({} as T),
    globalConfig,
    {},
  );
  const withModuleConfig = mergeConfigs(defaultsWithGlobal, moduleConfig, {});
  const final = mergeConfigs(withModuleConfig, runtimeModuleConfig, {});

  return final;
}

/**
 * Resolve the database `smrt` commands and `smrt-dev-mcp` use: the declared
 * `packages.cli.database` from any config layer, else `DATABASE_URL` /
 * `DATABASE_TYPE` (#3410, #3446).
 *
 * A configured `database.url` always wins and the environment is not read.
 * Otherwise `DATABASE_URL` supplies the URL and its engine comes from the
 * config's `database.type`, else `DATABASE_TYPE`, else the URL scheme. An
 * unsupported `DATABASE_TYPE` yields `invalid-environment` instead of a guess.
 * Read-only: nothing is written to the config. Call after {@link loadConfig}.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns The source and, for `config`/`environment`, the database block.
 *
 * @example
 * ```ts
 * await loadConfig();
 * const { source, database } = resolveCliDatabaseConfig();
 * ```
 */
export function resolveCliDatabaseConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedCliDatabase {
  // No defaults: only a value some config layer actually declares counts.
  const declared = getPackageConfig<{
    database?: { url?: unknown; type?: unknown };
  }>('cli').database;
  return resolveCliDatabase(declared, env);
}

/**
 * Return the resolved configuration for a named package.
 *
 * Identical to {@link getModuleConfig} but reads from `config.packages` instead
 * of `config.modules`. Use this inside `@happyvertical/smrt-*` packages that
 * want to expose their own config section without conflicting with user-defined
 * module names.
 *
 * Merges four layers in ascending priority order:
 * 1. `defaults` (caller-supplied fallbacks)
 * 2. Global `smrt` section of the loaded config
 * 3. `packages[packageName]` section of the loaded config
 * 4. Runtime `packages[packageName]` overrides set via {@link setConfig}
 *
 * @param packageName - Key in `config.packages` (e.g., `'ai'`, `'spider'`).
 * @param defaults - Optional fallback values.
 * @returns The fully merged package config typed as `T`.
 *
 * @example
 * ```ts
 * // Inside @happyvertical/smrt-ai package
 * const config = getPackageConfig('ai', {
 *   defaultModel: 'gpt-4o-mini',
 *   maxTokens: 2048,
 * });
 * ```
 *
 * @see {@link getModuleConfig}
 * @see {@link setConfig}
 * @see {@link SmrtConfig.packages}
 */
export function getPackageConfig<T extends Record<string, unknown>>(
  packageName: string,
  defaults?: T,
): T {
  // Ensure config is loaded (will use empty config if not loaded)
  const fileConfig = getLoadedConfig() || {};
  const runtime = getRuntimeConfig();

  // Get global smrt config
  const globalConfig = (fileConfig.smrt || {}) as Partial<T>;

  // Get package-specific config
  const packageConfig = (fileConfig.packages?.[packageName] ||
    {}) as Partial<T>;

  // Get runtime package config
  const runtimePackageConfig = (runtime.packages?.[packageName] ||
    {}) as Partial<T>;

  // Merge: defaults < global < package < runtime
  const defaultsWithGlobal = mergeConfigs(
    defaults || ({} as T),
    globalConfig,
    {},
  );
  const withPackageConfig = mergeConfigs(defaultsWithGlobal, packageConfig, {});
  const final = mergeConfigs(withPackageConfig, runtimePackageConfig, {});

  return final;
}

/**
 * Apply runtime configuration overrides.
 *
 * Deep-merges `config` into an in-memory store that takes the highest priority
 * in every subsequent {@link getModuleConfig} / {@link getPackageConfig} call.
 * Successive calls accumulate. When a call explicitly changes the runtime
 * profile, the stored runtime provider subtree is reset before merging so
 * profile-specific selectors cannot leak into the new profile.
 *
 * Common uses:
 * - Inject test doubles or environment-specific values without a config file.
 * - Apply feature flags from a remote source after startup.
 *
 * @param config - Partial {@link SmrtConfig} to merge into the runtime store.
 *   `null` values are ignored (they do not clear existing keys).
 *
 * @example
 * ```ts
 * setConfig({ modules: { ai: { defaultModel: 'gpt-4o' } } });
 * ```
 *
 * @see {@link clearCache}
 * @see {@link getModuleConfig}
 */
export function setConfig(config: Partial<SmrtConfig>): void {
  _setConfig(config);
}

/**
 * Reset all cached configuration state.
 *
 * Clears three independent caches:
 * 1. `globalThis.__smrtConfigCache` — the merged config loaded by {@link loadConfig}.
 * 2. The internal loader cache (`globalThis.__smrtLoaderCachedConfig`) and the
 *    cosmiconfig explorer instance.
 * 3. The runtime override store populated by {@link setConfig}.
 *
 * After calling this, {@link getConfig} returns `null` and a fresh
 * {@link loadConfig} call will re-read from disk.
 *
 * WARNING: This is a global reset — it affects every module sharing the same
 * runtime, not just the caller. Use with care outside of test teardown.
 *
 * @example
 * ```ts
 * afterEach(() => {
 *   clearCache(); // reset between tests
 * });
 * ```
 *
 * @see {@link loadConfig}
 * @see {@link setConfig}
 */
export function clearCache(): void {
  setLoadedConfig(null);
  clearConfigCache(); // Clear loader.ts cache
  clearRuntimeConfig(); // Clear runtime config
}

/**
 * Type-safe helper for authoring `smrt.config.js` files.
 *
 * This is an identity function — it returns its argument unchanged. Its sole
 * purpose is to provide TypeScript type-checking and IDE auto-completion when
 * writing the config object literal.
 *
 * @param config - The config object to validate against {@link SmrtConfig}.
 * @returns The same object, unchanged.
 *
 * @example
 * ```js
 * // smrt.config.js
 * import { defineConfig } from '@happyvertical/smrt-config';
 *
 * export default defineConfig({
 *   smrt: { logLevel: 'info' },
 *   site: { name: 'My Site', ... },
 * });
 * ```
 *
 * @see {@link SmrtConfig}
 * @see {@link loadConfig}
 */
export function defineConfig(config: SmrtConfig): SmrtConfig {
  return config;
}

/**
 * The effective `ai` block: runtime `ai` > runtime `packages.ai` > file `ai` >
 * file `packages.ai` (`smrt init` historically wrote `packages.ai`), merged
 * field by field. Returns `null` when none is declared.
 */
export function getAIConfigBlock(): AIConfigBlock | null {
  const file = getLoadedConfig();
  const runtime = getRuntimeConfig();
  return mergeAIConfigLayers([
    file?.packages?.ai,
    file?.ai,
    runtime.packages?.ai,
    runtime.ai,
  ]);
}

/**
 * Merge `ai` block layers, lowest priority first, preserving provider
 * ownership: `apiKey`, `apiKeyEnv`, `baseUrl` and `model` belong to the
 * provider their layer names. When a higher layer names a different provider,
 * the credentials and model already collected from lower layers for another
 * provider are dropped (a model id is provider-specific, so it is dropped
 * too). A layer that names no provider contributes generic values that bind to
 * the provider selected so far.
 */
export function mergeAIConfigLayers(
  layers: ReadonlyArray<unknown>,
): AIConfigBlock | null {
  const FIELDS = ['model', 'baseUrl', 'apiKeyEnv', 'apiKey'] as const;
  let provider: string | undefined;
  const values: Partial<Record<(typeof FIELDS)[number], string>> = {};
  const owners: Partial<Record<(typeof FIELDS)[number], string | undefined>> =
    {};
  const text = (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    const rec = layer as Record<string, unknown>;
    const named = text(rec.provider) ?? text(rec.type);
    if (named && provider && named.toLowerCase() !== provider.toLowerCase()) {
      for (const f of FIELDS) {
        const owner = owners[f];
        if (owner && owner.toLowerCase() !== named.toLowerCase()) {
          delete values[f];
          delete owners[f];
        }
      }
    }
    if (named) provider = named;
    for (const f of FIELDS) {
      const v =
        f === 'model'
          ? (text(rec.model) ?? text(rec.defaultModel))
          : text(rec[f]);
      if (v) {
        values[f] = v;
        owners[f] = provider;
      }
    }
  }
  if (!provider && FIELDS.every((f) => !values[f])) return null;
  const merged: AIConfigBlock = { ...values };
  if (provider) merged.provider = provider;
  return merged;
}

/**
 * {@link resolveAIProviderConfig} against the loaded `smrt.config.ts` `ai`
 * block. Throws `AIProviderNotConfiguredError` when nothing is configured.
 */
export function resolveConfiguredAIProvider(
  options: ResolveAIProviderOptions = {},
): ResolvedAIProviderConfig {
  return resolveAIProviderConfig({
    ...options,
    config: options.config === undefined ? getAIConfigBlock() : options.config,
  });
}

/** Non-throwing variant of {@link resolveConfiguredAIProvider}. */
export function tryResolveConfiguredAIProvider(
  options: ResolveAIProviderOptions = {},
): ResolvedAIProviderConfig | undefined {
  return tryResolveAIProviderConfig({
    ...options,
    config: options.config === undefined ? getAIConfigBlock() : options.config,
  });
}
