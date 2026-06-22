/**
 * smrt-svelte UI primitive message catalog (S13 #1418 pilot).
 *
 * English code defaults for strings baked into the library's own primitives.
 * Keys use the `ui.` namespace (see the i18n ADR). Importing this module
 * registers the defaults so `useI18n().t` / `<Trans>` render correctly even
 * without a server snapshot; on the server, `buildI18nSnapshot` resolves these
 * keys through the override/tenant/locale chain.
 *
 * `M` is a typed key map — `M['ui.data_table.empty']` is the key literal — so
 * component call sites stay typo-safe.
 */
import { defineMessages } from './registry.js';

export const M = defineMessages({
  'ui.data_table.select_all': 'Select all rows',
  'ui.data_table.select_row': 'Select row',
  'ui.data_table.loading': 'Loading...',
  'ui.data_table.empty': 'No data available',
});
