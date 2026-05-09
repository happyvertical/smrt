/**
 * @happyvertical/smrt-languages
 *
 * Code-first language strings with config + tenant overrides and AI-driven
 * auto-translation for SMRT applications. Mirrors the architecture of
 * `@happyvertical/smrt-prompts` plus a smrt-jobs handler that fills gaps in
 * non-default locales the first time a string is requested.
 *
 * @packageDocumentation
 */

import './__smrt-register__.js';

export {
  clearLanguageCache,
  getLanguageCacheTtlMs,
  invalidateLanguageCache,
} from './cache.js';
export {
  approveAutoTranslation,
  editLanguageOverride,
  listUnreviewedAutoTranslations,
  translateMissing,
} from './cli.js';

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

export {
  AUTO_TRANSLATE_FEATURE_KEY,
  enqueueTranslationJob,
  LanguageTranslationTask,
  TRANSLATION_PROMPT_KEY,
} from './translation-job.js';

export type {
  LanguageCacheValue,
  LanguageOverrideOptions,
  LanguageStringDefinition,
  LanguageStringDefinitionInput,
  LanguagesPackageConfig,
  LanguageVariables,
  ResolvedLanguageString,
  ResolveLanguageStringOptions,
  TranslationJobPayload,
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
