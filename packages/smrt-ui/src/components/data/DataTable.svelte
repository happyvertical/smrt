<script lang="ts" generics="T">
/**
 * DataTable - A flexible, accessible data table component
 *
 * Features:
 * - Sortable columns with custom sort functions
 * - Row selection (single and multi-select)
 * - Custom cell and header renderers via Snippets
 * - Loading and empty states
 * - Responsive with sticky header option
 * - Material 3 styling with theme token support
 */

import type { Snippet } from 'svelte';
import { M } from '../../i18n/strings.js';
import Trans from '../../i18n/Trans.svelte';
import { useI18n } from '../../i18n/use-i18n.js';
import Pagination from '../ui/Pagination.svelte';
import type {
  DataTableColumn,
  DataTableProps,
  SortDirection,
  SortState,
} from './types.js';
import { defaultSort, getNestedValue } from './types.js';

const { t } = useI18n();

interface ExtendedProps<T> extends DataTableProps<T> {
  /** Global cell renderer - takes precedence over column.cell */
  cell?: Snippet<
    [{ column: DataTableColumn<T>; row: T; value: unknown; index: number }]
  >;
}

let {
  data = [],
  columns = [],
  rowKey,
  selectable = false,
  selected = $bindable(new Set<string | number>()),
  onSelectionChange,
  onRowClick,
  sortable = false,
  sort = $bindable({ columnId: null, direction: null }),
  onSortChange,
  manualSorting = false,
  filterFn,
  page = $bindable(1),
  pageSize,
  manualPagination = false,
  totalRows,
  onPageChange,
  expanded = $bindable(new Set<string | number>()),
  onExpandedChange,
  canExpand,
  expandedContent,
  toolbar,
  footer,
  visibleColumnIds,
  loading = false,
  empty,
  rowClass,
  size = 'md',
  striped = false,
  hoverable = true,
  stickyHeader = false,
  caption,
  dense = false,
  cell,
}: ExtendedProps<T> = $props();

// Get row key value
function getRowKey(row: T, index: number): string | number {
  if (!rowKey) return index;
  if (typeof rowKey === 'function') return rowKey(row);
  return row[rowKey] as string | number;
}

function getDisplayRowKey(row: T, index: number): string | number {
  return getRowKey(row, displayIndexOffset + index);
}

// Handle sort click
function handleSort(column: DataTableColumn<T>) {
  if (!sortable || !column.sortable) return;

  const newSort: SortState = {
    columnId: column.id,
    direction:
      sort.columnId === column.id
        ? sort.direction === 'asc'
          ? 'desc'
          : sort.direction === 'desc'
            ? null
            : 'asc'
        : 'asc',
  };

  if (newSort.direction === null) {
    newSort.columnId = null;
  }

  sort = newSort;
  onSortChange?.(newSort);
}

// Handle row selection
function handleRowSelect(key: string | number, event: Event) {
  event.stopPropagation();
  const newSelected = new Set(selected);

  if (newSelected.has(key)) {
    newSelected.delete(key);
  } else {
    newSelected.add(key);
  }

  selected = newSelected;
  onSelectionChange?.(newSelected);
}

// Handle select all
function handleSelectAll() {
  if (allSelected) {
    const visibleKeys = new Set(
      displayData.map((row, i) => getDisplayRowKey(row, i)),
    );
    selected = new Set([...selected].filter((key) => !visibleKeys.has(key)));
  } else {
    selected = new Set([
      ...selected,
      ...displayData.map((row, i) => getDisplayRowKey(row, i)),
    ]);
  }
  onSelectionChange?.(selected);
}

function handleExpanded(key: string | number, event: Event) {
  event.stopPropagation();
  const next = new Set(expanded);
  next.has(key) ? next.delete(key) : next.add(key);
  expanded = next;
  onExpandedChange?.(next);
}

function handlePageChange(next: number) {
  page = Math.min(Math.max(1, next), totalPages);
  onPageChange?.(page);
}

