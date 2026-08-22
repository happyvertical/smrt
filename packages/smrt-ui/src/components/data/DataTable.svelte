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
import {
  compareDataTableRowIds,
  createDataTableController,
  type DataTableCommand,
  type DataTableController,
  type DataTableFilter,
  type DataTableModes,
  type DataTableRowId,
  type DataTableSnapshot,
  type DataTableViewState,
} from './DataTableController.js';
import { resolveDataTableRows } from './DataTableIdentity.js';
import type { DataTableColumn, DataTableProps, SortState } from './types.js';
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
  agentAddressable = false,
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
  controller,
  state: controlledState,
  initialState,
  onStateChange,
  modes,
}: ExtendedProps<T> = $props();

function legacyModes(): DataTableModes {
  return {
    filtering: modes?.filtering ?? 'local',
    sorting: modes?.sorting ?? (manualSorting ? 'manual' : 'local'),
    pagination: modes?.pagination ?? (manualPagination ? 'manual' : 'local'),
  };
}

function legacyViewState(): Partial<DataTableViewState> {
  return {
    sorting:
      sort.columnId && sort.direction
        ? [{ columnId: sort.columnId, direction: sort.direction }]
        : [],
    page,
    pageSize: pageSize ?? null,
    columnOrder: columns.map((column) => column.id),
    columnVisibility: columns.map((column) => ({
      columnId: column.id,
      visible: !visibleColumnIds || visibleColumnIds.has(column.id),
    })),
    selectedRowIds: [...selected],
    expandedRowIds: [...expanded],
  };
}

const localController = createDataTableController({
  modes: legacyModes(),
  onStateChange: (next, command) => onStateChange?.(next, command),
});

let controllerSnapshot = $state<DataTableSnapshot>(localController.snapshot());
let publishedLegacySignature: string | undefined;
let localControllerInitialized = false;

function activeController(): DataTableController {
  return controller ?? localController;
}

function legacySignature(): string {
  const legacy = legacyViewState();
  return JSON.stringify({
    sorting: legacy.sorting,
    page: legacy.page,
    pageSize: legacy.pageSize,
    columnVisibility: legacy.columnVisibility,
    selectedRowIds: [...(legacy.selectedRowIds ?? [])].sort(),
    expandedRowIds: [...(legacy.expandedRowIds ?? [])].sort(),
  });
}

function legacySort(next: DataTableViewState): SortState {
  const rule = next.sorting[0];
  return rule
    ? { columnId: rule.columnId, direction: rule.direction }
    : { columnId: null, direction: null };
}

function publishLegacyState(
  next: DataTableViewState,
  command: DataTableCommand,
  previous: DataTableViewState,
) {
  const nextSort = legacySort(next);
  const previousSort = legacySort(previous);
  sort = nextSort;
  page = next.page;
  selected = new Set(next.selectedRowIds);
  expanded = new Set(next.expandedRowIds);
  publishedLegacySignature = legacySignature();

  if (
    nextSort.columnId !== previousSort.columnId ||
    nextSort.direction !== previousSort.direction
  ) {
    onSortChange?.(nextSort);
  }
  if (
    JSON.stringify(next.selectedRowIds) !==
    JSON.stringify(previous.selectedRowIds)
  ) {
    onSelectionChange?.(new Set(next.selectedRowIds));
  }
  if (
    JSON.stringify(next.expandedRowIds) !==
    JSON.stringify(previous.expandedRowIds)
  ) {
    onExpandedChange?.(new Set(next.expandedRowIds));
  }
  if (next.page !== previous.page) onPageChange?.(next.page);
  void command;
}

$effect(() => {
  if (controller) return;

  localController.setControlled(controlledState !== undefined);
  localController.setModes(legacyModes());
  localController.setColumnIds(columns.map((column) => column.id));

  if (!localControllerInitialized) {
    localControllerInitialized = true;
    localController.replaceState({
      ...localController.getState(),
      ...(controlledState ?? { ...legacyViewState(), ...initialState }),
    });
    return;
  }

  if (controlledState !== undefined) {
    localController.replaceState(controlledState);
    return;
  }

  const signature = legacySignature();
  if (signature === publishedLegacySignature) {
    publishedLegacySignature = undefined;
    return;
  }
  localController.replaceState({
    ...localController.getState(),
    ...legacyViewState(),
  });
});

$effect(() => {
  const current = activeController();
  current.setColumnIds(columns.map((column) => column.id));
  controllerSnapshot = current.snapshot();
  return current.subscribe((transition) => {
    controllerSnapshot = transition.next;
    if (
      current === localController &&
      controlledState === undefined &&
      transition.command
    ) {
      publishLegacyState(
        transition.next.state,
        transition.command,
        transition.previous.state,
      );
    }
  });
});

