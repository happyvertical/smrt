/** Maps declared DataSurface controls onto the existing DataTable command model. */

import type {
  DataTableColumnVisibility,
  DataTableCommand,
  DataTableFilter,
  DataTableFilterOperator,
  DataTableRowId,
  DataTableSortRule,
} from './DataTableController.js';
import type {
  DataSurfaceJsonValue,
  DataSurfaceVisibleCommand,
} from './data-surface.js';

function payloadObject(
  value: DataSurfaceJsonValue | undefined,
): Record<string, DataSurfaceJsonValue> | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    return undefined;
  return value;
}

function stringValue(
  value: DataSurfaceJsonValue | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(
  value: DataSurfaceJsonValue | undefined,
): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberValue(
  value: DataSurfaceJsonValue | undefined,
): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function arrayValue(
  value: DataSurfaceJsonValue | undefined,
): DataSurfaceJsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

const FILTER_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'in',
  'notIn',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'isNotNull',
] as const satisfies readonly DataTableFilterOperator[];

function filterOperator(
  value: DataSurfaceJsonValue | undefined,
): DataTableFilterOperator | undefined {
  return typeof value === 'string'
    ? FILTER_OPERATORS.find((operator) => operator === value)
    : undefined;
}

function dataTableFilter(
  value: DataSurfaceJsonValue,
): DataTableFilter | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    return undefined;
  const entry = value as Record<string, DataSurfaceJsonValue>;
  const columnId = stringValue(entry.columnId);
  const operator = filterOperator(entry.operator);
  if (!columnId || !operator) return undefined;
  const needsValue = operator !== 'isNull' && operator !== 'isNotNull';
  if (needsValue && !Object.hasOwn(entry, 'value')) return undefined;
  return needsValue
    ? { columnId, operator, value: entry.value }
    : { columnId, operator };
}

function dataTableFilters(
  value: DataSurfaceJsonValue | undefined,
): DataTableFilter[] | undefined {
  const values = arrayValue(value);
  if (!values) return undefined;
  const filters = values.map(dataTableFilter);
  return filters.every(
    (filter): filter is DataTableFilter => filter !== undefined,
  )
    ? filters
    : undefined;
}

function dataTableSort(
  value: DataSurfaceJsonValue,
): DataTableSortRule | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    return undefined;
  const entry = value as Record<string, DataSurfaceJsonValue>;
  const columnId = stringValue(entry.columnId);
  const direction = stringValue(entry.direction);
  return columnId && (direction === 'asc' || direction === 'desc')
    ? { columnId, direction }
    : undefined;
}

function dataTableSorting(
  value: DataSurfaceJsonValue | undefined,
): DataTableSortRule[] | undefined {
  const values = arrayValue(value);
  if (!values) return undefined;
  const sorting = values.map(dataTableSort);
  return sorting.every((sort): sort is DataTableSortRule => sort !== undefined)
    ? sorting
    : undefined;
}

function dataTableVisibility(
  value: DataSurfaceJsonValue,
): DataTableColumnVisibility | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    return undefined;
  const entry = value as Record<string, DataSurfaceJsonValue>;
  const columnId = stringValue(entry.columnId);
  return columnId && typeof entry.visible === 'boolean'
    ? { columnId, visible: entry.visible }
    : undefined;
}

function dataTableVisibilities(
  value: DataSurfaceJsonValue | undefined,
): DataTableColumnVisibility[] | undefined {
  const values = arrayValue(value);
  if (!values) return undefined;
  const columns = values.map(dataTableVisibility);
  return columns.every(
    (column): column is DataTableColumnVisibility => column !== undefined,
  )
    ? columns
    : undefined;
}

function dataTableRowIds(
  value: DataSurfaceJsonValue | undefined,
): DataTableRowId[] | undefined {
  const values = arrayValue(value);
  if (!values) return undefined;
  return values.every(
    (rowId) => typeof rowId === 'string' || typeof rowId === 'number',
  )
    ? values
    : undefined;
}

/**
 * Every `controlId` {@link dataTableCommandFromDataSurfaceCommand} below
 * understands as a table command (as opposed to a component-local control it
 * returns `null` for). Declared once, here, as the sole source of truth: the
 * `Record` below is a mapped type over this union, so the compiler — not a
 * comment — rejects both a missing handler for a listed id and a handler
 * keyed by an id not listed here. There is no second list and no `switch` to
 * drift out of sync with it.
 */
