import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport } from '@happyvertical/smrt-spreadsheets/import';
import { createSqliteReferenceTarget } from '@happyvertical/smrt-spreadsheets/testing';
import { createSheet, createWorkbook } from '@happyvertical/spreadsheets';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  businessWorkbook,
  realisticBusinessWorkbook,
} from '../../test-support/import-workbook.ts';
import {
  createEngineImportTarget,
  importFieldName,
  importModelName,
} from './import-target.ts';
import { AppHost, MemoryVersionStore } from './index.ts';

let dir: string;
let live: AppHost;
let draft: AppHost;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'import-target-'));
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
it('passes the same related money/choice/cached-formula fixture as the SQLite reference target', async () => {
  const fixture = businessWorkbook();
  const reference = await createSqliteReferenceTarget();
  try {
    const expected = await runImport({ ...fixture, target: reference });
    const target = createEngineImportTarget(draft);
    const result = await runImport({ ...fixture, target, batchSize: 1 });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual(expected.findings);
    expect(result.facts).toEqual(expected.facts);
    expect(result.loaded).toEqual(expected.loaded);
    await target.seal();
    expect(await target.sum('orders', 'price')).toBe(1750);
    expect(await target.count('orders')).toBe(2);
    const report = await draft.runReport(importFieldName('sales'));
    expect(report.rows.map((r) => r.revenue).sort()).toEqual([1500, 2500]);
    expect(
      draft.describe().models[importModelName('orders')].fields.importSourceRow,
    ).toBeUndefined();
    const rows = [];
    for await (const row of target.values('orders', ['total'], [4]))
      rows.push(row);
    expect(rows).toEqual([{ sourceRow: 4, values: { total: 2500 } }]);
    expect(
      (await draft.list(importModelName('orders'))).every(
        (r) => r[importFieldName('customer')],
      ),
    ).toBe(true);
    expect(Object.keys(live.describe().models)).toEqual([]);
  } finally {
    await reference.close();
  }
});
it('refuses a formula the engine cannot represent before loading and preserves live', async () => {
  const fixture = businessWorkbook();
  fixture.plan.tables[0].fields.push({
    key: 'calculated_choice',
    label: 'Calculated status',
    type: 'choice',
    choices: ['Paid'],
    calculated: { value: 'Paid' },
  });
  await expect(
    runImport({ ...fixture, target: createEngineImportTarget(draft) }),
  ).rejects.toThrow();
  expect(Object.keys(draft.describe().models)).toEqual([]);
});
it('proves 42 orders and eight customers against the reference contract without coercing order numbers', async () => {
  const fixture = realisticBusinessWorkbook();
  const reference = await createSqliteReferenceTarget();
  try {
    const expected = await runImport({ ...fixture, target: reference });
    const target = createEngineImportTarget(draft);
    const actual = await runImport({ ...fixture, target, batchSize: 10 });
    expect(expected.ok).toBe(true);
    expect(actual).toMatchObject({
      ok: true,
      loaded: { customers: 8, orders: 42 },
      facts: expected.facts,
      findings: expected.findings,
    });
    const rows = [];
    for await (const row of target.values(
      'orders',
      ['order_number', 'year', 'total'],
      [6, 47],
    ))
      rows.push(row);
    expect(rows).toEqual([
      {
        sourceRow: 6,
        values: { order_number: 'SO-1001', year: 2026, total: 1000 },
      },
      {
        sourceRow: 47,
        values: { order_number: 'SO-1042', year: 2026, total: 4050 },
      },
    ]);
    expect(Object.keys(live.describe().models)).toEqual([]);
  } finally {
    await reference.close();
  }
});
it('refuses a whole batch with an unresolved lookup and leaves earlier batches intact', async () => {
  const { plan } = businessWorkbook();
  const target = createEngineImportTarget(draft);
  await target.applyStructure(plan);
  await target.load({
    table: 'customers',
    index: 0,
    records: [{ sourceRow: 2, values: { name: 'Ada' }, references: {} }],
  });
  await expect(
    target.load({
      table: 'orders',
      index: 0,
      records: [
        {
          sourceRow: 4,
          values: { price: 100, quantity: 2, status: 'Paid' },
          references: { customer: { table: 'customers', key: ['Ada'] } },
        },
        {
          sourceRow: 5,
          values: { price: 100, quantity: 2, status: 'Paid' },
          references: { customer: { table: 'customers', key: ['Nobody'] } },
        },
      ],
    }),
  ).rejects.toThrow();
  expect(await target.count('orders')).toBe(0);
  expect(await target.count('customers')).toBe(1);
});
it('loads 10,000 rows in 500-row commands and rehearses publish without journal overflow', async () => {
  const sheet = createSheet('Rows');
  sheet.cells.set(1, 1, { value: 'Quantity', type: 'text' });
  for (let n = 2; n <= 10001; n++)
    sheet.cells.set(n, 1, { value: n, type: 'number' });
  const target = createEngineImportTarget(draft);
  const result = await runImport({
    workbook: createWorkbook([sheet]),
    plan: {
      version: 1,
      tables: [
        {
          key: 'items',
          label: 'Items',
          source: { sheet: 'Rows', range: 'A1:A10001', headerRow: 1 },
          fields: [
            { key: 'quantity', label: 'Quantity', type: 'integer', column: 1 },
          ],
        },
      ],
    },
    target,
  });
  expect(result.ok).toBe(true);
  expect(await target.count('items')).toBe(10000);
  await target.seal();
  const preview = await live.previewPublish(draft);
  expect(preview.digest).toBeTruthy();
  expect(
    preview.versions.filter((v) => v.summary.startsWith('load ')),
  ).toHaveLength(20);
});
it('preserves unsafe integer totals as bigint rather than rounding them', async () => {
  const target = createEngineImportTarget(draft);
  await target.applyStructure({
    version: 1,
    tables: [
      {
        key: 'large',
        label: 'Large amounts',
        source: { sheet: 'S', range: 'A1:A3', headerRow: 1 },
        fields: [
          { key: 'amount', label: 'Amount', type: 'integer', column: 1 },
        ],
      },
    ],
  });
  const value = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
  await target.load({
    table: 'large',
    index: 0,
    records: [2, 3].map((sourceRow) => ({
      sourceRow,
      values: { amount: value },
      references: {},
    })),
  });
  expect(await target.sum('large', 'amount')).toBe(BigInt(value) * 2n);
});
it('resolves composite lookup keys without merging records that share one component', async () => {
  const customers = createSheet('Customers');
  const orders = createSheet('Orders');
  for (const sheet of [customers, orders]) {
    ['Name', 'Region'].forEach((value, col) => {
      sheet.cells.set(1, col + 1, { value, type: 'text' });
    });
    ['North', 'South'].forEach((value, row) => {
      sheet.cells.set(row + 2, 1, { value: 'Ada', type: 'text' });
      sheet.cells.set(row + 2, 2, { value, type: 'text' });
    });
  }
  const target = createEngineImportTarget(draft);
  const result = await runImport({
    workbook: createWorkbook([customers, orders]),
    target,
    plan: {
      version: 1,
      tables: [
        {
          key: 'customers',
          label: 'Customers',
          source: { sheet: 'Customers', range: 'A1:B3', headerRow: 1 },
          lookupKey: ['name', 'home_region'],
          fields: [
            { key: 'name', label: 'Name', type: 'text', column: 1 },
            { key: 'home_region', label: 'Region', type: 'text', column: 2 },
          ],
        },
        {
          key: 'orders',
          label: 'Orders',
          source: { sheet: 'Orders', range: 'A1:B3', headerRow: 1 },
          fields: [
            {
              key: 'customer',
              label: 'Customer',
              type: 'reference',
              reference: {
                table: 'customers',
                by: ['name', 'home_region'],
                columns: [1, 2],
              },
            },
          ],
        },
      ],
    },
  });
  expect(result.ok).toBe(true);
  const references = (await draft.list(importModelName('orders'))).map(
    (r) => r[importFieldName('customer')],
  );
  expect(new Set(references).size).toBe(2);
});