const tableState = $derived(controllerSnapshot.state);
const tableModes = $derived(controllerSnapshot.modes);
const requiresStableRowIdentity = $derived(
  selectable ||
    Boolean(expandedContent) ||
    agentAddressable ||
    tableModes.filtering === 'manual' ||
    tableModes.sorting === 'manual' ||
    tableModes.pagination === 'manual',
);
const sourceRows = $derived.by(() =>
  resolveDataTableRows(data, rowKey, {
    requireStableIdentity: requiresStableRowIdentity,
  }),
);

function dispatch(command: DataTableCommand) {
  activeController().dispatch(command);
}

function handleSort(column: DataTableColumn<T>, event: MouseEvent) {
  if (!sortable || !column.sortable) return;
  dispatch({
    type: 'toggleSorting',
    columnId: column.id,
    multi: event.shiftKey,
  });
}

function handleRowSelect(key: DataTableRowId, event: Event) {
  event.stopPropagation();
  dispatch({ type: 'toggleRowSelection', rowId: key });
}

function handleSelectAll() {
  if (tableState.selection.scope === 'allMatching') {
    dispatch({
      type: 'setSelection',
      selection: { scope: 'explicit', rowIds: [] },
    });
    return;
  }
  const selectedIds = new Set(tableState.selectedRowIds);
  const visibleIds = displayRows.map(({ rowId }) => rowId);
  if (tableState.selection.scope === 'page') {
    dispatch({
      type: 'setPageSelection',
      rowIds: allSelected ? [] : visibleIds,
    });
    return;
  }
  if (allSelected) {
    for (const key of visibleIds) selectedIds.delete(key);
  } else {
    for (const key of visibleIds) selectedIds.add(key);
  }
  dispatch({ type: 'setSelectedRows', rowIds: [...selectedIds] });
}

function handleExpanded(key: DataTableRowId, event: Event) {
  event.stopPropagation();
  dispatch({ type: 'toggleRowExpansion', rowId: key });
}

