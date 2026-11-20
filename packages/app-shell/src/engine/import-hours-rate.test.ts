import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ImportPlan,
  runImport,
} from '@happyvertical/smrt-spreadsheets/import';
import { createSheet, createWorkbook } from '@happyvertical/spreadsheets';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { savedValueFallback } from '../lib/server/import-workflow.ts';
import { createEngineImportTarget } from './import-target.ts';
import { AppHost, MemoryVersionStore } from './index.ts';

let dir: string;
let live: AppHost;
let draft: AppHost;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'import-hours-'));
  live = await AppHost.open(join(dir, 'live'), {
    store: new MemoryVersionStore(),
  });
  draft = await live.forkDraft(join(dir, 'draft'), {
    store: new MemoryVersionStore(),
  });
});
afterEach(async () => {
  await draft?.close();
  await live?.close();
  rmSync(dir, { recursive: true, force: true });
});

function timeEntries(amount: unknown, rateType: 'money' | 'number' = 'money') {
  const sheet = createSheet('Time entries');
  const put = (r: number, c: number, value: string | number) =>
    sheet.cells.set(r, c, {
      value,
      type: typeof value === 'number' ? 'number' : 'text',
    });
  ['Task', 'Hours', 'Rate', 'Amount'].forEach((v, j) => {
    put(1, j + 1, v);
  });
  [
    ['Logo', 1.25, 95],
    ['Site', 3, 120.5],
    ['Call', 0.5, 95],
  ].forEach((r, i) => {
    r.forEach((v, j) => {
      put(i + 2, j + 1, v);
    });
    const hours = r[1] as number,
      rate = r[2] as number;
    sheet.cells.set(i + 2, 4, {
      value: hours * rate,
      type: 'number',
      formula: {
        text: `B${i + 2}*C${i + 2}`,
        dialect: 'excel-a1',
        references: [],
        functions: [],
      },
    });
  });
  const plan = {
    version: 1,
    tables: [
      {
        key: 'time_entries',
        label: 'Time entries',
        source: { sheet: 'Time entries', range: 'A1:D4', headerRow: 1 },
        fields: [
          { key: 'task', label: 'Task', type: 'text', column: 1 },
          { key: 'hours', label: 'Hours', type: 'number', column: 2 },
          rateType === 'money'
            ? {
                key: 'rate',
                label: 'Rate',
                type: 'money',
                column: 3,
                money: { currency: 'CAD', scale: 2 },
              }
            : { key: 'rate', label: 'Rate', type: 'number', column: 3 },
          {
            key: 'amount',
            label: 'Amount',
            type: 'money',
            money: { currency: 'CAD', scale: 2 },
            cachedColumn: 4,
            calculated: amount,
          },
        ],
      },
    ],
  } as unknown as ImportPlan;
  return { workbook: createWorkbook([sheet]), plan };
}
const mul = { op: 'mul', left: { col: 'hours' }, right: { col: 'rate' } };
// #5168: Hours x Rate on money with cents, 1.25 x 95 = 118.75.
it.each([
  ['a plain product', mul],
  [
    'an explicit round to 0 places',
    { op: 'round', value: mul, digits: { value: 0 } },
  ],
])('imports Hours x Rate as %s and proves it', async (_name, expr) => {
  const fixture = timeEntries(expr);
  const target = createEngineImportTarget(draft);
  const result = await runImport({ ...fixture, target });
  expect(result.findings).toEqual([]);
  expect(result.ok).toBe(true);
  const amounts: unknown[] = [];
  for await (const row of target.values('time_entries', ['amount']))
    amounts.push(row.values.amount);
  expect(amounts).toEqual([11875, 36150, 4750]);
});
it('falls back to saved values when a calculation fails proof', async () => {
  const fixture = timeEntries({ op: 'add', left: mul, right: { value: 1 } });
  const target = createEngineImportTarget(draft);
  const failed = await runImport({ ...fixture, target });
  expect(failed.ok).toBe(false);
  const errors = failed.findings.filter((f) => f.severity === 'error');
  expect(errors.map((f) => f.code)).toContain('calculated-mismatch');
  const fallback = savedValueFallback(fixture.plan, errors);
  const amount = fallback?.tables[0].fields.find((f) => f.key === 'amount');
  expect(amount).toMatchObject({ column: 4, type: 'money' });
  expect(amount?.calculated).toBeUndefined();
  expect(amount?.cachedColumn).toBeUndefined();
  await draft.close();
  draft = await live.forkDraft(join(dir, 'draft2'), {
    store: new MemoryVersionStore(),
  });
  const again = await runImport({
    workbook: fixture.workbook,
    plan: fallback!,
    target: createEngineImportTarget(draft),
  });
  expect(again.ok).toBe(true);
});
it('does not fall back for a failure that is not a calculation', () => {
  const fixture = timeEntries(mul);
  expect(
    savedValueFallback(fixture.plan, [
      { code: 'coerce-failed', table: 'time_entries', field: 'hours' },
    ]),
  ).toBeNull();
  expect(savedValueFallback(fixture.plan, [])).toBeNull();
});
