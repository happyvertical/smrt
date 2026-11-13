import { createSheet, createWorkbook } from '@happyvertical/spreadsheets';
import { describe, expect, it, vi } from 'vitest';
import {
  type AggregateOperand,
  checkPlan,
  type ImportPlan,
  type ImportTarget,
  runImport,
  validatePlan,
} from '../index.js';
import { createSqliteReferenceTarget } from '../testing.js';
import {
  type CellSpec,
  cellOf,
  planOf,
  sheetOf,
  workbookOf,
} from './helpers.js';

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

describe('per-row work is linear in the cells read', () => {
  const FIELDS = 40;
  const ROWS = 50;
  const fieldKeys = Array.from({ length: FIELDS }, (_, i) => `f${i}`);

  // A parent with many fields and its lookup key last; children point at it from every field.
  const shape = () => {
    const plan = validatePlan(
      planOf([
        {
          key: 'parent',
          label: 'Parent',
          source: { sheet: 'P', range: `A1:AN3`, headerRow: 1 },
          lookupKey: [fieldKeys[FIELDS - 1]],
          fields: fieldKeys.map((key, i) => ({
            key,
            label: key,
            type: 'text' as const,
            column: i + 1,
          })),
        },
        {
          key: 'child',
          label: 'Child',
          source: { sheet: 'C', range: `A1:AN${ROWS + 1}`, headerRow: 1 },
          fields: fieldKeys.map((key, i) => ({
            key: `r${i}`,
            label: key,
            type: 'reference' as const,
            reference: {
              table: 'parent',
              by: [fieldKeys[FIELDS - 1]],
              columns: [i + 1],
            },
          })),
        },
      ]),
    );
    const header: CellSpec[] = fieldKeys.map((k) => k);
    const parentRows: CellSpec[][] = [header, fieldKeys.map(() => 'k1')];
    const childRows: CellSpec[][] = [
      header,
      ...Array.from({ length: ROWS }, () => fieldKeys.map(() => 'k1')),
    ];
    return {
      plan,
      workbook: workbookOf(sheetOf('P', parentRows), sheetOf('C', childRows)),
    };
  };

  it('resolves reference key fields once, not once per cell', () => {
    const { plan, workbook } = shape();
    const find = vi.spyOn(Array.prototype, 'find');
    try {
      const result = checkPlan(plan, workbook);
      expect(result.findings).toEqual([]);
      expect(result.facts.tables.child.planned).toBe(ROWS);
      // One search per table to find its sheet; none per cell (2,000 before).
      expect(find.mock.calls.length).toBeLessThan(20);
      // Work is charged per cell read and stays proportional to them.
      expect(result.work).toBeGreaterThanOrEqual(ROWS * FIELDS);
      expect(result.work).toBeLessThan(8 * ROWS * FIELDS);
    } finally {
      find.mockRestore();
    }
  });

  it('refuses over-large work before the target is touched', async () => {
    const { plan, workbook } = shape();
    const calls: string[] = [];
    const target = new Proxy({} as ImportTarget, {
      get: (_t, name) => () => {
        calls.push(String(name));
        throw new Error('the target must not be reached');
      },
    });
    await expect(
      runImport({
        plan,
        workbook,
        target,
        limits: { maxWork: (ROWS * FIELDS) / 2 },
      }),
    ).rejects.toMatchObject({ code: 'work-over-limit' });
    expect(calls).toEqual([]);
  });

  it('matches choices through a set, not a scan per cell', () => {
    const choices = Array.from({ length: 1000 }, (_, i) => `c${i}`);
    const plan = planOf([
      {
        key: 't',
        label: 'T',
        source: { sheet: 'S', range: 'A1:A301', headerRow: 1 },
        fields: [
          { key: 'pick', label: 'Pick', type: 'choice', column: 1, choices },
        ],
      },
    ]);
    const rows: CellSpec[][] = [
      ['Pick'],
      ...Array.from({ length: 300 }, (): CellSpec[] => ['c999']),
    ];
    const includes = vi.spyOn(Array.prototype, 'includes');
    try {
      const result = checkPlan(plan, workbookOf(sheetOf('S', rows)));
      expect(result.findings).toEqual([]);
      expect(result.facts.tables.t.planned).toBe(300);
      expect(includes.mock.calls.length).toBeLessThan(20);
    } finally {
      includes.mockRestore();
    }
  });
});
