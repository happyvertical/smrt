import {
  type Cell,
  createSheet,
  createWorkbook,
  type Sheet,
  type Workbook,
} from '@happyvertical/spreadsheets';
import type { ImportPlan } from '../plan.js';

/** A formula cell with the result the workbook cached for it. */
export interface FormulaValue {
  formula: string;
  value: string | number | boolean | Date | null;
}

export type CellSpec =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | FormulaValue;

function isFormula(spec: CellSpec): spec is FormulaValue {
  return typeof spec === 'object' && spec !== null && !(spec instanceof Date);
}

export function cellOf(spec: CellSpec): Cell | undefined {
  if (spec === null || spec === undefined) return undefined;
  if (isFormula(spec)) {
    const base = cellOf(spec.value) ?? { value: null, type: 'empty' as const };
    return {
      ...base,
      formula: {
        text: spec.formula,
        dialect: 'excel-a1',
        references: [],
        functions: [],
      },
    };
  }
  if (typeof spec === 'string') return { value: spec, type: 'text' };
  if (typeof spec === 'number') return { value: spec, type: 'number' };
  if (typeof spec === 'boolean') return { value: spec, type: 'boolean' };
  return {
    value: spec,
    type: 'date',
    numberFormat: 'yyyy-mm-dd',
    formatKind: 'date',
  };
}

/** Rows of cell specs, starting at A1. */
export function sheetOf(name: string, rows: CellSpec[][]): Sheet {
  const sheet = createSheet(name);
  for (const [r, row] of rows.entries()) {
    for (const [c, spec] of row.entries()) {
      const cell = cellOf(spec);
      if (cell) sheet.cells.set(r + 1, c + 1, cell);
    }
  }
  return sheet;
}

export function workbookOf(...sheets: Sheet[]): Workbook {
  return createWorkbook(sheets);
}

export const day = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

export function planOf(tables: ImportPlan['tables']): ImportPlan {
  return { version: 1, tables };
}
