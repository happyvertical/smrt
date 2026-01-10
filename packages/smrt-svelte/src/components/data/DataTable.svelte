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
import type {
  DataTableColumn,
  DataTableProps,
  SortDirection,
  SortState,
} from './types.js';
import { defaultSort, getNestedValue } from './types.js';

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
    selected = new Set();
  } else {
    selected = new Set(sortedData.map((row, i) => getRowKey(row, i)));
  }
  onSelectionChange?.(selected);
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
const visibleColumns = $derived(columns.filter((col) => !col.hidden));

// Sort data
const sortedData = $derived.by(() => {
  if (!sort.columnId || !sort.direction) return data;

  const column = columns.find((c) => c.id === sort.columnId);
  if (!column) return data;

  const accessor = column.accessor ?? column.id;

  return [...data].sort((a, b) => {
    if (column.sortFn) {
      return column.sortFn(a, b, sort.direction!);
    }
    return defaultSort(a, b, String(accessor), sort.direction!);
  });
});

// Selection state
const allSelected = $derived(
  data.length > 0 && data.every((row, i) => selected.has(getRowKey(row, i))),
);
const someSelected = $derived(
  data.some((row, i) => selected.has(getRowKey(row, i))) && !allSelected,
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

<div
  class="data-table-container"
  class:data-table-container--sticky={stickyHeader}
>
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
        {#if selectable}
          <th class="data-table__cell data-table__cell--checkbox" scope="col">
            <input
              type="checkbox"
              checked={allSelected}
              use:setIndeterminate={someSelected}
              onchange={handleSelectAll}
              aria-label="Select all rows"
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
            colspan={visibleColumns.length + (selectable ? 1 : 0)}
          >
            <div class="data-table__loading-indicator">
              <span class="data-table__spinner"></span>
              <span>Loading...</span>
            </div>
          </td>
        </tr>
      {:else if sortedData.length === 0}
        <tr class="data-table__row data-table__row--empty">
          <td
            class="data-table__cell data-table__cell--empty"
            colspan={visibleColumns.length + (selectable ? 1 : 0)}
          >
            {#if empty}
              {@render empty()}
            {:else}
              <div class="data-table__empty-state">
                <span>No data available</span>
              </div>
            {/if}
          </td>
        </tr>
      {:else}
        {#each sortedData as row, index (getRowKey(row, index))}
          {@const key = getRowKey(row, index)}
          {@const isSelected = selected.has(key)}
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
            {#if selectable}
              <td class="data-table__cell data-table__cell--checkbox">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onchange={(e) => handleRowSelect(key, e)}
                  aria-label="Select row"
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
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<style>
  .data-table-container {
    width: 100%;
    overflow-x: auto;
  }

  .data-table-container--sticky {
    max-height: 100%;
    overflow-y: auto;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    border-spacing: 0;
    font-family: var(--smrt-font-family, inherit);
    font-size: var(--smrt-font-size-sm, 0.875rem);
    color: var(--smrt-on-surface, #111827);
    background: var(--smrt-surface, #ffffff);
  }

  .data-table__caption {
    padding: var(--smrt-spacing-3, 0.75rem);
    font-weight: 500;
    text-align: left;
    color: var(--smrt-on-surface-variant, #6b7280);
    caption-side: top;
  }

  /* Header */
  .data-table__head {
    background: var(--smrt-surface-container, #f3f4f6);
  }

  .data-table-container--sticky .data-table__head {
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .data-table__row--header {
    border-bottom: 1px solid var(--smrt-outline-variant, #e5e7eb);
  }

  .data-table__cell--header {
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
    font-weight: 600;
    text-align: left;
    white-space: nowrap;
    color: var(--smrt-on-surface, #111827);
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
    font-weight: 600;
    color: inherit;
    cursor: pointer;
  }

  .data-table__sort-button:hover {
    color: var(--smrt-primary, #3b82f6);
  }

  .data-table__sort-icon {
    font-size: 0.75rem;
    opacity: 0.5;
  }

  .data-table__cell--sorted .data-table__sort-icon {
    opacity: 1;
    color: var(--smrt-primary, #3b82f6);
  }

  /* Body */
  .data-table__body {
    background: var(--smrt-surface, #ffffff);
  }

  .data-table__row {
    border-bottom: 1px solid var(--smrt-outline-variant, #e5e7eb);
    transition: background-color var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, ease);
  }

  .data-table--hoverable .data-table__row:hover:not(.data-table__row--loading):not(.data-table__row--empty) {
    background: var(--smrt-surface-container-low, #f9fafb);
  }

  .data-table__row--selected {
    background: var(--smrt-primary-container, #dbeafe) !important;
  }

  .data-table--striped .data-table__row:nth-child(even) {
    background: var(--smrt-surface-container-lowest, #fafafa);
  }

  .data-table__row[role='button'] {
    cursor: pointer;
  }

  .data-table__row[role='button']:focus-visible {
    outline: 2px solid var(--smrt-primary, #3b82f6);
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

  .data-table__checkbox {
    width: 18px;
    height: 18px;
    cursor: pointer;
    accent-color: var(--smrt-primary, #3b82f6);
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
    color: var(--smrt-on-surface-variant, #6b7280);
  }

  .data-table__spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--smrt-outline-variant, #e5e7eb);
    border-top-color: var(--smrt-primary, #3b82f6);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .data-table__empty-state {
    color: var(--smrt-on-surface-variant, #6b7280);
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
