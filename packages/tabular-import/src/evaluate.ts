import {
  address,
  type Cell,
  range as parseA1Range,
  type Range,
  type Sheet,
  type Workbook,
} from '@happyvertical/spreadsheets';
import {
  coerceCell,
  describeCell,
  hasLeadingZeros,
  isBlankCell,
} from './coerce.js';
import { ImportRunError } from './errors.js';
import type { FindingSink } from './findings.js';
import { DEFAULT_MAX_WORK } from './limits.js';
import type { ImportPlan, PlanField, PlanTable } from './plan.js';

export interface PlannedRecord {
  /** Absolute sheet row the record came from (first one, for distinct tables). */
  sourceRow: number;
  /** Column and typed values by field key. Calculated and reference fields are absent. */
  values: Record<string, unknown>;
  /** Resolved-by-key references; a blank reference is absent. */
  references: Record<string, { table: string; key: unknown[] }>;
}

export interface EvaluatedTable {
  table: PlanTable;
  /** False when the source could not be read at all; `rows` is then empty. */
  readable: boolean;
  rows: PlannedRecord[];
  /** Data rows examined. */
  read: number;
  /** Rows left out: skipRows and rows with every mapped cell blank. */
  skipped: number;
  /** Rows refused by a finding; they never appear in `rows`. */
  rejected: number;
}

/** Highest occupied row of a sheet. Never cached: workbooks are mutable. */
export function lastOccupiedRow(sheet: Sheet): number {
  let last = 0;
  for (const [row] of sheet.cells.rows()) last = Math.max(last, row);
  return last;
}

type IndexedRows = Array<[number, ReadonlyMap<number, Cell>]>;

/** Spends work units against one ceiling; shared by every step of one import. */
export class WorkBudget {
  used = 0;

  constructor(readonly maxWork: number) {}

  charge(units: number): void {
    this.used += units;
    if (this.used > this.maxWork) {
      throw new ImportRunError(
        'work-over-limit',
        `Reading the workbook needs more than ${this.maxWork} units of work.`,
        { maxWork: this.maxWork },
      );
    }
  }
}

/**
 * State of one evaluation call: the occupied rows of each sheet, and the
 * lookups that do not depend on a row, resolved once. Nothing outlives the
 * call, so a workbook that changes between calls is always read afresh.
 */
class Evaluation {
  private readonly rows = new Map<Sheet, IndexedRows>();
  /** table key -> field key -> field. */
  readonly fields = new Map<string, Map<string, PlanField>>();
  /** Fields with choices -> their choices as a set. */
  readonly choiceSets = new Map<PlanField, ReadonlySet<string>>();

  constructor(
    plan: ImportPlan,
    readonly budget: WorkBudget,
  ) {
    for (const table of plan.tables) {
      budget.charge(1 + table.fields.length);
      const byKey = new Map<string, PlanField>();
      for (const field of table.fields) {
        byKey.set(field.key, field);
        if (field.choices) {
          budget.charge(field.choices.length);
          this.choiceSets.set(field, new Set(field.choices));
        }
      }
      this.fields.set(table.key, byKey);
    }
  }

  charge(units: number): void {
    this.budget.charge(units);
  }

  occupied(sheet: Sheet): IndexedRows {
    let known = this.rows.get(sheet);
    if (!known) {
      this.charge(sheet.cells.size);
      known = [...sheet.cells.rows()];
      this.rows.set(sheet, known);
    }
    return known;
  }
}

/** Index of the first entry whose row is at least `row`. */
function lowerBound(rows: IndexedRows, row: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid][0] < row) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The sheet columns a field reads from. */
export function fieldColumns(field: PlanField): number[] {
  const columns: number[] = [];
  if (field.column !== undefined) columns.push(field.column);
  if (field.reference) columns.push(...field.reference.columns);
  if (field.cachedColumn !== undefined) columns.push(field.cachedColumn);
  return columns;
}

function digitsAsNumber(cell: Cell | undefined): string | undefined {
  if (!cell) return undefined;
  let text: string | undefined;
  if (cell.type === 'text' && typeof cell.value === 'string') {
    text = cell.value.trim();
  } else if (cell.type === 'number' && typeof cell.value === 'number') {
    text = cell.originalText;
    if (text === undefined) {
      return Number.isInteger(cell.value) && Math.abs(cell.value) >= 1e15
        ? String(cell.value)
        : undefined;
    }
  }
  if (text === undefined || !/^[+-]?\d+$/.test(text)) return undefined;
  const digits = text.replace(/^[+-]/, '');
  if (digits.length >= 16) return text;
  if (hasLeadingZeros(text)) return text;
  return undefined;
}

