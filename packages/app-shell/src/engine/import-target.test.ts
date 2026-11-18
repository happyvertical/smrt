import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportCsv } from '@happyvertical/smrt-reports/display';
import {
  type ImportPlan,
  runImport,
} from '@happyvertical/smrt-spreadsheets/import';
import { createSqliteReferenceTarget } from '@happyvertical/smrt-spreadsheets/testing';
import { createSheet, createWorkbook } from '@happyvertical/spreadsheets';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  businessWorkbook,
  realisticBusinessWorkbook,
} from '../../test-support/import-workbook.ts';
import { subscribe } from '../lib/server/events.ts';
import { wireHostEvents } from '../lib/server/host.ts';
import { cellText } from '../lib/ui/columns.ts';
import { versionSummary } from '../lib/ui/command-summary.ts';
import { announcement } from '../lib/ui/events.ts';
import { initialValues, serializeForm } from '../lib/ui/fields.ts';
import { reportCell } from '../lib/ui/reports.ts';
import {
  createEngineImportTarget,
  importFieldName,
  importModelName,
} from './import-target.ts';
import { AppHost, MemoryVersionStore } from './index.ts';
import { ENGINE_TOOLS } from './tool-definitions.ts';

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
      draft.describe().models[importModelName('orders')].fields.workbookRow,
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
    expect(Object.keys(draft.describe().models).sort()).toEqual([
      'Customers',
      'Orders',
    ]);
    expect(Object.keys(draft.describe().models.Orders.fields)).toContain(
      'orderNo',
    );
    expect(Object.keys(draft.describe().models.Orders.fields)).toEqual([
      'workbookRow',
      'workbookLookup',
      'orderNo',
      'customer',
      'unitPrice',
      'qty',
      'status',
      'year',
      'total',
    ]);
    expect(draft.def.models.Orders.fields.total.calculated).toEqual({
      op: 'mul',
      left: { col: 'unitPrice' },
      right: { col: 'qty' },
    });
    const reportTool = ENGINE_TOOLS.find(
      (tool) => tool.name === 'app_runreport',
    );
    if (!reportTool) throw new Error('Missing report tool');
    const advertised = JSON.parse(
      reportTool.properties.report.description.split('Example: ')[1],
    );
    expect((await draft.runReport(advertised)).rows).toEqual([
      { order_count: 14, order_total: 63600 },
    ]);
    expect((await draft.appTools()).map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'orders_list',
        'orders_get',
        'orders_create',
        'orders_update',
        'orders_delete',
        'customers_list',
      ]),
    );
    const response = await draft.rest({ method: 'GET', url: '/api/orders' });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain('orderNo');
    expect(JSON.stringify(response.body)).toContain('SO-1042');
    const calculation = (await draft.versions()).find(
      (version) => version.summary === 'set calculation Orders.total',
    );
    expect(calculation).toBeDefined();
    expect(versionSummary(calculation!.summary, draft.def, draft.def)).toBe(
      'Change calculation: Total in Orders = Unit price × Quantity',
    );

    const rows = [];
    for await (const row of target.values(
      'orders',
      ['order_no', 'year', 'total'],
      [6, 47],
    ))
      rows.push(row);
    expect(rows).toEqual([
      {
        sourceRow: 6,
        values: { order_no: 'SO-1001', year: 2026, total: 1000 },
      },
      {
        sourceRow: 47,
        values: { order_no: 'SO-1042', year: 2026, total: 4050 },
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
it('loads 10,000 rows in 500-row commands', async () => {
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
    batchSize: 500,
  });
  expect(result.ok).toBe(true);
  expect(await target.count('items')).toBe(10000);
  await target.seal();
});
it('rehearses publishing four 500-row versions without journal overflow', async () => {
  // JOURNAL_LIMITS rows and bytes apply per version: each 500-row batch is
  // its own version, so four exercise the same bounds as twenty. Restore
  // full-size rehearsal with core bulk create: happyvertical/smrt#5066.
  const sheet = createSheet('Rows');
  sheet.cells.set(1, 1, { value: 'Quantity', type: 'text' });
  for (let n = 2; n <= 2001; n++)
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
          source: { sheet: 'Rows', range: 'A1:A2001', headerRow: 1 },
          fields: [
            { key: 'quantity', label: 'Quantity', type: 'integer', column: 1 },
          ],
        },
      ],
    },
    target,
    batchSize: 500,
  });
  expect(result.ok).toBe(true);
  expect(await target.count('items')).toBe(2000);
  await target.seal();
  const preview = await live.previewPublish(draft);
  expect(preview.digest).toBeTruthy();
  expect(
    preview.versions.filter((v) => v.summary.startsWith('load ')),
  ).toHaveLength(4);
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

