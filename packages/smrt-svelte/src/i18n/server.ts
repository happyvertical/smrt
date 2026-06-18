/**
 * @happyvertical/smrt-svelte/i18n/server — server snapshot builder (S13 #1418).
 *
 * Node-only. Pulls the full `@happyvertical/smrt-languages` resolver (and thus
 * its server dependency tree), so it MUST stay off the client bundle — it lives
 * on a dedicated subpath the browser never imports. The browser-facing i18n
 * layer is `@happyvertical/smrt-svelte/i18n`.
 *
 * A consumer's load function calls `buildI18nSnapshot` for the request locale
 * and passes the result to `<Provider i18n={snapshot}>`.
 */
import {
  defineLanguageString,
  LanguageRegistry,
  type ResolveLanguageStringOptions,
  resolveLanguageString,
} from '@happyvertical/smrt-languages';
import type { I18nSnapshot } from './context.svelte.js';
import { getRegisteredDefaults } from './registry.js';

export interface BuildI18nSnapshotOptions {
  /** Target locale (BCP-47-ish, e.g. `fr-CA`). */
  locale: string;
  /** Tenant scope for tenant-level overrides. */
  tenantId?: ResolveLanguageStringOptions['tenantId'];
  /**
   * DB handle for app/tenant overrides and auto-translation. Omit to resolve
   * code defaults only (no overrides, no translation jobs).
   */
  db?: ResolveLanguageStringOptions['db'];
  /**
   * Restrict the snapshot to these keys. Defaults to every key registered via
   * `defineMessages` (the catalogs imported on the server so far).
   */
  keys?: string[];
}

/**
 * Resolve a per-locale dictionary of message **templates** for the keys an app
 * uses. Seeds `LanguageRegistry` from the English defaults registered via
 * `defineMessages`, then walks each key through the override/tenant/locale
 * chain. Variables are NOT applied — the client interpolates them at render
 * time with the same `renderTemplate`.
 */
export async function buildI18nSnapshot(
  options: BuildI18nSnapshotOptions,
): Promise<I18nSnapshot> {
  const { locale, tenantId = null, db, keys } = options;

  // Seed the languages registry with smrt-svelte's English code defaults so the
  // resolver's code layer can serve them. Idempotent — skip keys already
  // registered (a different template for the same key would have thrown at
  // `defineMessages` time).
  const defaults = getRegisteredDefaults();
  for (const [key, template] of Object.entries(defaults)) {
    if (!LanguageRegistry.has(key, 'en')) {
      defineLanguageString({ key, locale: 'en', template });
    }
  }

  const targetKeys = keys ?? Object.keys(defaults);
  const messages: Record<string, string> = {};
  await Promise.all(
    targetKeys.map(async (key) => {
      const resolved = await resolveLanguageString(key, {
        db,
        tenantId,
        locale,
      });
      messages[key] = resolved.template;
    }),
  );

  return { locale, messages };
}
