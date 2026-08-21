/** Maps declared DataSurface controls onto the existing DataTable command model. */

import type {
  DataTableColumnVisibility,
  DataTableCommand,
  DataTableFilter,
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
      const filters = arrayValue(payload?.filters);
      return filters === undefined
        ? null
        : {
            type: 'setFilters',
            filters: filters as unknown as DataTableFilter[],
          };
    }
    case 'set-sorting': {
      const sorting = arrayValue(payload?.sorting);
      return sorting === undefined
        ? null
        : {
            type: 'setSorting',
            sorting: sorting as unknown as DataTableSortRule[],
          };
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
      return pageSize === null || numberValue(pageSize) !== undefined
        ? { type: 'setPageSize', pageSize: pageSize as number | null }
        : null;
    }
    case 'set-column-order': {
      const columnIds = arrayValue(payload?.columnIds);
      return columnIds?.every((value) => typeof value === 'string')
        ? { type: 'setColumnOrder', columnIds: columnIds as string[] }
        : null;
    }
    case 'set-column-visibility': {
      const columns = arrayValue(payload?.columns);
      return columns === undefined
        ? null
        : {
            type: 'setColumnVisibility',
            columns: columns as unknown as DataTableColumnVisibility[],
          };
    }
    case 'set-selected-rows': {
      const rowIds = arrayValue(payload?.rowIds);
      return rowIds?.every(
        (value) => typeof value === 'string' || typeof value === 'number',
      )
        ? { type: 'setSelectedRows', rowIds: rowIds as Array<string | number> }
        : null;
    }
    case 'toggle-row-selection': {
      const rowId = payload?.rowId;
      return typeof rowId === 'string' || typeof rowId === 'number'
        ? { type: 'toggleRowSelection', rowId }
        : null;
    }
    case 'set-expanded-rows': {
      const rowIds = arrayValue(payload?.rowIds);
      return rowIds?.every(
        (value) => typeof value === 'string' || typeof value === 'number',
      )
        ? { type: 'setExpandedRows', rowIds: rowIds as Array<string | number> }
        : null;
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
