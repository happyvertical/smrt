/**
 * Client-safe message-default registry (i18n, Sweep S13 #1418).
 *
 * `defineMessages` records a package's English code defaults in a process-global
 * map. This module imports nothing from `@happyvertical/smrt-languages` — it is
 * safe in any bundle (browser included). Two consumers read the map:
 *
 * - The client `$t` / `<Trans>` fall back to the registered default when no
 *   server snapshot is present (standalone components, tests), so a string is
 *   never blank.
 * - The server `buildI18nSnapshot` (`./i18n/server`) seeds
 *   `@happyvertical/smrt-languages`'s `LanguageRegistry` from these defaults
 *   before resolving the override/tenant/locale chain.
 *
 * Keys follow `<package>.<component>.<descriptor>` (see the i18n ADR); smrt-svelte
 * primitives use the `ui` namespace.
 */

/** A catalog of message keys → English code default templates. */
export type MessageCatalog = Record<string, string>;

const defaults = new Map<string, string>();

/**
 * Register a package's English code defaults. Idempotent for an identical
 * template; throws if a key is redefined with a different default (mirrors
 * `LanguageRegistry.register`, surfacing accidental key collisions loudly).
 *
 * Returns a typed **key map** (each key mapped to itself) so call sites get
 * autocomplete and typo-safety, and so the import is a *used* binding that
 * tree-shaking cannot drop (which would silently skip registration):
 *
 * ```ts
 * export const M = defineMessages({ 'ui.data_table.empty': 'No data available' });
 * // M['ui.data_table.empty'] === 'ui.data_table.empty'  (typed as the literal)
 * t(M['ui.data_table.empty']);
 * ```
 */
export function defineMessages<T extends MessageCatalog>(
  catalog: T,
): { readonly [K in keyof T]: K } {
  const keys = {} as { [K in keyof T]: K };
  for (const [key, template] of Object.entries(catalog)) {
    if (!key || key.trim() === '') {
      throw new Error('defineMessages: message keys must be non-empty');
    }
    const existing = defaults.get(key);
    if (existing !== undefined && existing !== template) {
      throw new Error(
        `defineMessages: message "${key}" is already registered with a different default`,
      );
    }
    defaults.set(key, template);
    (keys as Record<string, string>)[key] = key;
  }
  return keys;
}

/** The registered English default for a key, or `undefined`. */
export function getRegisteredDefault(key: string): string | undefined {
  return defaults.get(key);
}

/** A snapshot of every registered `(key, English default)` pair. */
export function getRegisteredDefaults(): Record<string, string> {
  return Object.fromEntries(defaults);
}

/** Test-only: clear the registry so module-cache tests start clean. */
export function clearRegisteredMessages(): void {
  defaults.clear();
}