export type DataTableSurfaceControlId =
  | 'set-search'
  | 'set-filters'
  | 'set-sorting'
  | 'toggle-sorting'
  | 'set-page'
  | 'set-page-size'
  | 'set-column-order'
  | 'set-column-visibility'
  | 'set-selected-rows'
  | 'toggle-row-selection'
  | 'set-expanded-rows'
  | 'toggle-row-expansion'
  | 'reset';

type DataTableSurfaceControlHandler = (
  payload: Record<string, DataSurfaceJsonValue> | undefined,
) => DataTableCommand | null;

const dataTableSurfaceControlHandlers: Record<
  DataTableSurfaceControlId,
  DataTableSurfaceControlHandler
> = {
  'set-search': (payload) => {
    const search = stringValue(payload?.search);
    return search === undefined ? null : { type: 'setSearch', search };
  },
  'set-filters': (payload) => {
    const filters = dataTableFilters(payload?.filters);
    return filters === undefined ? null : { type: 'setFilters', filters };
  },
  'set-sorting': (payload) => {
    const sorting = dataTableSorting(payload?.sorting);
    return sorting === undefined ? null : { type: 'setSorting', sorting };
  },
  'toggle-sorting': (payload) => {
    const columnId = stringValue(payload?.columnId);
    if (!columnId) return null;
    const multi = booleanValue(payload?.multi);
    return {
      type: 'toggleSorting',
      columnId,
      ...(multi === undefined ? {} : { multi }),
    };
  },
  'set-page': (payload) => {
    const page = numberValue(payload?.page);
    return page === undefined ? null : { type: 'setPage', page };
  },
  'set-page-size': (payload) => {
    const pageSize = payload?.pageSize;
    if (pageSize === null) return { type: 'setPageSize', pageSize: null };
    const numericPageSize = numberValue(pageSize);
    return numericPageSize === undefined
      ? null
      : { type: 'setPageSize', pageSize: numericPageSize };
  },
  'set-column-order': (payload) => {
    const columnIds = arrayValue(payload?.columnIds);
    if (!columnIds?.every((value) => typeof value === 'string')) return null;
    const ids: string[] = [];
    for (const value of columnIds) {
      if (typeof value !== 'string' || value.length === 0) return null;
      ids.push(value);
    }
    return { type: 'setColumnOrder', columnIds: ids };
  },
  'set-column-visibility': (payload) => {
    const columns = dataTableVisibilities(payload?.columns);
    return columns === undefined
      ? null
      : { type: 'setColumnVisibility', columns };
  },
  'set-selected-rows': (payload) => {
    const rowIds = dataTableRowIds(payload?.rowIds);
    return rowIds === undefined ? null : { type: 'setSelectedRows', rowIds };
  },
  'toggle-row-selection': (payload) => {
    const rowId = payload?.rowId;
    return typeof rowId === 'string' || typeof rowId === 'number'
      ? { type: 'toggleRowSelection', rowId }
      : null;
  },
  'set-expanded-rows': (payload) => {
    const rowIds = dataTableRowIds(payload?.rowIds);
    return rowIds === undefined ? null : { type: 'setExpandedRows', rowIds };
  },
  'toggle-row-expansion': (payload) => {
    const rowId = payload?.rowId;
    return typeof rowId === 'string' || typeof rowId === 'number'
      ? { type: 'toggleRowExpansion', rowId }
      : null;
  },
  reset: () => ({ type: 'reset' }),
};

/**
 * Mechanically derived from {@link dataTableSurfaceControlHandlers} — never
 * hand-copy this list. A consumer that must distinguish "this controlId
 * names a table command whose payload failed to translate" from "this is a
 * genuinely unknown/custom control" (for example to deny the former outright
 * rather than forwarding it to a generic escape hatch) imports this.
 */
export const DATA_TABLE_SURFACE_CONTROL_IDS = Object.keys(
  dataTableSurfaceControlHandlers,
) as DataTableSurfaceControlId[];

function isDataTableSurfaceControlId(
  value: string,
): value is DataTableSurfaceControlId {
  return Object.hasOwn(dataTableSurfaceControlHandlers, value);
}

/**
 * Returns `null` for a component-local control (focus, reveal, refresh, …) or
 * an invalid table command. The mounted component owns those local controls.
 */
export function dataTableCommandFromDataSurfaceCommand(
  command: DataSurfaceVisibleCommand,
): DataTableCommand | null {
  if (!isDataTableSurfaceControlId(command.controlId)) return null;
  const payload = payloadObject(command.payload);
  return dataTableSurfaceControlHandlers[command.controlId](payload);
}