function keyText(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

/**
 * Reads every table of the plan from the workbook, typing each cell. Findings
 * go to the sink; refused rows are counted and dropped.
 */
export function evaluatePlan(
  plan: ImportPlan,
  workbook: Workbook,
  sink: FindingSink,
  budget: WorkBudget = new WorkBudget(DEFAULT_MAX_WORK),
): Map<string, EvaluatedTable> {
  const evaluation = new Evaluation(plan, budget);
  const result = new Map<string, EvaluatedTable>();
  for (const table of plan.tables) {
    result.set(table.key, evaluateTable(table, workbook, sink, evaluation));
  }
  return result;
}

function evaluateTable(
  table: PlanTable,
  workbook: Workbook,
  sink: FindingSink,
  evaluation: Evaluation,
): EvaluatedTable {
  const out: EvaluatedTable = {
    table,
    readable: false,
    rows: [],
    read: 0,
    skipped: 0,
    rejected: 0,
  };
  const { sheet: sheetName, range: a1, headerRow } = table.source;
  const sheet = workbook.sheets.find(
    (candidate) => candidate.name === sheetName,
  );
  if (!sheet) {
    sink.add({
      code: 'sheet-missing',
      severity: 'error',
      table: table.key,
      sheet: sheetName,
      message: `Sheet "${sheetName}" is not in the workbook.`,
    });
    return out;
  }
  let box: Range;
  try {
    box = parseA1Range(a1);
  } catch {
    sink.add({
      code: 'range-invalid',
      severity: 'error',
      table: table.key,
      sheet: sheetName,
      message: `Range "${a1}" is not a valid A1 range.`,
    });
    return out;
  }
  let structural = false;
  if (headerRow < box.start.row || headerRow > box.end.row) {
    structural = true;
    sink.add({
      code: 'header-outside-range',
      severity: 'error',
      table: table.key,
      sheet: sheetName,
      row: headerRow,
      message: `Header row ${headerRow} is outside ${a1}.`,
    });
  }
  for (const field of table.fields) {
    for (const column of fieldColumns(field)) {
      if (column < box.start.col || column > box.end.col) {
        structural = true;
        sink.add({
          code: 'column-outside-range',
          severity: 'error',
          table: table.key,
          field: field.key,
          sheet: sheetName,
          column,
          message: `Column ${column} of field "${field.key}" is outside ${a1}.`,
        });
      }
    }
  }
  if (structural) return out;
  out.readable = true;

  const skip = new Set(table.source.skipRows ?? []);
  const first = Math.max(headerRow + 1, box.start.row);
  const occupiedRows = evaluation.occupied(sheet);
  const lastRow =
    occupiedRows.length > 0 ? occupiedRows[occupiedRows.length - 1][0] : 0;
  const last = Math.min(box.end.row, lastRow);
  const total = Math.max(0, last - first + 1);
  const mapped = new Set(table.fields.flatMap(fieldColumns));
  const readFields = table.fields.filter(
    (field) => field.column !== undefined || field.reference,
  );
  // Cached calculated cells also establish row presence.
  const sources = [...mapped];
  evaluation.charge(1 + table.fields.length + mapped.size);
  // Everything that does not depend on the row is resolved here, once.
  const keyFieldsOf = new Map<PlanField, Array<PlanField | undefined>>();
  for (const field of readFields) {
    if (!field.reference) continue;
    const target = evaluation.fields.get(field.reference.table);
    keyFieldsOf.set(
      field,
      field.reference.by.map((key) => target?.get(key)),
    );
  }
  const seen = new Set<string>();
  const unmapped = new Map<number, { count: number; formula: boolean }>();

  // Only occupied rows are visited; the empty rows between are counted, not walked.
  let occupied = 0;
  for (
    let at = lowerBound(occupiedRows, first);
    at < occupiedRows.length && occupiedRows[at][0] <= last;
    at++
  ) {
    const [row, rowCells] = occupiedRows[at];
    occupied++;
    evaluation.charge(1 + rowCells.size + sources.length);
    if (skip.has(row)) {
      out.skipped++;
      continue;
    }
    // Columns nothing maps: remember what they hold, for one warning each.
    // A distinct table is an extraction of some columns, so the rest are expected.
    for (const [column, cell] of rowCells) {
      if (
        table.source.distinct ||
        mapped.has(column) ||
        column < box.start.col ||
        column > box.end.col
      ) {
        continue;
      }
      if (isBlankCell(cell)) continue;
      const entry = unmapped.get(column) ?? { count: 0, formula: false };
      entry.count++;
      if (cell.formula) entry.formula = true;
      unmapped.set(column, entry);
    }
    if (sources.every((column) => isBlankCell(rowCells.get(column)))) {
      out.skipped++;
      continue;
    }

    const record: PlannedRecord = {
      sourceRow: row,
      values: {},
      references: {},
    };
    let refused = false;
    const refuse = (
      code:
        | 'coerce-failed'
        | 'required-blank'
        | 'digits-as-number'
        | 'reference-unresolved',
      field: PlanField,
      column: number,
      message: string,
      expected: string,
    ): void => {
      refused = true;
      const cell = sheet.cells.get(row, column);
      sink.add({
        code,
        severity: 'error',
        table: table.key,
        field: field.key,
        sheet: sheetName,
        cell: address({ row, col: column }),
        row,
        expected,
        actual: describeCell(cell),
        message,
      });
    };

    for (const field of readFields) {
      if (field.reference) {
        const parts: unknown[] = [];
        let blanks = 0;
        let failed = false;
        const keyFields = keyFieldsOf.get(field) ?? [];
        field.reference.columns.forEach((column, index) => {
          const keyField = keyFields[index];
          const cell = rowCells.get(column);
          if (!keyField) {
            failed = true;
            return;
          }
          const coerced = coerceCell(
            cell,
            keyField,
            evaluation.choiceSets.get(keyField),
          );
          if (!coerced.ok) {
            failed = true;
            refuse(
              'coerce-failed',
              field,
              column,
              `Row ${row}: ${coerced.detail} [${coerced.code}]`,
              keyField.type,
            );
            return;
          }
          if (coerced.value === null) blanks++;
          parts.push(coerced.value);
        });
        if (failed) continue;
        if (blanks === parts.length) {
          if (field.required) {
            refuse(
              'required-blank',
              field,
              field.reference.columns[0],
              `Row ${row}: "${field.key}" is required.`,
              'a value',
            );
          }
          continue;
        }
        if (blanks > 0) {
          refuse(
            'reference-unresolved',
            field,
            field.reference.columns[0],
            `Row ${row}: the key for "${field.key}" is partly blank.`,
            field.reference.table,
          );
          continue;
        }
        record.references[field.key] = {
          table: field.reference.table,
          key: parts,
        };
        continue;
      }
      const column = field.column as number;
      const cell = rowCells.get(column);
      if (field.type === 'number' || field.type === 'integer') {
        const digits = digitsAsNumber(cell);
        if (digits !== undefined) {
          refuse(
            'digits-as-number',
            field,
            column,
            `Row ${row}: "${digits}" looks like an identifier; map "${field.key}" as text.`,
            'text',
          );
          continue;
        }
      }
      const coerced = coerceCell(cell, field, evaluation.choiceSets.get(field));
      if (!coerced.ok) {
        refuse(
          'coerce-failed',
          field,
          column,
          `Row ${row}: ${coerced.detail} [${coerced.code}]`,
          field.type,
        );
        continue;
      }
      if (coerced.value === null && field.required) {
        refuse(
          'required-blank',
          field,
          column,
          `Row ${row}: "${field.key}" is required.`,
          'a value',
        );
        continue;
      }
      record.values[field.key] = coerced.value;
    }
    if (refused) {
      out.rejected++;
      continue;
    }
    if (table.source.distinct) {
      const identity = keyText(
        readFields.map((field) =>
          field.reference
            ? (record.references[field.key]?.key ?? null)
            : (record.values[field.key] ?? null),
        ),
      );
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    out.rows.push(record);
  }
  evaluation.charge(unmapped.size);
  out.read = total;
  out.skipped += total - occupied;

  const headerLabel = (column: number): string =>
    describeCell(sheet.cells.get(headerRow, column));
  for (const [column, entry] of [...unmapped].sort(([a], [b]) => a - b)) {
    if (entry.formula) continue;
    sink.add({
      code: 'unmapped-column',
      severity: 'warning',
      table: table.key,
      sheet: sheetName,
      cell: address({ row: headerRow, col: column }),
      column,
      actual: headerLabel(column),
      message: `Column ${column} ("${headerLabel(column)}") holds ${entry.count} values that no field uses.`,
    });
  }
  return out;
}

export { keyText };
