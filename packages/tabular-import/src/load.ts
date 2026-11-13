import type { Workbook } from '@happyvertical/spreadsheets';
import { range as parseA1Range } from '@happyvertical/spreadsheets';
import { ImportRunError } from './errors.js';
import {
  type EvaluatedTable,
  evaluatePlan,
  lastOccupiedRow,
  type PlannedRecord,
} from './evaluate.js';
import { FindingSink } from './findings.js';
import { type ImportPlan, loadOrder } from './plan.js';

/**
 * PROVISIONAL (owner decision pending): the most cells a workbook may hold
 * before an import is refused. One named constant so the decision is one edit.
 */
export const DEFAULT_MAX_CELLS = 250_000;

export const DEFAULT_MAX_ROWS_PER_TABLE = 10_000;

export const DEFAULT_BATCH_SIZE = 500;

export interface ImportLimits {
  maxCells: number;
  maxRowsPerTable: number;
}

export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  maxCells: DEFAULT_MAX_CELLS,
  maxRowsPerTable: DEFAULT_MAX_ROWS_PER_TABLE,
});

export type LoadRecord = PlannedRecord;

export interface LoadBatch {
  table: string;
  /** Position of this batch within its table, from 0. */
  index: number;
  records: LoadRecord[];
}

export interface LoadPlan {
  /** Table keys, referenced tables first. */
  order: string[];
  batches(): Iterable<LoadBatch>;
}

/**
 * Refuses a workbook that is too big, before any row is read or written.
 * With a plan, rows are counted per planned table; without one, per sheet.
 */
export function admit(
  workbook: Workbook,
  limits: Partial<ImportLimits> = {},
  plan?: ImportPlan,
): void {
  const { maxCells, maxRowsPerTable }: ImportLimits = {
    ...DEFAULT_IMPORT_LIMITS,
    ...limits,
  };
  let cells = 0;
  for (const sheet of workbook.sheets) {
    cells += sheet.cells.size;
    if (cells > maxCells) {
      throw new ImportRunError(
        'cells-over-limit',
        `The workbook holds more than ${maxCells} cells.`,
        { maxCells },
      );
    }
  }
  const over = (what: string, rows: number): never => {
    throw new ImportRunError(
      'rows-over-limit',
      `${what} holds ${rows} rows; the limit is ${maxRowsPerTable}.`,
      { maxRowsPerTable, rows },
    );
  };
  if (plan) {
    for (const table of plan.tables) {
      const sheet = workbook.sheets.find((s) => s.name === table.source.sheet);
      if (!sheet) continue;
      let box: ReturnType<typeof parseA1Range>;
      try {
        box = parseA1Range(table.source.range);
      } catch {
        continue;
      }
      const first = Math.max(table.source.headerRow + 1, box.start.row);
      const last = Math.min(box.end.row, lastOccupiedRow(sheet));
      const rows = last - first + 1;
      if (rows > maxRowsPerTable) over(`Table "${table.key}"`, rows);
    }
    return;
  }
  for (const sheet of workbook.sheets) {
    const rows = lastOccupiedRow(sheet);
    if (rows > maxRowsPerTable) over(`Sheet "${sheet.name}"`, rows);
  }
}

/**
 * Turns a plan and its workbook into batches of typed records. Referenced
 * tables come first; `distinct` tables keep each combination once, in first-seen
 * order; calculated fields are never in `values`; rows that failed to type were
 * errors in `checkPlan` and never appear.
 */
export function planLoad(
  plan: ImportPlan,
  workbook: Workbook,
  options: { batchSize?: number } = {},
): LoadPlan {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }
  const sink = new FindingSink();
  const tables = evaluatePlan(plan, workbook, sink);
  const unreadable = [...tables.values()].filter((t) => !t.readable);
  if (unreadable.length > 0) {
    throw new ImportRunError(
      'source-invalid',
      `The source of ${unreadable.map((t) => `"${t.table.key}"`).join(', ')} cannot be read; run checkPlan.`,
      { findings: sink.list().filter((f) => f.severity === 'error') },
    );
  }
  const order = loadOrder(plan);
  return {
    order,
    *batches(): Iterable<LoadBatch> {
      for (const key of order) {
        const evaluated = tables.get(key) as EvaluatedTable;
        for (
          let at = 0, index = 0;
          at < evaluated.rows.length;
          at += batchSize
        ) {
          yield {
            table: key,
            index: index++,
            records: evaluated.rows.slice(at, at + batchSize),
          };
        }
      }
    },
  };
}
