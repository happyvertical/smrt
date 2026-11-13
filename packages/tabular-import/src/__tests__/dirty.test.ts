import type { Workbook } from '@happyvertical/spreadsheets';
import { describe, expect, it, vi } from 'vitest';
import {
  checkPlan,
  type ImportPlan,
  ImportRunError,
  type ImportTarget,
  MAX_EXAMPLES,
  planLoad,
  runImport,
} from '../index.js';
import { createSqliteReferenceTarget } from '../testing.js';
import { type CellSpec, planOf, sheetOf, workbookOf } from './helpers.js';

const errorCell = { value: null, type: 'error' as const, error: '#DIV/0!' };

const plan = planOf([
  {
    key: 'teams',
    label: 'Teams',
    source: { sheet: 'Teams', range: 'A1:A3', headerRow: 1 },
    lookupKey: ['name'],
    fields: [
      { key: 'name', label: 'Name', type: 'text', column: 1, required: true },
    ],
  },
  {
    key: 'people',
    label: 'People',
    source: { sheet: 'People', range: 'A1:F11', headerRow: 1, skipRows: [11] },
    lookupKey: ['email'],
    fields: [
      { key: 'code', label: 'Code', type: 'integer', column: 1 },
      { key: 'age', label: 'Age', type: 'integer', column: 2 },
      { key: 'email', label: 'Email', type: 'text', column: 3 },
      {
        key: 'team',
        label: 'Team',
        type: 'reference',
        required: true,
        reference: { table: 'teams', by: ['name'], columns: [4] },
      },
    ],
  },
]);

function dirty(): Workbook {
  const rows: CellSpec[][] = [
    ['Code', 'Age', 'Email', 'Team', null, 'Note'],
    [1, 30, 'a@x', 'Red', null, 'n1'],
    ['0042', 31, 'b@x', 'Red'],
    ['12345678901234567', 32, 'c@x', 'Red'],
    [4, 31.5, 'd@x', 'Red'],
    [5, undefined, 'e@x', 'Red'],
    [6, 20, 'a@x', 'Red'],
    [7, 21, null, 'Red'],
    [8, 22, 'f@x', 'Green'],
    [9, 23, 'g@x', null],
    ['Total', 187],
  ];
  const people = sheetOf('People', rows);
  people.cells.set(6, 2, errorCell);
  return workbookOf(sheetOf('Teams', [['Name'], ['Red'], ['Blue']]), people);
}

/** A target that fails the test if anything reaches it. */
function untouchable(): ImportTarget & { calls: string[] } {
  const calls: string[] = [];
  const touch = (name: string) => () => {
    calls.push(name);
    throw new Error(`${name} must not be called`);
  };
  return {
    calls,
    describe: touch('describe') as ImportTarget['describe'],
    applyStructure: touch('applyStructure') as ImportTarget['applyStructure'],
    load: touch('load') as ImportTarget['load'],
    count: touch('count') as ImportTarget['count'],
    sum: touch('sum') as ImportTarget['sum'],
    values: touch('values') as unknown as ImportTarget['values'],
  };
}

