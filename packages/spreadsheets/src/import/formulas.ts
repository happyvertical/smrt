import { address, range, type Workbook } from '@happyvertical/spreadsheets';
import type { ImportPlan } from './plan.js';

export interface UntranslatedFormula {
  table: string;
  field: string;
  sheet: string;
  column: number;
  count: number;
  examples: { cell: string; formula: string }[];
}

/** Audit plain fields backed by cached formulas. No formula text enters a check event. */
export function untranslatedFormulas(
  plan: ImportPlan,
  workbook: Workbook,
): UntranslatedFormula[] {
  const result: UntranslatedFormula[] = [];
  for (const table of plan.tables) {
    const sheet = workbook.sheets.find((s) => s.name === table.source.sheet);
    if (!sheet) continue;
    const box = range(table.source.range),
      skips = new Set(table.source.skipRows ?? []);
    const fields = new Map(
      table.fields.filter((f) => f.column).map((f) => [f.column!, f]),
    );
    const groups = new Map<number, UntranslatedFormula>();
    for (const [point, cell] of sheet.cells) {
      const field = fields.get(point.col);
      if (
        !field ||
        !cell.formula ||
        point.row <= table.source.headerRow ||
        point.row < box.start.row ||
        point.row > box.end.row ||
        point.col < box.start.col ||
        point.col > box.end.col ||
        skips.has(point.row)
      )
        continue;
      let entry = groups.get(point.col);
      if (!entry) {
        entry = {
          table: table.key,
          field: field.key,
          sheet: sheet.name,
          column: point.col,
          count: 0,
          examples: [],
        };
        groups.set(point.col, entry);
        result.push(entry);
      }
      entry.count++;
      if (entry.examples.length < 20)
        entry.examples.push({
          cell: address(point),
          formula: cell.formula.text.slice(0, 500),
        });
    }
  }
  return result;
}
