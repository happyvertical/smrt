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
  'ui.data_table.select_current_page': 'Select all rows on this page',
  'ui.data_table.select_row': 'Select {row}',
  'ui.data_table.deselect_row': 'Deselect {row}',
  'ui.data_table.row_number': 'row {number}',
  'ui.data_table.expand': 'Expand',
  'ui.data_table.expand_row': 'Expand {row}',
  'ui.data_table.collapse_row': 'Collapse {row}',
  'ui.data_table.sort_ascending': 'Sort {column} ascending',
  'ui.data_table.sort_descending': 'Sort {column} descending',
  'ui.data_table.clear_sort': 'Clear sorting for {column}',
  'ui.data_table.loading': 'Loading table data',
  'ui.data_table.refreshing': 'Refreshing table data',
  'ui.data_table.stale': 'Showing stale results',
  'ui.data_table.partial_results': 'Showing partial results',
  'ui.data_table.load_error': 'Unable to load table data',
  'ui.data_table.retry': 'Retry',
  'ui.data_table.empty': 'No data available',
  'ui.data_table.virtual_region': '{caption} rows',
  'ui.data_table.default_virtual_region': 'Data table rows',
  'ui.data_table.pagination': 'Table pages',
  'ui.data_table.overflow_region':
    '{caption} table, scroll horizontally to view more columns',
  'ui.data_table.default_overflow_region':
    'Data table, scroll horizontally to view more columns',
  'ui.data_table.more_columns': 'More columns',
  'ui.data_table.resize_column': 'Resize {column}',
  'ui.data_table.structural_row': '{kind}: {label}',
  'ui.data_table.summary': 'Summary',
  'ui.data_table.subtotal': 'Subtotal',
  'ui.data_table.aggregate': 'Aggregate',
  'ui.data_table.footer_row': 'Footer',
});
