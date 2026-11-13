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
import type { FindingSink } from './findings.js';
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

const extentCache = new WeakMap<Sheet, { rows: number; columns: number }>();

/** Highest occupied row and column of a sheet; one pass over sparse storage. */
function sheetExtent(sheet: Sheet): { rows: number; columns: number } {
  let known = extentCache.get(sheet);
  if (!known) {
    known = { rows: 0, columns: 0 };
    for (const [row, cells] of sheet.cells.rows()) {
      known.rows = Math.max(known.rows, row);
      for (const column of cells.keys()) {
        known.columns = Math.max(known.columns, column);
      }
    }
    extentCache.set(sheet, known);
  }
  return known;
}

export function lastOccupiedRow(sheet: Sheet): number {
  return sheetExtent(sheet).rows;
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
): Map<string, EvaluatedTable> {
  const tables = new Map(plan.tables.map((table) => [table.key, table]));
  const result = new Map<string, EvaluatedTable>();
  for (const table of plan.tables) {
    result.set(table.key, evaluateTable(table, tables, workbook, sink));
  }
  return result;
}

function evaluateTable(
  table: PlanTable,
  tables: ReadonlyMap<string, PlanTable>,
  workbook: Workbook,
  sink: FindingSink,
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
  const last = Math.min(box.end.row, lastOccupiedRow(sheet));
  const lastColumn = Math.min(box.end.col, sheetExtent(sheet).columns);
  const mapped = new Set(table.fields.flatMap(fieldColumns));
  const readFields = table.fields.filter(
    (field) => field.column !== undefined || field.reference,
  );
  const sources = readFields.flatMap((field) => [
    ...(field.column !== undefined ? [field.column] : []),
    ...(field.reference?.columns ?? []),
  ]);
  const seen = new Set<string>();
  const unmapped = new Map<number, { count: number; formula: boolean }>();

  for (let row = first; row <= last; row++) {
    out.read++;
    if (skip.has(row)) {
      out.skipped++;
      continue;
    }
    // Columns nothing maps: remember what they hold, for one warning each.
    // A distinct table is an extraction of some columns, so the rest are expected.
    for (let column = box.start.col; column <= lastColumn; column++) {
      if (table.source.distinct || mapped.has(column)) continue;
      const cell = sheet.cells.get(row, column);
      if (!cell || isBlankCell(cell)) continue;
      const entry = unmapped.get(column) ?? { count: 0, formula: false };
      entry.count++;
      if (cell.formula) entry.formula = true;
      unmapped.set(column, entry);
    }
    if (sources.every((column) => isBlankCell(sheet.cells.get(row, column)))) {
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
        field.reference.columns.forEach((column, index) => {
          const keyField = tables
            .get(field.reference?.table ?? '')
            ?.fields.find(
              (candidate) => candidate.key === field.reference?.by[index],
            );
          const cell = sheet.cells.get(row, column);
          if (!keyField) {
            failed = true;
            return;
          }
          const coerced = coerceCell(cell, keyField);
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
      const cell = sheet.cells.get(row, column);
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
      const coerced = coerceCell(cell, field);
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