function handlePageChange(next: number) {
  dispatch({ type: 'setPage', page: next });
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

const visibleColumns = $derived.by(() => {
  const configuredOrder = new Map(
    tableState.columnOrder.map((id, index) => [id, index]),
  );
  const visibility = new Map(
    tableState.columnVisibility.map((entry) => [entry.columnId, entry.visible]),
  );
  return columns
    .filter((column) => !column.hidden && visibility.get(column.id) !== false)
    .slice()
    .sort((left, right) => {
      const leftOrder = configuredOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder =
        configuredOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });
});

function sameFilterValue(value: unknown, expected: unknown): boolean {
  return Object.is(value, expected);
}

function textValue(value: unknown): string {
  return String(value ?? '').toLowerCase();
}

function compareFilterValues(left: unknown, right: unknown): number {
  const leftValue = left instanceof Date ? left.getTime() : left;
  const rightValue = right instanceof Date ? right.getTime() : right;
  if (typeof leftValue === 'number' && typeof rightValue === 'number')
    return leftValue - rightValue;
  const a = String(leftValue ?? '');
  const b = String(rightValue ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchesFilter(
  row: T,
  column: DataTableColumn<T>,
  filter: DataTableFilter,
): boolean {
  if (column.filterable === false) return true;
  const value = getCellValue(row, column);
  if (column.filterFn) return column.filterFn(row, value, filter);
  const expected = filter.value;
  const valueText = textValue(value);
  const expectedText = textValue(expected);
  switch (filter.operator) {
    case 'equals':
      return sameFilterValue(value, expected);
    case 'notEquals':
      return !sameFilterValue(value, expected);
    case 'contains':
      return valueText.includes(expectedText);
    case 'notContains':
      return !valueText.includes(expectedText);
    case 'startsWith':
      return valueText.startsWith(expectedText);
    case 'endsWith':
      return valueText.endsWith(expectedText);
    case 'in':
      return (
        Array.isArray(expected) &&
        expected.some((entry) => sameFilterValue(value, entry))
      );
    case 'notIn':
      return (
        Array.isArray(expected) &&
        !expected.some((entry) => sameFilterValue(value, entry))
      );
    case 'gt':
      return compareFilterValues(value, expected) > 0;
    case 'gte':
      return compareFilterValues(value, expected) >= 0;
    case 'lt':
      return compareFilterValues(value, expected) < 0;
    case 'lte':
      return compareFilterValues(value, expected) <= 0;
    case 'isNull':
      return value == null;
    case 'isNotNull':
      return value != null;
  }
}

const filteredRows = $derived.by(() => {
  if (tableModes.filtering === 'manual') return sourceRows;
  const search = tableState.search.toLowerCase();
  return sourceRows.filter(({ row, sourceIndex }) => {
    if (filterFn && !filterFn(row, sourceIndex)) return false;
    if (
      search &&
      !columns.some(
        (column) =>
          column.searchable !== false &&
          textValue(getCellValue(row, column)).includes(search),
      )
    ) {
      return false;
    }
    return tableState.filters.every((filter) => {
      const column = columns.find(
        (candidate) => candidate.id === filter.columnId,
      );
      return Boolean(column && matchesFilter(row, column, filter));
    });
  });
});

const sortedRows = $derived.by(() => {
  if (tableModes.sorting === 'manual' || tableState.sorting.length === 0)
    return filteredRows;
  return filteredRows.slice().sort((left, right) => {
    for (const rule of tableState.sorting) {
      const column = columns.find(
        (candidate) => candidate.id === rule.columnId,
      );
      if (!column) continue;
      const result = column.sortFn
        ? column.sortFn(left.row, right.row, rule.direction)
        : defaultSort(
            left.row,
            right.row,
            String(column.accessor ?? column.id),
            rule.direction,
          );
      if (result !== 0) return result;
    }
    return rowKey
      ? compareDataTableRowIds(left.rowId, right.rowId)
      : left.sourceIndex - right.sourceIndex;
  });
});

const totalRowCount = $derived(
  tableModes.pagination === 'manual' ? totalRows : sortedRows.length,
);
const totalPages = $derived(
  tableState.pageSize
    ? totalRowCount === undefined
      ? null
      : Math.max(1, Math.ceil(totalRowCount / tableState.pageSize))
    : 1,
);
const displayRows = $derived.by(() => {
  if (!tableState.pageSize || tableModes.pagination === 'manual')
    return sortedRows;
  const start = (tableState.page - 1) * tableState.pageSize;
  return sortedRows.slice(start, start + tableState.pageSize);
});

$effect(() => {
  const total = totalRows;
  if (total === undefined) return;
  if (tableModes.pagination !== 'manual') {
    throw new TypeError(
      'DataTable totalRows is only valid when pagination mode is manual',
    );
  }
  if (!Number.isFinite(total) || !Number.isInteger(total) || total < 0) {
    throw new TypeError(
      'DataTable totalRows must be a non-negative integer when supplied',
    );
  }
});

$effect(() => {
  void tableState.page;
  void tableState.pageSize;
  activeController().clampPage(totalRowCount);
});

const selectedIds = $derived(new Set(tableState.selectedRowIds));
const expandedIds = $derived(new Set(tableState.expandedRowIds));
const currentSort = $derived(legacySort(tableState));

const allSelected = $derived(
  tableState.selection.scope === 'allMatching' ||
    (displayRows.length > 0 &&
      displayRows.every(({ rowId }) => selectedIds.has(rowId))),
);
const someSelected = $derived(
  tableState.selection.scope !== 'allMatching' &&
    displayRows.some(({ rowId }) => selectedIds.has(rowId)) &&
    !allSelected,
);

const columnCount = $derived(
  visibleColumns.length + (selectable ? 1 : 0) + (expandedContent ? 1 : 0),
);

function getCellValue(row: T, column: DataTableColumn<T>): unknown {
  const accessor = column.accessor ?? column.id;
  return getNestedValue(row, String(accessor));
}

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
              aria-label={t(M['ui.data_table.select_current_page'])}
              class="data-table__checkbox"
            />
          </th>
        {/if}

        {#each visibleColumns as column (column.id)}
          <th
            class="data-table__cell data-table__cell--header"
            class:data-table__cell--sortable={sortable && column.sortable}
            class:data-table__cell--sorted={currentSort.columnId === column.id}
            style:width={column.width}
            style:min-width={column.minWidth}
            style:max-width={column.maxWidth}
            style:text-align={column.align}
            scope="col"
            aria-sort={currentSort.columnId === column.id
              ? currentSort.direction === 'asc'
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
                onclick={(event) => handleSort(column, event)}
              >
                <span>{column.label}</span>
                <span class="data-table__sort-icon" aria-hidden="true">
                  {#if currentSort.columnId === column.id}
                    {currentSort.direction === 'asc' ? '↑' : '↓'}
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
      {:else if displayRows.length === 0}
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
        {#each displayRows as entry, index (entry.rowId)}
          {@const row = entry.row}
          {@const key = entry.rowId}
          {@const isSelected = tableState.selection.scope === 'allMatching' || selectedIds.has(key)}
          {@const isExpanded = expandedIds.has(key)}
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
                  disabled={tableState.selection.scope === 'allMatching'}
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
      <tfoot><tr><td class="data-table__cell data-table__footer" colspan={columnCount}>{@render footer({ rows: displayRows.map(({ row }) => row) })}</td></tr></tfoot>
    {/if}
  </table>
</div>
{#if tableState.pageSize && totalPages && totalPages > 1}<Pagination currentPage={tableState.page} {totalPages} onPageChange={handlePageChange} aria-label="Table pages" />{/if}

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
  .data-table__expand-button { width: 1.75rem; height: 1.75rem; border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-full); background: transparent; color: var(--smrt-color-on-surface); cursor: pointer; }
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