// Handle row click
function handleRowClick(row: T, index: number) {
  onRowClick?.(row, index);
}

// Action to set indeterminate state (can't be set via HTML attribute)
function setIndeterminate(node: HTMLInputElement, value: boolean) {
  node.indeterminate = value;
  return {
    update(newValue: boolean) {
      node.indeterminate = newValue;
    },
  };
}

// Get visible columns
const visibleColumns = $derived(
  columns.filter(
    (col) => !col.hidden && (!visibleColumnIds || visibleColumnIds.has(col.id)),
  ),
);

const filteredData = $derived(filterFn ? data.filter(filterFn) : data);

// Sort data
const sortedData = $derived.by(() => {
  if (manualSorting || !sort.columnId || !sort.direction) return filteredData;

  const column = columns.find((c) => c.id === sort.columnId);
  if (!column) return filteredData;

  const accessor = column.accessor ?? column.id;
  const direction = sort.direction;

  return [...filteredData].sort((a, b) => {
    if (column.sortFn) {
      return column.sortFn(a, b, direction);
    }
    return defaultSort(a, b, String(accessor), direction);
  });
});

const totalRowCount = $derived(totalRows ?? sortedData.length);
const totalPages = $derived(
  pageSize ? Math.max(1, Math.ceil(totalRowCount / pageSize)) : 1,
);
const displayData = $derived.by(() => {
  if (!pageSize || manualPagination) return sortedData;
  const start = (page - 1) * pageSize;
  return sortedData.slice(start, start + pageSize);
});
const displayIndexOffset = $derived(pageSize ? (page - 1) * pageSize : 0);

$effect(() => {
  if (page > totalPages) handlePageChange(totalPages);
});

// Selection state
const allSelected = $derived(
  displayData.length > 0 &&
    displayData.every((row, i) => selected.has(getDisplayRowKey(row, i))),
);
const someSelected = $derived(
  displayData.some((row, i) => selected.has(getDisplayRowKey(row, i))) &&
    !allSelected,
);

const columnCount = $derived(
  visibleColumns.length + (selectable ? 1 : 0) + (expandedContent ? 1 : 0),
);

// Get cell value
function getCellValue(row: T, column: DataTableColumn<T>): unknown {
  const accessor = column.accessor ?? column.id;
  return getNestedValue(row, String(accessor));
}

// Size classes
const sizeClasses = {
  sm: 'data-table--sm',
  md: 'data-table--md',
  lg: 'data-table--lg',
};
</script>

