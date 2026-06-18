/**
 * @happyvertical/smrt-svelte/i18n — client i18n layer (Sweep S13 #1418).
 *
 * Browser-safe. Provides `defineMessages` (register a package's English code
 * defaults), `useI18n()` / `<Trans>` (read + render translations), and the
 * context plumbing the `Provider` uses. The server-side snapshot builder lives
 * on the `./i18n/server` subpath (it pulls the full languages resolver).
 *
 * See `docs/content/architecture/i18n.md` for the design.
 */
export {
  createI18nContext,
  getI18nContext,
  type I18nSnapshot,
  I18nStore,
  setI18nContext,
  tryGetI18nContext,
} from './context.svelte.js';
export {
  clearRegisteredMessages,
  defineMessages,
  getRegisteredDefault,
  getRegisteredDefaults,
  type MessageCatalog,
} from './registry.js';
export { default as Trans } from './Trans.svelte';
export { useI18n } from './use-i18n.js';
