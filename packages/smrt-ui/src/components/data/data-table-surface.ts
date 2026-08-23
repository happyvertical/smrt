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
 * Returns `null` for a component-local control (focus, reveal, refresh, …) or
 * an invalid table command. The mounted component owns those local controls.
 */
export function dataTableCommandFromDataSurfaceCommand(
  command: DataSurfaceVisibleCommand,
): DataTableCommand | null {
  const payload = payloadObject(command.payload);
  switch (command.controlId) {
    case 'set-search': {
      const search = stringValue(payload?.search);
      return search === undefined ? null : { type: 'setSearch', search };
    }
    case 'set-filters': {
      const filters = dataTableFilters(payload?.filters);
      return filters === undefined ? null : { type: 'setFilters', filters };
    }
    case 'set-sorting': {
      const sorting = dataTableSorting(payload?.sorting);
      return sorting === undefined ? null : { type: 'setSorting', sorting };
    }
    case 'toggle-sorting': {
      const columnId = stringValue(payload?.columnId);
      if (!columnId) return null;
      const multi = booleanValue(payload?.multi);
      return {
        type: 'toggleSorting',
        columnId,
        ...(multi === undefined ? {} : { multi }),
      };
    }
    case 'set-page': {
      const page = numberValue(payload?.page);
      return page === undefined ? null : { type: 'setPage', page };
    }
    case 'set-page-size': {
      const pageSize = payload?.pageSize;
      if (pageSize === null) return { type: 'setPageSize', pageSize: null };
      const numericPageSize = numberValue(pageSize);
      return numericPageSize === undefined
        ? null
        : { type: 'setPageSize', pageSize: numericPageSize };
    }
    case 'set-column-order': {
      const columnIds = arrayValue(payload?.columnIds);
      if (!columnIds?.every((value) => typeof value === 'string')) return null;
      const ids: string[] = [];
      for (const value of columnIds) {
        if (typeof value !== 'string' || value.length === 0) return null;
        ids.push(value);
      }
      return { type: 'setColumnOrder', columnIds: ids };
    }
    case 'set-column-visibility': {
      const columns = dataTableVisibilities(payload?.columns);
      return columns === undefined
        ? null
        : { type: 'setColumnVisibility', columns };
    }
    case 'set-selected-rows': {
      const rowIds = dataTableRowIds(payload?.rowIds);
      return rowIds === undefined ? null : { type: 'setSelectedRows', rowIds };
    }
    case 'toggle-row-selection': {
      const rowId = payload?.rowId;
      return typeof rowId === 'string' || typeof rowId === 'number'
        ? { type: 'toggleRowSelection', rowId }
        : null;
    }
    case 'set-expanded-rows': {
      const rowIds = dataTableRowIds(payload?.rowIds);
      return rowIds === undefined ? null : { type: 'setExpandedRows', rowIds };
    }
    case 'toggle-row-expansion': {
      const rowId = payload?.rowId;
      return typeof rowId === 'string' || typeof rowId === 'number'
        ? { type: 'toggleRowExpansion', rowId }
        : null;
    }
    case 'reset':
      return { type: 'reset' };
    default:
      return null;
  }
}
