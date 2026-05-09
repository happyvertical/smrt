/**
 * @happyvertical/smrt-languages
 *
 * Code-first language strings with config + tenant overrides and AI-driven
 * auto-translation for SMRT applications. Mirrors the architecture of
 * `@happyvertical/smrt-prompts` plus a smrt-jobs handler that fills gaps in
 * non-default locales the first time a string is requested.
 *
 * The package root intentionally exposes only the read path
 * (`defineLanguageString`, `resolveLanguageString`, `LanguageOverride`, the
 * cache helpers, glossary helpers, and shared types/utilities). The
 * translation-worker stack — which depends on `@happyvertical/ai`,
 * smrt-jobs, smrt-features, and smrt-prompts — lives on the
 * `@happyvertical/smrt-languages/jobs` subpath, and the admin CLI helpers
 * live on `@happyvertical/smrt-languages/cli`. Resolver consumers (the vast
 * majority of call sites) never load the worker dependency tree.
 *
 * @packageDocumentation
 */

import './__smrt-register__.js';

export {
  clearLanguageCache,
  getLanguageCacheTtlMs,
  invalidateLanguageCache,
} from './cache.js';
export { LanguageOverrideCollection } from './collections/LanguageOverrideCollection.js';
export { buildTenantGlossary } from './glossary.js';

export {
  defineLanguageString,
  LanguageRegistry,
} from './language-registry.js';

export {
  invalidateResolvedLanguageCache,
  resolveLanguageString,
} from './language-resolver.js';

export {
  LanguageOverride,
  type LanguageOverrideCtorOptions,
} from './models/LanguageOverride.js';

export type {
  LanguageCacheValue,
  LanguageOverrideOptions,
  LanguageStringDefinition,
  LanguageStringDefinitionInput,
  LanguagesPackageConfig,
  LanguageVariables,
  ResolvedLanguageString,
  ResolveLanguageStringOptions,
} from './types.js';

export {
  buildLocaleFallbackChain,
  buildTranslationJobId,
  computeSourceHash,
  normalizeLocale,
  renderTemplate,
} from './utils.js';

/** @internal */
export const PACKAGE_VERSION_INITIALIZED = true;
