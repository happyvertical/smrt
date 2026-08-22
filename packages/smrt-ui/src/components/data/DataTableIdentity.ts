import {
  assertDataTableRowId,
  type DataTableRowId,
  dataTableRowIdKey,
} from './DataTableController.js';

/** A stable row identity accessor. It must not depend on display position. */
export type DataTableRowKey<T> = keyof T | ((row: T) => DataTableRowId);

export interface DataTableResolvedRow<T> {
  row: T;
  /** Index in the `data` array supplied to DataTable before local transforms. */
  sourceIndex: number;
  /** Canonical key used by Svelte, selection, and expansion. */
  rowId: DataTableRowId;
}

export interface ResolveDataTableRowsOptions {
  /** Durable table features may not use the historical source-index fallback. */
  requireStableIdentity?: boolean;
}

function readRowKey<T>(row: T, rowKey: DataTableRowKey<T>): unknown {
  return typeof rowKey === 'function'
    ? rowKey(row)
    : (row as Record<PropertyKey, unknown>)[rowKey];
}

/**
 * Resolve the renderer's source rows once and fail closed for missing or
 * duplicate durable identities. The index fallback only exists for
 * presentational local tables that have no durable row state.
 */
export function resolveDataTableRows<T>(
  rows: readonly T[],
  rowKey: DataTableRowKey<T> | undefined,
  options: ResolveDataTableRowsOptions = {},
): DataTableResolvedRow<T>[] {
  if (options.requireStableIdentity && !rowKey) {
    throw new TypeError(
      'DataTable rowKey is required for selectable, expandable, manual, or agent-addressable tables',
    );
  }

  const seen = new Set<string>();
  return rows.map((row, sourceIndex) => {
    const rowId = rowKey
      ? assertDataTableRowId(readRowKey(row, rowKey))
      : sourceIndex;
    const key = dataTableRowIdKey(rowId);
    if (seen.has(key)) {
      throw new TypeError(
        `DataTable rowKey must resolve to unique row ids; duplicate ${key}`,
      );
    }
    seen.add(key);
    return { row, sourceIndex, rowId };
  });
}
