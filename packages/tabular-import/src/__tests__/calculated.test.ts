// biome-ignore-all lint/suspicious/noThenProperty: IF nodes are closed data, not thenable functions.
import { describe, expect, it } from 'vitest';
import type { AggregateOperand } from '../index.js';
import { runImport } from '../index.js';
import { createSqliteReferenceTarget } from '../testing.js';
import { planOf, sheetOf, workbookOf } from './helpers.js';

const col = (name: string): AggregateOperand => ({ col: name });
const lit = (value: number | string): AggregateOperand => ({ value });

const fields = (lineTotal: AggregateOperand) => [
  { key: 'quantity', label: 'Quantity', type: 'integer' as const, column: 1 },
  {
    key: 'price',
    label: 'Price',
    type: 'money' as const,
    column: 2,
    money: { currency: 'USD', scale: 2 },
  },
  {
    key: 'line_total',
    label: 'Line total',
    type: 'money' as const,
    calculated: lineTotal,
    cachedColumn: 3,
    money: { currency: 'USD', scale: 2 },
  },
  {
    key: 'size',
    label: 'Size',
    type: 'text' as const,
    calculated: {
      op: 'if',
      condition: { op: 'gte', left: col('quantity'), right: lit(10) },
      then: lit('bulk'),
      else: lit('single'),
    } as AggregateOperand,
    cachedColumn: 4,
  },
  {
    key: 'half_price',
    label: 'Half price',
    type: 'number' as const,
    calculated: {
      op: 'round',
      value: { op: 'div', left: col('price'), right: lit(200) },
      digits: lit(1),
    } as AggregateOperand,
    cachedColumn: 5,
  },
];

const table = (lineTotal: AggregateOperand) =>
  planOf([
    {
      key: 'lines',
      label: 'Lines',
      source: { sheet: 'Lines', range: 'A1:E4', headerRow: 1 },
      fields: fields(lineTotal),
    },
  ]);

const formula = (text: string, value: number | string) => ({
  formula: text,
  value,
});

const workbook = () =>
  workbookOf(
    sheetOf('Lines', [
      ['Quantity', 'Price', 'Line total', 'Size', 'Half price'],
      [
        2,
        9.99,
        formula('A2*B2', 19.98),
        formula('IF(A2>=10,"bulk","single")', 'single'),
        formula('ROUND(B2/2,1)', 5),
      ],
      [
        12,
        1.5,
        formula('A3*B3', 18),
        formula('IF(A3>=10,"bulk","single")', 'bulk'),
        formula('ROUND(B3/2,1)', 0.8),
      ],
      [
        3,
        20,
        formula('A4*B4', 60),
        formula('IF(A4>=10,"bulk","single")', 'single'),
        formula('ROUND(B4/2,1)', 10),
      ],
    ]),
  );

describe('calculated columns', () => {
  it('proves translated formulas against the workbook cache', async () => {
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({
        plan: table({ op: 'mul', left: col('quantity'), right: col('price') }),
        workbook: workbook(),
        target,
      });
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      const rows: unknown[] = [];
      for await (const row of target.values('lines', [
        'line_total',
        'size',
        'half_price',
      ])) {
        rows.push(row);
      }
      expect(rows).toEqual([
        {
          sourceRow: 2,
          values: { line_total: 1998, size: 'single', half_price: 5 },
        },
        {
          sourceRow: 3,
          values: { line_total: 1800, size: 'bulk', half_price: 0.8 },
        },
        {
          sourceRow: 4,
          values: { line_total: 6000, size: 'single', half_price: 10 },
        },
      ]);
    } finally {
      await target.close();
    }
  });

  it('reports a wrong expression at the exact cell', async () => {
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({
        plan: table({ op: 'add', left: col('quantity'), right: col('price') }),
        workbook: workbook(),
        target,
      });
      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        {
          code: 'calculated-mismatch',
          severity: 'error',
          table: 'lines',
          field: 'line_total',
          sheet: 'Lines',
          cell: 'C2',
          row: 2,
          expected: '19.98',
          actual: 1001,
          count: 3,
          message:
            'Row 2: "line_total" is 1001 in the target; the workbook cached 19.98.',
        },
        {
          code: 'calculated-mismatch',
          severity: 'error',
          table: 'lines',
          field: 'line_total',
          sheet: 'Lines',
          cell: 'C3',
          row: 3,
          expected: '18',
          actual: 162,
          count: 3,
          message:
            'Row 3: "line_total" is 162 in the target; the workbook cached 18.',
        },
        {
          code: 'calculated-mismatch',
          severity: 'error',
          table: 'lines',
          field: 'line_total',
          sheet: 'Lines',
          cell: 'C4',
          row: 4,
          expected: '60',
          actual: 2003,
          count: 3,
          message:
            'Row 4: "line_total" is 2003 in the target; the workbook cached 60.',
        },
      ]);
    } finally {
      await target.close();
    }
  });
});