{#if toolbar}<div class="data-table-toolbar">{@render toolbar()}</div>{/if}
<div class="data-table-container" class:data-table-container--sticky={stickyHeader}>
  <table
    class="data-table {sizeClasses[size]}"
    class:data-table--striped={striped}
    class:data-table--hoverable={hoverable}
    class:data-table--dense={dense}
    class:data-table--loading={loading}
  >
    {#if caption}
      <caption class="data-table__caption">{caption}</caption>
    {/if}

    <thead class="data-table__head">
      <tr class="data-table__row data-table__row--header">
        {#if expandedContent}<th class="data-table__cell data-table__cell--expand" scope="col"><span class="sr-only">Expand</span></th>{/if}
        {#if selectable}
          <th class="data-table__cell data-table__cell--checkbox" scope="col">
            <input
              type="checkbox"
              checked={allSelected}
              use:setIndeterminate={someSelected}
              onchange={handleSelectAll}
              aria-label={t(M['ui.data_table.select_all'])}
              class="data-table__checkbox"
            />
          </th>
        {/if}

        {#each visibleColumns as column (column.id)}
          <th
            class="data-table__cell data-table__cell--header"
            class:data-table__cell--sortable={sortable && column.sortable}
            class:data-table__cell--sorted={sort.columnId === column.id}
            style:width={column.width}
            style:min-width={column.minWidth}
            style:max-width={column.maxWidth}
            style:text-align={column.align}
            scope="col"
            aria-sort={sort.columnId === column.id
              ? sort.direction === 'asc'
                ? 'ascending'
                : 'descending'
              : undefined}
          >
            {#if column.header}
              {@render column.header({ column })}
            {:else if sortable && column.sortable}
              <button
                type="button"
                class="data-table__sort-button"
                onclick={() => handleSort(column)}
              >
                <span>{column.label}</span>
                <span class="data-table__sort-icon" aria-hidden="true">
                  {#if sort.columnId === column.id}
                    {sort.direction === 'asc' ? '↑' : '↓'}
                  {:else}
                    ↕
                  {/if}
                </span>
              </button>
            {:else}
              {column.label}
            {/if}
          </th>
        {/each}
      </tr>
    </thead>

    <tbody class="data-table__body">
      {#if loading}
        <tr class="data-table__row data-table__row--loading">
          <td
            class="data-table__cell data-table__cell--loading"
            colspan={columnCount}
          >
            <div class="data-table__loading-indicator">
              <span class="data-table__spinner"></span>
              <span><Trans key={M['ui.data_table.loading']} /></span>
            </div>
          </td>
        </tr>
      {:else if displayData.length === 0}
        <tr class="data-table__row data-table__row--empty">
          <td
            class="data-table__cell data-table__cell--empty"
            colspan={columnCount}
          >
            {#if empty}
              {@render empty()}
            {:else}
              <div class="data-table__empty-state">
                <span><Trans key={M['ui.data_table.empty']} /></span>
              </div>
            {/if}
          </td>
        </tr>
      {:else}
        {#each displayData as row, index (getDisplayRowKey(row, index))}
          {@const key = getDisplayRowKey(row, index)}
          {@const isSelected = selected.has(key)}
          {@const isExpanded = expanded.has(key)}
          {@const rowCanExpand = canExpand?.(row, index) ?? true}
          <tr
            class="data-table__row {rowClass?.(row, index) ?? ''}"
            class:data-table__row--selected={isSelected}
            onclick={() => handleRowClick(row, index)}
            role={onRowClick ? 'button' : undefined}
            tabindex={onRowClick ? 0 : undefined}
            onkeydown={(e) => {
              if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                handleRowClick(row, index);
              }
            }}
          >
            {#if expandedContent}
              <td class="data-table__cell data-table__cell--expand">
                {#if rowCanExpand}<button type="button" class="data-table__expand-button" aria-label={isExpanded ? 'Collapse row' : 'Expand row'} aria-expanded={isExpanded} onclick={(event) => handleExpanded(key, event)}>{isExpanded ? '−' : '+'}</button>{/if}
              </td>
            {/if}
            {#if selectable}
              <td class="data-table__cell data-table__cell--checkbox">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onchange={(e) => handleRowSelect(key, e)}
                  aria-label={t(M['ui.data_table.select_row'])}
                  class="data-table__checkbox"
                />
              </td>
            {/if}

            {#each visibleColumns as column (column.id)}
              {@const value = getCellValue(row, column)}
              <td
                class="data-table__cell {column.className ?? ''}"
                style:text-align={column.align}
              >
                {#if cell}
                  {@render cell({ column, row, value, index })}
                {:else if column.cell}
                  {@render column.cell({ row, value, index })}
                {:else}
                  {value ?? ''}
                {/if}
              </td>
            {/each}
          </tr>
          {#if expandedContent && isExpanded}
            <tr class="data-table__row data-table__row--expanded">
              <td class="data-table__cell data-table__cell--expanded" colspan={columnCount}>{@render expandedContent({ row, index })}</td>
            </tr>
          {/if}
        {/each}
      {/if}
    </tbody>
    {#if footer}
      <tfoot><tr><td class="data-table__cell data-table__footer" colspan={columnCount}>{@render footer({ rows: displayData })}</td></tr></tfoot>
    {/if}
  </table>
</div>
{#if pageSize && totalPages > 1}<Pagination currentPage={page} {totalPages} onPageChange={handlePageChange} aria-label="Table pages" />{/if}

<style>
  .data-table-container {
    width: 100%;
    overflow-x: auto;
  }

  .data-table-toolbar { margin-bottom: var(--smrt-spacing-2); }

  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

  .data-table-container--sticky {
    max-height: 100%;
    overflow-y: auto;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    border-spacing: 0;
    font-family: var(--smrt-font-family, inherit);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface, #111827);
    background: var(--smrt-color-surface, #ffffff);
  }

  .data-table__caption {
    padding: var(--smrt-spacing-3, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    text-align: left;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    caption-side: top;
  }

  /* Header */
  .data-table__head {
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .data-table-container--sticky .data-table__head {
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .data-table__row--header {
    border-bottom: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
  }

  .data-table__cell--header {
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-align: left;
    white-space: nowrap;
    color: var(--smrt-color-on-surface, #111827);
  }

  .data-table__cell--sortable {
    cursor: pointer;
    user-select: none;
  }

  .data-table__sort-button {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: inherit;
    cursor: pointer;
  }

  .data-table__sort-button:hover {
    color: var(--smrt-color-primary, #3b82f6);
  }

  .data-table__sort-icon {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    opacity: 0.5;
  }

  .data-table__cell--sorted .data-table__sort-icon {
    opacity: 1;
    color: var(--smrt-color-primary, #3b82f6);
  }

  /* Body */
  .data-table__body {
    background: var(--smrt-color-surface, #ffffff);
  }

  .data-table__row {
    border-bottom: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    transition: background-color var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, ease);
  }

  .data-table--hoverable .data-table__row:hover:not(.data-table__row--loading):not(.data-table__row--empty) {
    background: var(--smrt-color-surface-container-low, #f9fafb);
  }

  .data-table__row--selected {
    background: var(--smrt-color-primary-container, #dbeafe) !important;
  }

  .data-table--striped .data-table__row:nth-child(even) {
    background: var(--smrt-color-surface-container-lowest, #fafafa);
  }

  .data-table__row[role='button'] {
    cursor: pointer;
  }

  .data-table__row[role='button']:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #3b82f6);
    outline-offset: -2px;
  }

  .data-table__cell {
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
    vertical-align: middle;
  }

  .data-table__cell--checkbox {
    width: 48px;
    text-align: center;
  }

  .data-table__cell--expand { width: 2.75rem; text-align: center; }
  .data-table__expand-button { width: 1.75rem; height: 1.75rem; border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-full); background: transparent; color: var(--smrt-color-on-surface); cursor: pointer; }
  .data-table__expand-button:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .data-table__cell--expanded { padding: var(--smrt-spacing-4); background: var(--smrt-color-surface-container-low); }
  .data-table__footer { border-top: 2px solid var(--smrt-color-outline-variant); font-weight: var(--smrt-typography-weight-medium); }

  .data-table__checkbox {
    width: 18px;
    height: 18px;
    cursor: pointer;
    accent-color: var(--smrt-color-primary, #3b82f6);
  }

  /* Loading */
  .data-table__cell--loading,
  .data-table__cell--empty {
    padding: var(--smrt-spacing-8, 2rem);
    text-align: center;
  }

  .data-table__loading-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .data-table__spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--smrt-color-outline-variant, #e5e7eb);
    border-top-color: var(--smrt-color-primary, #3b82f6);
    border-radius: var(--smrt-radius-full, 9999px);
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .data-table__empty-state {
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  /* Size variants */
  .data-table--sm .data-table__cell {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }

  .data-table--sm .data-table__cell--header {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }

  .data-table--lg .data-table__cell {
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
  }

  .data-table--lg .data-table__cell--header {
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
  }

  /* Dense mode */
  .data-table--dense .data-table__cell {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
  }

  .data-table--dense .data-table__cell--header {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-2, 0.5rem);
  }

  /* Loading overlay */
  .data-table--loading {
    opacity: 0.7;
    pointer-events: none;
  }
</style>
