/**
 * @happyvertical/smrt-ui/i18n — client i18n layer (Sweep S13 #1418).
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
// Side-effect: register smrt-ui's own primitive (`ui.*`) English code defaults
// (DataTable etc.) so a single `@happyvertical/smrt-ui/i18n` import makes every
// library primitive key resolvable — including in a server snapshot built
// without loading the components themselves. `strings.ui.js` is registered via
// the `M` re-export below; this covers the `strings.ts` catalog too.
import './strings.js';

// smrt-ui primitive (`ui.*`) English code-default catalog. Re-exported so
// consumers (e.g. smrt-svelte composites) can register the same defaults via a
// single `@happyvertical/smrt-ui/i18n` import.
export { M } from './strings.ui.js';
export { useI18n } from './use-i18n.js';