it('retains the collision map before any command and uses it for loading, links and proof', async () => {
  await draft.execute(
    { type: 'defineModel', name: 'Orders', fields: { note: { type: 'text' } } },
    { author: 'test' },
  );
  const { plan, workbook } = businessWorkbook();
  plan.tables[1].fields[0].key = 'id';
  plan.tables[1].lookupKey = ['id'];
  plan.tables[1].titleField = 'id';
  plan.tables[0].fields[0].reference!.by = ['id'];
  plan.tables[0].fields[1].key = 'unit_price';
  plan.tables[0].fields[2].key = 'unit__price';
  plan.tables[0].fields[3].calculated = {
    op: 'mul',
    left: { col: 'unit_price' },
    right: { col: 'unit__price' },
  };
  const retained: unknown[] = [];
  const target = createEngineImportTarget(draft, undefined, async (names) => {
    expect(Object.keys(draft.def.models)).toEqual(['Orders']);
    retained.push(structuredClone(names));
  });
  const proof = await runImport({ plan, workbook, target });
  expect(proof.ok).toBe(true);
  expect(retained).toEqual([target.names]);
  expect(target.names.tables.orders.model).toBe('Orders2');
  expect(target.names.tables.customers.fields.id).toBe('id2');
  expect(target.names.tables.orders.fields).toMatchObject({
    unit_price: 'unitPrice',
    unit__price: 'unitPrice2',
  });
  expect(draft.def.models.Customers.titleField).toBe('id2');
  expect(
    (await target.describe()).tables
      .find((t) => t.key === 'orders')
      ?.fields.map((f) => f.key),
  ).toEqual(
    expect.arrayContaining(['unit_price', 'unit__price', 'customer', 'total']),
  );
  expect(await target.count('orders')).toBe(2);
  expect(await target.sum('orders', 'total')).toBe(4000);
  expect(await draft.countRows('Orders')).toBe(0);
  expect((await draft.list('Orders2')).every((row) => row.customer)).toBe(true);
});

it('announces imported commands with labels, including bookkeeping, and keeps History calculations readable', async () => {
  wireHostEvents(draft, 'draft');
  const lines: string[] = [];
  const off = subscribe((event) => {
    if (event.type === 'changed') lines.push(announcement(event)!);
  });
  try {
    const fixture = realisticBusinessWorkbook();
    const target = createEngineImportTarget(draft);
    expect((await runImport({ ...fixture, target })).ok).toBe(true);
    await target.seal();
    expect(lines).toContain(
      'App changed: Hide field: Workbook lookup in Orders',
    );
    expect(lines).toContain(
      'App changed: Change calculation: Total in Orders = Unit price × Quantity',
    );
    expect(lines.join(' ')).not.toMatch(
      /Orders\.|unitPrice|workbookLookup|workbookRow/,
    );
    expect(
      draft.describe().models.Orders.fields.workbookLookup,
    ).toBeUndefined();
    expect(draft.describe().models.Orders.fields.workbookRow).toBeUndefined();
  } finally {
    off();
  }
});

it('preserves owner labels in announcements after fields and models are renamed or removed', async () => {
  wireHostEvents(draft, 'draft');
  const lines: string[] = [];
  const off = subscribe((event) => {
    if (event.type === 'changed') lines.push(announcement(event) ?? '');
  });
  try {
    const run = (command: Parameters<AppHost['execute']>[0]) =>
      draft.execute(command, { author: 'test' });
    await run({
      type: 'defineModel',
      name: 'InternalOrders',
      label: 'Orders',
      fields: { rawNote: { type: 'text', label: 'Owner note' } },
    });
    await run({
      type: 'renameField',
      model: 'InternalOrders',
      from: 'rawNote',
      to: 'renamedNote',
    });
    await run({
      type: 'removeField',
      model: 'InternalOrders',
      field: 'renamedNote',
    });
    await run({ type: 'removeModel', model: 'InternalOrders' });
    expect(lines).toEqual([
      'App changed: Add model: Orders',
      'App changed: Change field link: Owner note in Orders',
      'App changed: Remove field: Owner note in Orders',
      'App changed: Remove model: Orders',
    ]);
    expect(lines.join(' ')).not.toMatch(/InternalOrders|rawNote|renamedNote/);
  } finally {
    off();
  }
});