describe('checkPlan on dirty data', () => {
  const result = checkPlan(plan, dirty());
  const brief = result.findings.map((f) => ({
    code: f.code,
    severity: f.severity,
    table: f.table,
    field: f.field,
    cell: f.cell,
    row: f.row,
    count: f.count,
  }));

  it('fires every finding with the exact cell', () => {
    expect(result.ok).toBe(false);
    expect(brief).toEqual([
      {
        code: 'digits-as-number',
        severity: 'error',
        table: 'people',
        field: 'code',
        cell: 'A3',
        row: 3,
        count: 2,
      },
      {
        code: 'digits-as-number',
        severity: 'error',
        table: 'people',
        field: 'code',
        cell: 'A4',
        row: 4,
        count: 2,
      },
      {
        code: 'coerce-failed',
        severity: 'error',
        table: 'people',
        field: 'age',
        cell: 'B5',
        row: 5,
        count: 2,
      },
      {
        code: 'coerce-failed',
        severity: 'error',
        table: 'people',
        field: 'age',
        cell: 'B6',
        row: 6,
        count: 2,
      },
      {
        code: 'required-blank',
        severity: 'error',
        table: 'people',
        field: 'team',
        cell: 'D10',
        row: 10,
        count: 1,
      },
      {
        code: 'unmapped-column',
        severity: 'warning',
        table: 'people',
        field: undefined,
        cell: 'F1',
        row: undefined,
        count: 1,
      },
      {
        code: 'lookup-key-not-unique',
        severity: 'error',
        table: 'people',
        field: 'email',
        cell: undefined,
        row: 7,
        count: 1,
      },
      {
        code: 'lookup-key-blank',
        severity: 'error',
        table: 'people',
        field: 'email',
        cell: 'C8',
        row: 8,
        count: 1,
      },
      {
        code: 'reference-unresolved',
        severity: 'error',
        table: 'people',
        field: 'team',
        cell: 'D9',
        row: 9,
        count: 1,
      },
    ]);
  });

  it('carries expected, actual and a message', () => {
    expect(result.findings[0]).toEqual({
      code: 'digits-as-number',
      severity: 'error',
      table: 'people',
      field: 'code',
      sheet: 'People',
      cell: 'A3',
      row: 3,
      expected: 'text',
      actual: '0042',
      count: 2,
      message: 'Row 3: "0042" looks like an identifier; map "code" as text.',
    });
    expect(result.findings[3]).toMatchObject({
      actual: '#DIV/0!',
      message: 'Row 6: #DIV/0! [cell-error]',
    });
    expect(result.findings[2].message).toBe(
      'Row 5: 31.5 is not whole [not-integer]',
    );
  });

  it('reports row counts and column sums as facts, not findings', () => {
    expect(result.facts.tables.people).toEqual({
      read: 10,
      skipped: 1,
      rejected: 5,
      planned: 4,
    });
    expect(result.facts.sums.people).toEqual({ age: 93, code: 22 });
    expect(result.facts.tables.teams).toEqual({
      read: 2,
      skipped: 0,
      rejected: 0,
      planned: 2,
    });
  });

  it('never plans a row that failed to type', () => {
    const rows = [...planLoad(plan, dirty()).batches()]
      .filter((b) => b.table === 'people')
      .flatMap((b) => b.records.map((r) => r.sourceRow));
    expect(rows).toEqual([2, 7, 8, 9]);
  });
});

describe('structural findings', () => {
  const base = (
    override: Partial<ImportPlan['tables'][number]['source']>,
  ): ImportPlan =>
    planOf([
      {
        key: 't',
        label: 'T',
        source: { sheet: 'S', range: 'A1:B3', headerRow: 1, ...override },
        fields: [
          { key: 'a', label: 'A', type: 'text', column: 1 },
          { key: 'b', label: 'B', type: 'text', column: 2 },
        ],
      },
    ]);
  const wb = () =>
    workbookOf(
      sheetOf('S', [
        ['a', 'b'],
        ['1', '2'],
      ]),
    );

  it('names a missing sheet', () => {
    const res = checkPlan(base({ sheet: 'Nope' }), wb());
    expect(res.findings.map((f) => f.code)).toEqual(['sheet-missing']);
  });

  it('names a header outside the range and a column outside the range', () => {
    expect(
      checkPlan(base({ headerRow: 9 }), wb()).findings.map((f) => f.code),
    ).toEqual(['header-outside-range']);
    const narrow = checkPlan(base({ range: 'A1:A3' }), wb());
    expect(narrow.findings).toMatchObject([
      { code: 'column-outside-range', field: 'b', column: 2 },
    ]);
  });

  it('refuses to plan a load from an unreadable source', () => {
    expect(() => planLoad(base({ sheet: 'Nope' }), wb())).toThrow(
      ImportRunError,
    );
  });
});

