import { describe, expect, it, vi } from 'vitest';
import {
  admit,
  checkPlan,
  DEFAULT_MAX_CELLS,
  DEFAULT_MAX_ROWS_PER_TABLE,
  runImport,
} from '../index.js';
import { createSqliteReferenceTarget } from '../testing.js';
import { type CellSpec, planOf, sheetOf, workbookOf } from './helpers.js';

const bigPlan = (rows: number) =>
  planOf([
    {
      key: 'big',
      label: 'Big',
      source: { sheet: 'Big', range: `A1:B${rows + 1}`, headerRow: 1 },
      lookupKey: ['id'],
      fields: [
        { key: 'id', label: 'Id', type: 'integer', column: 1, required: true },
        { key: 'name', label: 'Name', type: 'text', column: 2 },
      ],
    },
  ]);

const bigRows = (rows: number): CellSpec[][] => [
  ['Id', 'Name'],
  ...Array.from({ length: rows }, (_, i): CellSpec[] => [
    i + 1,
    `row ${i + 1}`,
  ]),
];

describe('admission', () => {
  it('names the defaults', () => {
    expect(DEFAULT_MAX_CELLS).toBe(250_000);
    expect(DEFAULT_MAX_ROWS_PER_TABLE).toBe(10_000);
  });

  it('refuses too many cells before reading any row', async () => {
    const workbook = workbookOf(sheetOf('Big', bigRows(60)));
    const get = vi.spyOn(workbook.sheets[0].cells, 'get');
    expect(() => admit(workbook, { maxCells: 100 })).toThrowError(
      expect.objectContaining({
        name: 'ImportRunError',
        code: 'cells-over-limit',
      }),
    );
    const target = await createSqliteReferenceTarget();
    try {
      await expect(
        runImport({
          plan: bigPlan(60),
          workbook,
          target,
          limits: { maxCells: 100 },
        }),
      ).rejects.toMatchObject({ code: 'cells-over-limit' });
      expect(get).not.toHaveBeenCalled();
      expect(await target.describe()).toEqual({ tables: [] });
    } finally {
      await target.close();
    }
  });

  it('refuses too many rows in a table before reading any row', async () => {
    const workbook = workbookOf(sheetOf('Big', bigRows(60)));
    const get = vi.spyOn(workbook.sheets[0].cells, 'get');
    expect(() =>
      admit(workbook, { maxRowsPerTable: 50 }, bigPlan(60)),
    ).toThrowError(
      expect.objectContaining({
        code: 'rows-over-limit',
        detail: { maxRowsPerTable: 50, rows: 60 },
      }),
    );
    expect(() => admit(workbook, { maxRowsPerTable: 50 })).toThrowError(
      expect.objectContaining({ code: 'rows-over-limit' }),
    );
    await expect(
      runImport({
        plan: bigPlan(60),
        workbook,
        target: undefined as never,
        limits: { maxRowsPerTable: 50 },
      }),
    ).rejects.toMatchObject({ code: 'rows-over-limit' });
    expect(get).not.toHaveBeenCalled();
  });

  it('admits a workbook at the limit', () => {
    const workbook = workbookOf(sheetOf('Big', bigRows(60)));
    expect(() =>
      admit(workbook, { maxRowsPerTable: 60, maxCells: 122 }, bigPlan(60)),
    ).not.toThrow();
  });
});

describe('a table of 10,000 rows', () => {
  it('checks, loads and proves within the default timeout', async () => {
    const rows = DEFAULT_MAX_ROWS_PER_TABLE;
    const workbook = workbookOf(sheetOf('Big', bigRows(rows)));
    const plan = bigPlan(rows);
    expect(checkPlan(plan, workbook).facts.tables.big.planned).toBe(rows);
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({ plan, workbook, target });
      expect(result.findings).toEqual([]);
      expect(result.loaded).toEqual({ big: rows });
      expect(await target.sum('big', 'id')).toBe((rows * (rows + 1)) / 2);
    } finally {
      await target.close();
    }
  });
});
