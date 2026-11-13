import { createSheet, createWorkbook } from '@happyvertical/spreadsheets';
import { describe, expect, it, vi } from 'vitest';
import {
  type AggregateOperand,
  checkLoaded,
  checkPlan,
  type ImportPlan,
  ImportPlanError,
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

describe('calculated-only tables establish rows from their cached columns', () => {
  const plan = () =>
    planOf([
      {
        key: 't',
        label: 'T',
        source: { sheet: 'S', range: 'A1:B6', headerRow: 1 },
        fields: [
          {
            key: 'constant',
            label: 'Constant',
            type: 'number',
            calculated: lit(7),
            cachedColumn: 1,
          },
        ],
      },
    ]);

  it.each([
    7, 8,
  ])('loads formula rows and verifies a cache of %s', async (cached) => {
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({
        plan: plan(),
        workbook: workbookOf(
          sheetOf('S', [
            ['Constant', 'Unmapped'],
            [{ formula: '=7', value: cached }],
            [],
            [null, 'does not establish a row'],
            [{ formula: '=7', value: cached }],
            [{ formula: '=7', value: cached }],
          ]),
        ),
        target,
      });
      expect(result.loaded).toEqual({ t: 3 });
      expect(result.facts.tables.t).toMatchObject({ planned: 3, skipped: 2 });
      expect(await target.count('t')).toBe(3);
      expect(result.ok).toBe(cached === 7);
      const mismatches = result.findings.filter(
        (finding) => finding.code === 'calculated-mismatch',
      );
      expect(mismatches.map((finding) => finding.row)).toEqual(
        cached === 7 ? [] : [2, 5, 6],
      );
    } finally {
      await target.close();
    }
  });

  it('refuses a table with no column, reference column or cached column', () => {
    const input = plan();
    delete input.tables[0].fields[0].cachedColumn;
    expect(() => validatePlan(input)).toThrowError(ImportPlanError);
    expect(() => validatePlan(input)).toThrowError(
      expect.objectContaining({
        code: 'no-row-source',
        path: 'tables[0].fields',
      }),
    );
  });
});

describe('exact sums survive large intermediate totals', () => {
  it.each([
    'integer',
    'money',
  ] as const)('surfaces an unsafe final %s sum as a mismatch', async (type) => {
    const plan = planOf([
      {
        key: 't',
        label: 'T',
        source: { sheet: 'S', range: 'A1:A3', headerRow: 1 },
        fields: [
          {
            key: 'x',
            label: 'X',
            type,
            column: 1,
            ...(type === 'money'
              ? { money: { currency: 'USD', scale: 2 } }
              : {}),
          },
        ],
      },
    ]);
    const workbook = workbookOf(sheetOf('S', [['X'], [0], [0]]));
    const target = await createSqliteReferenceTarget();
    try {
      const loaded = await runImport({ plan, workbook, target });
      expect(loaded.ok).toBe(true);
      await target.db.query('UPDATE "t" SET "x" = 9000000000000000');
      expect(await target.sum('t', 'x')).toBe(18_000_000_000_000_000n);
      const verified = await checkLoaded(plan, workbook, target, loaded.facts);
      expect(verified.ok).toBe(false);
      expect(verified.findings).toMatchObject([
        { code: 'sum-mismatch', table: 't', field: 'x', expected: 0 },
      ]);
    } finally {
      await target.close();
    }
  });

  it('cancels 1,025 positive money amounts with 1,025 negatives exactly', async () => {
    const plan = planOf([
      {
        key: 't',
        label: 'T',
        source: { sheet: 'S', range: 'A1:A2051', headerRow: 1 },
        fields: [
          {
            key: 'amount',
            label: 'Amount',
            type: 'money',
            money: { currency: 'USD', scale: 2 },
            column: 1,
          },
        ],
      },
    ]);
    const workbook = workbookOf(
      sheetOf('S', [
        ['Amount'],
        ...Array.from({ length: 1025 }, () => [90_000_000_000_000]),
        ...Array.from({ length: 1025 }, () => [-90_000_000_000_000]),
      ]),
    );
    const planned = checkPlan(plan, workbook);
    expect(planned.ok).toBe(true);
    expect(planned.facts.sums.t.amount).toBe(0);
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({ plan, workbook, target });
      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([]);
      expect(result.loaded).toEqual({ t: 2050 });
      expect(await target.sum('t', 'amount')).toBe(0);
    } finally {
      await target.close();
    }
  });
});