describe('caps', () => {
  it('keeps at most 20 examples per code, table and field with a total count', () => {
    const rows: CellSpec[][] = [['n']];
    for (let i = 0; i < 30; i++) rows.push([`bad ${i}`]);
    const res = checkPlan(
      planOf([
        {
          key: 't',
          label: 'T',
          source: { sheet: 'S', range: 'A1:A31', headerRow: 1 },
          fields: [{ key: 'n', label: 'N', type: 'integer', column: 1 }],
        },
      ]),
      workbookOf(sheetOf('S', rows)),
    );
    expect(MAX_EXAMPLES).toBe(20);
    expect(res.findings).toHaveLength(20);
    expect(
      res.findings.every((f) => f.count === 30 && f.code === 'coerce-failed'),
    ).toBe(true);
    expect(res.findings.map((f) => f.row)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 2),
    );
  });
});

describe('runImport writes nothing when the plan has errors', () => {
  it('never reaches the target', async () => {
    const target = untouchable();
    const result = await runImport({ plan, workbook: dirty(), target });
    expect(result.ok).toBe(false);
    expect(result.loaded).toEqual({});
    expect(result.findings.length).toBeGreaterThan(0);
    expect(target.calls).toEqual([]);
  });

  it('leaves a real database untouched', async () => {
    const target = await createSqliteReferenceTarget();
    try {
      const result = await runImport({ plan, workbook: dirty(), target });
      expect(result.ok).toBe(false);
      expect(await target.describe()).toEqual({ tables: [] });
    } finally {
      await target.close();
    }
  });
});

describe('proving the load', () => {
  const clean = () =>
    workbookOf(
      sheetOf('Teams', [['Name'], ['Red'], ['Blue']]),
      sheetOf('People', [
        ['Code', 'Age', 'Email', 'Team', null, 'Note'],
        [1, 30, 'a@x', 'Red', null, 'n1'],
        [2, 31, 'b@x', 'Blue'],
        [3, 32, 'c@x', 'Blue'],
        [],
        [],
        [],
        [],
        [],
        [],
        ['Total', 93],
      ]),
    );

  it('refuses a target that already has a planned table', async () => {
    const target = await createSqliteReferenceTarget();
    try {
      await target.db.query('CREATE TABLE "teams" ("x" TEXT)');
      await expect(
        runImport({ plan, workbook: clean(), target }),
      ).rejects.toMatchObject({
        code: 'target-not-empty',
        detail: { tables: ['teams'] },
      });
    } finally {
      await target.close();
    }
  });

  it('reports a short load as row-count-mismatch and sum-mismatch', async () => {
    const real = await createSqliteReferenceTarget();
    const lossy: ImportTarget = {
      describe: () => real.describe(),
      applyStructure: (p) => real.applyStructure(p),
      count: (t) => real.count(t),
      sum: (t, f) => real.sum(t, f),
      values: (t, f, r) => real.values(t, f, r),
      load: (batch) =>
        real.load(
          batch.table === 'people'
            ? { ...batch, records: batch.records.slice(1) }
            : batch,
        ),
    };
    try {
      const result = await runImport({
        plan,
        workbook: clean(),
        target: lossy,
      });
      expect(result.ok).toBe(false);
      expect(
        result.findings.map(({ code, table, field, expected, actual }) => ({
          code,
          table,
          field,
          expected,
          actual,
        })),
      ).toEqual([
        {
          code: 'unmapped-column',
          table: 'people',
          field: undefined,
          expected: undefined,
          actual: 'Note',
        },
        {
          code: 'row-count-mismatch',
          table: 'people',
          field: undefined,
          expected: 3,
          actual: 2,
        },
        {
          code: 'sum-mismatch',
          table: 'people',
          field: 'code',
          expected: 6,
          actual: 5,
        },
        {
          code: 'sum-mismatch',
          table: 'people',
          field: 'age',
          expected: 93,
          actual: 63,
        },
      ]);
    } finally {
      await real.close();
    }
  });

  it('does not hide an adapter error', async () => {
    const failing = untouchable();
    failing.describe = vi.fn(async () => ({ tables: [] }));
    failing.applyStructure = vi.fn(async () => {
      throw new Error('disk full');
    });
    await expect(
      runImport({ plan, workbook: clean(), target: failing }),
    ).rejects.toThrow('disk full');
  });
});
