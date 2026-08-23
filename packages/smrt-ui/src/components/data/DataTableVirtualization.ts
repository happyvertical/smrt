import type { DataTableRowId } from './DataTableController.js';

/**
 * Fixed-height virtualization configuration for the DataTable body.
 *
 * Header groups and summary rows remain normal table sections and are not
 * included in the virtual row count. Body rows must have a fixed height.
 */
export interface DataTableVirtualizationOptions {
  /** The measured, fixed height of each data row in CSS pixels. */
  rowHeight: number;
  /**
   * The visible height of the scrolling data viewport in CSS pixels. The
   * component adds measured caption and header height around this body region.
   */
  viewportHeight: number;
  /** Extra rows rendered before and after the visible range. Defaults to 3. */
  overscan?: number;
  /** Controlled scroll position, used to restore a table after remounting. */
  scrollTop?: number;
  /**
   * Receives the current virtual scroll position. When a footer is present,
   * its measured height extends the range so it remains reachable.
   */
  onScrollTopChange?: (scrollTop: number) => void;
  /**
   * A stable row id that must remain visible. Use this with
   * `onFocusedRowIdChange` to restore keyboard focus after a data refresh.
   */
  focusedRowId?: DataTableRowId | null;
  /** Receives the stable id of a row when focus enters that row. */
  onFocusedRowIdChange?: (rowId: DataTableRowId) => void;
}

export type DataTableVirtualizationReason = 'disabled' | 'variable-row-height';

export interface DataTableVirtualizationContext {
  options?: DataTableVirtualizationOptions;
  rowCount: number;
  scrollTop: number;
  /** Expansion and body group rows produce variable heights and disable the window. */
  hasVariableRowHeight?: boolean;
  /** Structural header rows, including grouped headers. Excluded from the window. */
  headerRowCount?: number;
  /** Structural summary rows. Excluded from the window. */
  summaryRowCount?: number;
}

export interface DataTableVirtualWindow {
  enabled: boolean;
  reason?: DataTableVirtualizationReason;
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalBodyHeight: number;
  headerRowCount: number;
  summaryRowCount: number;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `DataTable virtualization ${label} must be a non-negative integer`,
    );
  }
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `DataTable virtualization ${label} must be a positive finite number`,
    );
  }
}

function clampScrollTop(
  scrollTop: number,
  totalBodyHeight: number,
  viewportHeight: number,
): number {
  if (!Number.isFinite(scrollTop)) {
    throw new TypeError(
      'DataTable virtualization scrollTop must be a finite number',
    );
  }
  return Math.min(
    Math.max(0, scrollTop),
    Math.max(0, totalBodyHeight - viewportHeight),
  );
}

/**
 * Returns the maximum scroll position for a virtual body and an optional
 * measured summary footer. Header and caption height are outside this range.
 */
export function maximumDataTableVirtualScrollTop(
  rowCount: number,
  options: Pick<DataTableVirtualizationOptions, 'rowHeight' | 'viewportHeight'>,
  footerHeight = 0,
): number {
  assertNonNegativeInteger(rowCount, 'rowCount');
  assertPositiveFinite(options.rowHeight, 'rowHeight');
  assertPositiveFinite(options.viewportHeight, 'viewportHeight');
  if (!Number.isFinite(footerHeight) || footerHeight < 0) {
    throw new TypeError(
      'DataTable virtualization footerHeight must be a non-negative finite number',
    );
  }
  return Math.max(
    0,
    rowCount * options.rowHeight - options.viewportHeight + footerHeight,
  );
}

function staticWindow(
  rowCount: number,
  reason: DataTableVirtualizationReason,
  headerRowCount: number,
  summaryRowCount: number,
): DataTableVirtualWindow {
  return {
    enabled: false,
    reason,
    startIndex: 0,
    endIndex: rowCount,
    topSpacerHeight: 0,
    bottomSpacerHeight: 0,
    totalBodyHeight: 0,
    headerRowCount,
    summaryRowCount,
  };
}

/**
 * Resolves the renderable data-row window without using source order as an
 * identity. The caller retains the rows and slices by the returned indexes.
 */
export function resolveDataTableVirtualWindow(
  context: DataTableVirtualizationContext,
): DataTableVirtualWindow {
  const {
    options,
    rowCount,
    scrollTop,
    hasVariableRowHeight = false,
    headerRowCount = 0,
    summaryRowCount = 0,
  } = context;
  assertNonNegativeInteger(rowCount, 'rowCount');
  assertNonNegativeInteger(headerRowCount, 'headerRowCount');
  assertNonNegativeInteger(summaryRowCount, 'summaryRowCount');

  if (!options) {
    return staticWindow(rowCount, 'disabled', headerRowCount, summaryRowCount);
  }

  const overscan = options.overscan ?? 3;
  assertPositiveFinite(options.rowHeight, 'rowHeight');
  assertPositiveFinite(options.viewportHeight, 'viewportHeight');
  assertNonNegativeInteger(overscan, 'overscan');

  if (hasVariableRowHeight) {
    return staticWindow(
      rowCount,
      'variable-row-height',
      headerRowCount,
      summaryRowCount,
    );
  }

  const totalBodyHeight = rowCount * options.rowHeight;
  const currentScrollTop = clampScrollTop(
    scrollTop,
    totalBodyHeight,
    options.viewportHeight,
  );
  const startIndex = Math.max(
    0,
    Math.floor(currentScrollTop / options.rowHeight) - overscan,
  );
  const endIndex = Math.min(
    rowCount,
    Math.ceil((currentScrollTop + options.viewportHeight) / options.rowHeight) +
      overscan,
  );

  return {
    enabled: true,
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * options.rowHeight,
    bottomSpacerHeight: (rowCount - endIndex) * options.rowHeight,
    totalBodyHeight,
    headerRowCount,
    summaryRowCount,
  };
}

/**
 * Returns the smallest fixed-height scroll position that reveals a stable row
 * index, clamped to the body extent. Callers resolve the index from `rowKey`.
 */
export function scrollTopForDataTableRow(
  rowIndex: number,
  rowCount: number,
  options: Pick<DataTableVirtualizationOptions, 'rowHeight' | 'viewportHeight'>,
  currentScrollTop = 0,
): number {
  assertNonNegativeInteger(rowIndex, 'rowIndex');
  assertNonNegativeInteger(rowCount, 'rowCount');
  if (rowIndex >= rowCount) {
    throw new RangeError(
      'DataTable virtualization rowIndex must reference a data row',
    );
  }
  assertPositiveFinite(options.rowHeight, 'rowHeight');
  assertPositiveFinite(options.viewportHeight, 'viewportHeight');

  const totalBodyHeight = rowCount * options.rowHeight;
  const current = clampScrollTop(
    currentScrollTop,
    totalBodyHeight,
    options.viewportHeight,
  );
  const rowTop = rowIndex * options.rowHeight;
  const rowBottom = rowTop + options.rowHeight;
  const next =
    rowTop < current
      ? rowTop
      : rowBottom > current + options.viewportHeight
        ? rowBottom - options.viewportHeight
        : current;
  return clampScrollTop(next, totalBodyHeight, options.viewportHeight);
}
