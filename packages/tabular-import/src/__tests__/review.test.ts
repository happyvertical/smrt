import { createSheet, createWorkbook } from '@happyvertical/spreadsheets';
import { describe, expect, it } from 'vitest';
import {
  type AggregateOperand,
  checkPlan,
  type ImportPlan,
  runImport,
} from '../index.js';
import { createSqliteReferenceTarget } from '../testing.js';
import { cellOf, planOf, sheetOf, workbookOf } from './helpers.js';

const col = (name: string): AggregateOperand => ({ col: name });
const lit = (value: number): AggregateOperand => ({ value });

describe('sparse workbooks stay inside the work bound', () => {
  const sparse = () => {
    const sheet = createSheet('Wide');
    sheet.cells.set(1, 1, cellOf('Name') as never);
    sheet.cells.set(2, 1, cellOf('Ada') as never);
    sheet.cells.set(10001, 16384, cellOf('far away') as never);
    return createWorkbook([sheet]);
  };
  const tables = (count: number): ImportPlan =>
    planOf(
      Array.from({ length: count }, (_, i) => ({
        key: `t${i}`,
        label: `T${i}`,
        source: { sheet: 'Wide', range: 'A1:XFD10001', headerRow: 1 },
        fields: [
          { key: 'name', label: 'Name', type: 'text' as const, column: 1 },
        ],
      })),
    );

  it('reads a one-row table out of a 164-million-cell range without walking it', () => {
    const started = performance.now();
    const result = checkPlan(tables(1), sparse(), undefined, { maxWork: 100 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.facts.tables.t0).toEqual({
      read: 10000,
      skipped: 9999,
      rejected: 0,
      planned: 1,
    });
    expect(result.findings).toMatchObject([
      { code: 'unmapped-column', column: 16384, count: 1 },
    ]);
  });

  it('finishes 200 such tables inside a small budget', () => {
    const started = performance.now();
    const result = checkPlan(tables(200), sparse(), undefined, {
      maxWork: 10_000,
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(Object.keys(result.facts.tables)).toHaveLength(200);
    expect(result.ok).toBe(true);
  });

  it('refuses, typed, when the budget is spent', async () => {
    expect(() =>
      checkPlan(tables(200), sparse(), undefined, { maxWork: 50 }),
    ).toThrowError(
      expect.objectContaining({
        name: 'ImportRunError',
        code: 'work-over-limit',
      }),
    );
    await expect(
      runImport({
        plan: tables(2),
        workbook: sparse(),
        target: undefined as never,
        limits: { maxWork: 5 },
      }),
    ).rejects.toMatchObject({ code: 'work-over-limit' });
  });
});

describe('a workbook that changes between calls is read afresh', () => {
  it('loads rows appended after checkPlan', async () => {
    const sheet = sheetOf('S', [['Name'], ['a'], ['b']]);
    const workbook = workbookOf(sheet);
    const plan = planOf([
      {
        key: 't',
        label: 'T',
        source: { sheet: 'S', range: 'A1:A10', headerRow: 1 },
        fields: [{ key: 'name', label: 'Name', type: 'text', column: 1 }],
      },
    ]);
    expect(checkPlan(plan, workbook).facts.tables.t.planned).toBe(2);
    sheet.cells.set(4, 1, cellOf('c') as never);
    sheet.cells.set(5, 1, cellOf('d') as never);
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({ plan, workbook, target });
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.loaded).toEqual({ t: 4 });
      expect(await target.count('t')).toBe(4);
    } finally {
      await target.close();
    }
  });
});

describe('calculated values are checked without a cached column', () => {
  const run = async (
    type: 'integer' | 'money',
    expression: AggregateOperand,
    input: number,
  ) => {
    const plan = planOf([
      {
        key: 't',
        label: 'T',
        source: { sheet: 'S', range: 'A1:A2', headerRow: 1 },
        fields: [
          { key: 'x', label: 'X', type: 'integer', column: 1 },
          {
            key: 'y',
            label: 'Y',
            type,
            calculated: expression,
            ...(type === 'money'
              ? { money: { currency: 'USD', scale: 2 } }
              : {}),
          },
        ],
      },
    ]);
    const target = await createSqliteReferenceTarget();
    try {
      return await runImport({
        plan,
        workbook: workbookOf(sheetOf('S', [['X'], [input]])),
        target,
      });
    } finally {
      await target.close();
    }
  };

  it('flags an unsafe integer product', async () => {
    const result = await run(
      'integer',
      { op: 'mul', left: col('x'), right: lit(1_000_000_000) },
      1_000_000_000,
    );
    expect(result.ok).toBe(false);
    expect(result.findings).toMatchObject([
      {
        code: 'calculated-invalid',
        severity: 'error',
        table: 't',
        field: 'y',
        row: 2,
      },
    ]);
    expect(result.findings[0].message).toContain('safe integer');
  });

  it('flags a fractional result in an integer or money field', async () => {
    for (const type of ['integer', 'money'] as const) {
      const result = await run(
        type,
        { op: 'div', left: col('x'), right: lit(2) },
        1,
      );
      expect(result.ok).toBe(false);
      expect(result.findings).toMatchObject([
        { code: 'calculated-invalid', field: 'y', actual: 0.5 },
      ]);
    }
  });

  it('accepts whole results', async () => {
    const result = await run(
      'integer',
      { op: 'add', left: col('x'), right: lit(1) },
      1,
    );
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('integer and money comparisons are exact', () => {
  it('does not let a relative tolerance hide a difference of 100 in a trillion', async () => {
    const plan = planOf([
      {
        key: 't',
        label: 'T',
        source: { sheet: 'S', range: 'A1:B2', headerRow: 1 },
        fields: [
          { key: 'x', label: 'X', type: 'integer', column: 1 },
          {
            key: 'y',
            label: 'Y',
            type: 'integer',
            calculated: { op: 'add', left: col('x'), right: lit(100) },
            cachedColumn: 2,
          },
        ],
      },
    ]);
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({
        plan,
        workbook: workbookOf(
          sheetOf('S', [
            ['X', 'Y'],
            [1_000_000_000_000, 1_000_000_000_000],
          ]),
        ),
        target,
      });
      expect(result.ok).toBe(false);
      expect(result.findings).toMatchObject([
        {
          code: 'calculated-mismatch',
          cell: 'B2',
          row: 2,
          expected: '1000000000000',
          actual: 1_000_000_000_100,
        },
      ]);
    } finally {
      await target.close();
    }
  });
});