describe('number comparisons reject non-finite values', () => {
  it.each([Infinity, NaN])('reports a sum mismatch for %s', async (actual) => {
    const plan = planOf([
      {
        key: 't',
        label: 'T',
        source: { sheet: 'S', range: 'A1:A2', headerRow: 1 },
        fields: [{ key: 'x', label: 'X', type: 'number', column: 1 }],
      },
    ]);
    const target = await createSqliteReferenceTarget();
    vi.spyOn(target, 'sum').mockResolvedValue(actual);
    try {
      const result = await runImport({
        plan,
        workbook: workbookOf(sheetOf('S', [['X'], [1]])),
        target,
      });
      expect(result.ok).toBe(false);
      expect(result.findings).toMatchObject([
        { code: 'sum-mismatch', table: 't', field: 'x', expected: 1, actual },
      ]);
    } finally {
      await target.close();
    }
  });

  it.each([
    Infinity,
    NaN,
  ])('rejects a non-finite calculated cache of %s', async (cached) => {
    const plan = planOf([
      {
        key: 't',
        label: 'T',
        source: { sheet: 'S', range: 'A1:B2', headerRow: 1 },
        fields: [
          { key: 'x', label: 'X', type: 'number', column: 1 },
          {
            key: 'y',
            label: 'Y',
            type: 'number',
            calculated: col('x'),
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
            [1, cached],
          ]),
        ),
        target,
      });
      expect(result.ok).toBe(false);
      expect(result.findings).toMatchObject([
        { code: 'calculated-mismatch', field: 'y', actual: 1 },
      ]);
    } finally {
      await target.close();
    }
  });
});

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

describe('work-over-limit is thrown before the first target call or not at all', () => {
  const plan = planOf([
    {
      key: 't',
      label: 'T',
      source: { sheet: 'S', range: 'A1:C3', headerRow: 1 },
      fields: [
        { key: 'name', label: 'Name', type: 'text', column: 1 },
        { key: 'x', label: 'X', type: 'integer', column: 2 },
        {
          key: 'y',
          label: 'Y',
          type: 'integer',
          calculated: { op: 'add', left: col('x'), right: lit(1) },
          cachedColumn: 3,
        },
      ],
    },
  ]);
  const workbook = () =>
    workbookOf(
      sheetOf('S', [
        ['N', 'X', 'Y'],
        ['a', 1, 2],
        ['b', 2, 3],
      ]),
    );

  /** The reference target with every call recorded. */
  async function spied() {
    const real = await createSqliteReferenceTarget();
    const calls: string[] = [];
    const target = new Proxy(real, {
      get: (obj, name, receiver) => {
        const value = Reflect.get(obj, name, receiver);
        if (typeof value !== 'function' || name === 'close') return value;
        return (...args: unknown[]) => {
          calls.push(String(name));
          return value.apply(obj, args);
        };
      },
    });
    return { real, target, calls };
  }

  it('sweeps maxWork from 1 to the full cost: succeed, or refuse with zero target calls', async () => {
    const full = await spied();
    let total: number;
    try {
      const result = await runImport({
        plan,
        workbook: workbook(),
        target: full.target,
      });
      expect(result.ok).toBe(true);
      total = result.work;
    } finally {
      await full.real.close();
    }
    expect(total).toBeGreaterThan(10);

    let refused = 0;
    for (let maxWork = 1; maxWork <= total; maxWork++) {
      const run = await spied();
      try {
        const outcome: unknown = await runImport({
          plan,
          workbook: workbook(),
          target: run.target,
          limits: { maxWork },
        }).then(
          (result) => result,
          (error: unknown) => error,
        );
        if (outcome instanceof Error) {
          refused++;
          expect(outcome).toMatchObject({ code: 'work-over-limit' });
          expect(run.calls, `maxWork ${maxWork}`).toEqual([]);
        } else {
          expect((outcome as { ok: boolean }).ok, `maxWork ${maxWork}`).toBe(
            true,
          );
          expect(await run.real.count('t')).toBe(2);
        }
      } finally {
        await run.real.close();
      }
    }
    // The boundary is real: the cheapest budgets refuse, and exactly `total` succeeds.
    expect(refused).toBeGreaterThan(0);
    const exact = await spied();
    try {
      const result = await runImport({
        plan,
        workbook: workbook(),
        target: exact.target,
        limits: { maxWork: total },
      });
      expect(result.ok).toBe(true);
    } finally {
      await exact.real.close();
    }
  });

  it('reports a target that returns extra rows as a finding, never a budget error', async () => {
    const real = await createSqliteReferenceTarget();
    const greedy: ImportTarget = {
      describe: () => real.describe(),
      applyStructure: (p) => real.applyStructure(p),
      load: (b) => real.load(b),
      sum: (t, f) => real.sum(t, f),
      count: async (t) => (await real.count(t)) + 3,
      async *values(t, f, r) {
        for await (const row of real.values(t, f, r)) yield row;
        for (let i = 0; i < 1000; i++) {
          yield { sourceRow: 100 + i, values: { y: 0 } };
        }
      },
    };
    try {
      const probeTarget = await createSqliteReferenceTarget();
      const probe = await runImport({
        plan,
        workbook: workbook(),
        target: probeTarget,
      }).finally(() => probeTarget.close());
      const result = await runImport({
        plan,
        workbook: workbook(),
        target: greedy,
        limits: { maxWork: probe.work },
      });
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain(
        'row-count-mismatch',
      );
      expect(
        result.findings.find((f) => f.code === 'row-count-mismatch'),
      ).toMatchObject({
        expected: 2,
        actual: 5,
      });
    } finally {
      await real.close();
    }
  });
});
