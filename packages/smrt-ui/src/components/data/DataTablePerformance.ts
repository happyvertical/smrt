/**
 * Published, testable scale guidance for the DataTable pipeline.
 *
 * These are interaction thresholds, not hard data limits. Use the benchmark
 * fixture before raising them for a new renderer, browser target, or cell shape.
 */
export const DATA_TABLE_SCALE_THRESHOLDS = {
  localRender: {
    maxRows: 250,
    maxCells: 5_000,
    recommendation:
      'Use normal semantic rendering for ordinary, bounded result sets.',
  },
  clientTransforms: {
    maxRows: 1_000,
    maxCells: 20_000,
    recommendation:
      'Use manual filtering, sorting, or paging once a client transform exceeds this budget.',
  },
  manualPaging: {
    recommendedPageSize: 100,
    maxRenderedRows: 250,
    recommendation:
      'Keep remote pages bounded and pass totalRows only for a known server total.',
  },
  virtualization: {
    minRows: 250,
    recommendation:
      'Use fixed-height virtualization for continuous browsing above the local render budget; preserve stable rowKey values and retain remote paging for unbounded data.',
  },
} as const;

export type DataTableScaleStrategy =
  | 'local'
  | 'manual-paging'
  | 'virtualization';

/** Returns the recommended rendering strategy for a known row and column count. */
export function recommendDataTableScaleStrategy(
  rowCount: number,
  columnCount: number,
): DataTableScaleStrategy {
  if (
    !Number.isInteger(rowCount) ||
    !Number.isInteger(columnCount) ||
    rowCount < 0 ||
    columnCount < 0
  ) {
    throw new TypeError('DataTable scale counts must be non-negative integers');
  }

  const cells = rowCount * columnCount;
  if (
    rowCount <= DATA_TABLE_SCALE_THRESHOLDS.localRender.maxRows &&
    cells <= DATA_TABLE_SCALE_THRESHOLDS.localRender.maxCells
  ) {
    return 'local';
  }
  if (
    rowCount > DATA_TABLE_SCALE_THRESHOLDS.clientTransforms.maxRows ||
    cells > DATA_TABLE_SCALE_THRESHOLDS.clientTransforms.maxCells
  ) {
    return 'manual-paging';
  }
  return 'virtualization';
}
