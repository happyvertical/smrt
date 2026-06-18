/**
 * `useI18n()` — the component-facing accessor for translations (S13 #1418).
 *
 * Returns the active i18n store, exposing `t(key, vars)` and a reactive
 * `locale`. Safe to call outside a `Provider`: it falls back to a default store
 * that resolves through registered English defaults, so primitives stay usable
 * in isolation and in tests.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useI18n } from '@happyvertical/smrt-svelte/i18n';
 *   const { t } = useI18n();
 * </script>
 * <input placeholder={t('chat.message_input.placeholder')} />
 * ```
 */
import { getI18nContext, type I18nStore } from './context.svelte.js';

export function useI18n(): I18nStore {
  return getI18nContext();
}
