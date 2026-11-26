import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { runImport } from '@happyvertical/smrt-spreadsheets/import';
import { createSheet, createWorkbook } from '@happyvertical/spreadsheets';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import { createEngineImportTarget } from './import-target.ts';
import { AppHost, MemoryVersionStore } from './index.ts';
import { ENGINE_TOOLS } from './tool-definitions.ts';

let dir: string;
let draft: AppHost;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'report-bucket-'));
  const live = await AppHost.open(join(dir, 'live'), {
    store: new MemoryVersionStore(),
  });
  draft = await live.forkDraft(hostOwner(live), join(dir, 'draft'), {
    store: new MemoryVersionStore(),
  });
  await live.close();
});
afterEach(async () => {
  await draft?.close();
  rmSync(dir, { recursive: true, force: true });
});

it('runs a month-bucket report with sort by/direction on an imported date field', async () => {
  const sheet = createSheet('Sales');
  const put = (row: number, col: number, value: string | number) =>
    sheet.cells.set(row, col, {
      value,
      type: typeof value === 'number' ? 'number' : 'text',
    });
  put(1, 1, 'Sold on');
  put(1, 2, 'Amount');
  (
    [
      ['2026-02-03', 5],
      ['2026-01-20', 7],
      ['2026-01-02', 3],
    ] as const
  ).forEach((r, i) => {
    put(i + 2, 1, r[0]);
    put(i + 2, 2, r[1]);
  });
  const plan = {
    version: 1 as const,
    reports: [],
    tables: [
      {
        key: 'sales',
        label: 'Sales',
        source: { sheet: 'Sales', range: 'A1:B4', headerRow: 1 },
        fields: [
          {
            key: 'sold_on',
            label: 'Sold on',
            type: 'date' as const,
            column: 1,
          },
          {
            key: 'amount',
            label: 'Amount',
            type: 'integer' as const,
            column: 2,
          },
        ],
      },
    ],
  };
  const target = createEngineImportTarget(draft, () => hostOwner(draft));
  const imported = await runImport({
    workbook: createWorkbook([sheet]),
    plan,
    target,
  });
  expect(imported.ok).toBe(true);
  await target.seal();
  const source = target.names.tables.sales.model;
  const field = target.names.tables.sales.fields.sold_on;
  const amount = target.names.tables.sales.fields.amount;
  expect(draft.describe().models[source].fields[field].type).toBe('date');

  // The shape the tool description teaches: bucket plus sort[{by, direction}].
  const description = String(
    ENGINE_TOOLS.find((t) => t.name === 'app_runreport')?.properties.report
      .description,
  );
  expect(description).toContain('"bucket":"month"');
  expect(description).toContain('"by":"month","direction":"asc"');

  const result = await draft.runReport(
    hostOwner(draft),
    parseRuntimeReportSpec({
      title: 'Monthly sales',
      source,
      dimensions: [{ field, bucket: 'month', as: 'month' }],
      measures: [{ fn: 'sum', field: amount, as: 'total' }],
      sort: [{ by: 'month', direction: 'asc' }],
    }),
  );
  expect(result.rows.map((r) => r.total)).toEqual([10, 5]);
  expect(String(result.rows[0].month)).toContain('2026-01');
  expect(String(result.rows[1].month)).toContain('2026-02');
});
