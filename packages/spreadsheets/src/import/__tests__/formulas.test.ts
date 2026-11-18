import { createSheet, createWorkbook } from '@happyvertical/spreadsheets';
import { expect, it } from 'vitest';
import {
  IMPORT_PLAN_EXAMPLES,
  untranslatedFormulas,
  validatePlan,
} from '../index.js';

it('audits only plain mapped formula cells in the selected data, bounding examples and text', () => {
  const sheet = createSheet('Orders');
  for (let row = 1; row < 50; row++)
    sheet.cells.set(row, 6, {
      value: 25,
      type: 'number',
      formula: {
        text: 'X'.repeat(700),
        dialect: 'excel-a1',
        references: [],
        functions: [],
      },
    });
  const plan = validatePlan(IMPORT_PLAN_EXAMPLES[0]);
  expect(untranslatedFormulas(plan, createWorkbook([sheet]))).toEqual([]);
  const total = plan.tables[0].fields[2];
  delete total.calculated;
  delete total.cachedColumn;
  total.column = 6;
  plan.tables[0].source.skipRows = [5];
  const result = untranslatedFormulas(plan, createWorkbook([sheet]));
  expect(result).toMatchObject([
    { table: 'orders', field: 'total', sheet: 'Orders', column: 6, count: 41 },
  ]);
  expect(result[0].examples).toHaveLength(20);
  expect(result[0].examples[0]).toEqual({
    cell: 'F6',
    formula: 'X'.repeat(500),
  });
});
