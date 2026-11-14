/**
 * PROVISIONAL (owner decision pending): the most cells a workbook may hold
 * before an import is refused. One named constant so the decision is one edit.
 */
export const DEFAULT_MAX_CELLS = 250_000;

export const DEFAULT_MAX_ROWS_PER_TABLE = 10_000;

/**
 * Units of work one evaluation may spend: one per occupied cell indexed, plus
 * one per occupied row and mapped column read. Bounds synchronous time for any
 * plan and workbook the other limits admit.
 */
export const DEFAULT_MAX_WORK = 20_000_000;

export interface ImportLimits {
  maxCells: number;
  maxRowsPerTable: number;
  maxWork: number;
}

export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  maxCells: DEFAULT_MAX_CELLS,
  maxRowsPerTable: DEFAULT_MAX_ROWS_PER_TABLE,
  maxWork: DEFAULT_MAX_WORK,
});