it.each([
  ['JPY', 0, 1000, 1000, '1000'],
  ['USD', 3, 1.234, 1234, '1.234'],
  ['CAD', 2, 12.5, 1250, '12.50'],
] as const)('preserves %s scale %i through import, record display/edit and reports/CSV', async (currency, scale, amount, minor, input) => {
  const sheet = createSheet('Amounts');
  sheet.cells.set(1, 1, { type: 'text', value: 'Amount' });
  sheet.cells.set(2, 1, { type: 'number', value: amount });
  const plan: ImportPlan = {
    version: 1,
    tables: [
      {
        key: 'amounts',
        label: 'Amounts',
        source: { sheet: 'Amounts', range: 'A1:A2', headerRow: 1 },
        fields: [
          {
            key: 'amount',
            label: 'Amount',
            type: 'money',
            column: 1,
            money: { currency, scale },
          },
        ],
      },
    ],
    reports: [
      {
        key: 'totals',
        label: 'Totals',
        spec: {
          version: 1,
          title: 'Totals',
          source: 'amounts',
          dimensions: [],
          measures: [{ fn: 'sum', field: 'amount', as: 'total' }],
        },
      },
    ],
  };
  const proof = await runImport({
    workbook: createWorkbook([sheet]),
    plan,
    target: createEngineImportTarget(draft),
  });
  expect(proof.ok).toBe(true);
  const fields = draft.describe().models.Amounts.fields;
  expect(fields.amount).toMatchObject({ money: { currency, scale } });
  const [row] = await draft.list('Amounts');
  expect(row.amount).toBe(minor);
  const display = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).format(amount);
  expect(cellText(fields.amount, row.amount)).toBe(display);
  const values = initialValues(fields, { ...row, id: String(row.id) });
  expect(values.amount).toBe(input);
  const edit = serializeForm(fields, { ...values, amount: input }, ['amount']);
  expect(edit).toEqual({ data: { amount: minor }, errors: {} });
  await draft.update('Amounts', String(row.id), edit.data);
  expect((await draft.list('Amounts'))[0].amount).toBe(minor);
  const report = await draft.runReport('totals');
  expect(
    reportCell(report.rows[0].total, report.columns[0], report.rows[0]),
  ).toBe(display);
  expect(reportCsv(report, reportCell)).toContain(
    display.includes(',') ? `"${display}"` : display,
  );
});

it.each([
  ['number', false],
  ['text', false],
  ['integer', false],
  ['integer', true],
] as const)('converts imported money to %s (calculated: %s) and undoes with its units intact', async (type, calculated) => {
  const sheet = createSheet('Amounts');
  sheet.cells.set(1, 1, { type: 'text', value: 'Amount' });
  sheet.cells.set(2, 1, { type: 'number', value: 1000 });
  const money = { currency: 'JPY', scale: 0 };
  const proof = await runImport({
    workbook: createWorkbook([sheet]),
    plan: {
      version: 1,
      tables: [
        {
          key: 'amounts',
          label: 'Amounts',
          source: { sheet: 'Amounts', range: 'A1:A2', headerRow: 1 },
          fields: [
            { key: 'amount', label: 'Amount', type: 'money', column: 1, money },
          ],
        },
      ],
    },
    target: createEngineImportTarget(draft),
  });
  expect(proof.ok).toBe(true);
  if (calculated)
    await draft.execute(
      {
        type: 'setCalculation',
        model: 'Amounts',
        field: 'amount',
        calculated: { value: 1000 },
      },
      { author: 'test' },
    );
  const before = draft.describe().models.Amounts.fields.amount;
  await draft.execute(
    {
      type: 'changeFieldType',
      model: 'Amounts',
      field: 'amount',
      to: { type },
    },
    { author: 'test' },
  );
  const after = draft.describe().models.Amounts.fields.amount;
  expect(after.type).toBe(type);
  expect(after.money).toBeUndefined();
  expect((await draft.list('Amounts'))[0].amount).toBe(
    type === 'text' ? '1000' : 1000,
  );
  await draft.execute({ type: 'undo' }, { author: 'test' });
  expect(draft.describe().models.Amounts.fields.amount).toEqual(before);
  expect((await draft.list('Amounts'))[0].amount).toBe(1000);
  expect(cellText(draft.describe().models.Amounts.fields.amount, 1000)).toBe(
    cellText({ type: 'money', money }, 1000),
  );
});

it('retains money units through rename, calculation, hiding and a template round trip', async () => {
  const money = { currency: 'CAD', scale: 3 };
  await draft.execute(
    {
      type: 'defineModel',
      name: 'Amounts',
      fields: {
        amount: { type: 'money', money },
      },
    },
    { author: 'test' },
  );
  await draft.execute(
    { type: 'renameField', model: 'Amounts', from: 'amount', to: 'total' },
    { author: 'test' },
  );
  await draft.execute(
    {
      type: 'setCalculation',
      model: 'Amounts',
      field: 'total',
      calculated: { value: 1234 },
    },
    { author: 'test' },
  );
  expect(draft.describe().models.Amounts.fields.total.money).toEqual(money);
  await draft.execute(
    { type: 'hideField', model: 'Amounts', field: 'total' },
    { author: 'test' },
  );
  const exported = await draft.execute(
    { type: 'exportTemplate' },
    { author: 'test' },
  );
  expect(exported).toMatchObject({
    definition: {
      models: {
        Amounts: {
          fields: {
            total: {
              type: 'money',
              money,
              hidden: true,
              calculated: { value: 1234 },
            },
          },
        },
      },
    },
  });
  await live.execute(
    {
      type: 'importTemplate',
      data: exported as import('./commands.ts').Template,
    },
    { author: 'test' },
  );
  const reexported = await live.execute(
    { type: 'exportTemplate' },
    { author: 'test' },
  );
  expect(reexported).toMatchObject({
    definition: (exported as import('./commands.ts').Template).definition,
  });
});
