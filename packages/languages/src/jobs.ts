/**
 * Subpath entry: `@happyvertical/smrt-languages/jobs`.
 *
 * Importing this module is what pulls in `@happyvertical/ai`, smrt-jobs,
 * smrt-features, and smrt-prompts. Keeping it off the package root means
 * consumers that only need `defineLanguageString` / `resolveLanguageString`
 * do not pay for the translation-worker stack in their bundles.
 *
 * Use this entry from background workers, CLI tools, and tests that need
 * to enqueue or run translation jobs directly.
 */
export {
  AUTO_TRANSLATE_FEATURE_KEY,
  enqueueTranslationJob,
  LanguageTranslationTask,
  TRANSLATION_PROMPT_KEY,
} from './translation-job.js';
export type { TranslationJobPayload } from './types.js';
