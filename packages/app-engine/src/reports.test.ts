import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AppHost, type Command, MemoryVersionStore } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'reports-4916-'));
const store = new MemoryVersionStore();
let host: AppHost;
const run = (cmd: Command) =>
  host.execute(cmd, { author: 't', approved: true });
const spec = (extra: Record<string, unknown> = {}) =>
  parseRuntimeReportSpec({
    version: 1,
    title: 'Sales',
    source: 'Sale',
    dimensions: [{ field: 'day', bucket: 'month', as: 'month' }],
    measures: [{ fn: 'sum', field: 'total', as: 'revenue' }],
    ...extra,
  });
beforeAll(async () => {
  host = await AppHost.open(dir, { store });
  await run({
    type: 'defineModel',
    name: 'Customer',
    fields: { name: { type: 'text' } },
  });
  await run({
    type: 'defineModel',
    name: 'Sale',
    fields: {
      day: { type: 'date' },
      qty: { type: 'integer' },
      price: { type: 'money' },
      customer: { type: 'reference', ref: 'Customer' },
      total: {
        type: 'money',
        calculated: {
          op: 'mul',
          left: { col: 'qty' },
          right: { col: 'price' },
        },
      },
    },
  });
  const c = await host.create('Customer', { name: 'Ada' });
  for (const [day, qty, price] of [
    ['2026-01-05', 2, 100],
    ['2026-01-15', 1, 200],
    ['2026-02-01', 3, 100],
  ] as const)
    await host.create('Sale', { day, qty, price, customer: c.id });
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

it('runs monthly/filter/calculated reports and enriches reference dimensions', async () => {
  const command: Command = {
    type: 'defineReport',
    name: 'sales',
    definition: { spec: spec() },
  };
  expect((await host.plan(command)).summary).toBe(
    ((await run(command)) as { summary: string }).summary,
  );
  const result = await host.runReport('sales');
  expect(result.rows.map((r) => r.revenue).sort()).toEqual([300, 400]);
  expect(result.columns.find((c) => c.id === 'revenue')?.format).toBe('money');
  expect(
    (
      await host.runReport(
        spec({ filters: [{ field: 'qty', op: 'gt', value: 1 }] }),
      )
    ).rows
      .map((r) => r.revenue)
      .sort(),
  ).toEqual([200, 300]);
  const grouped = await host.runReport(
    spec({ dimensions: [{ field: 'customer', as: 'customer' }] }),
  );
  expect(grouped.rows).toHaveLength(1);
  expect(grouped.rows[0].customerLabel).toBe('Ada');
  expect(grouped.rows[0].revenue).toBe(700);
  expect((await host.runReport('sales', { maxRows: 1 })).rows).toHaveLength(1);
});

it('refuses hidden/foreign fields and dependent mutations; rename and undo rewrite reports', async () => {
  await run({
    type: 'addField',
    model: 'Sale',
    field: 'hidden',
    definition: { type: 'integer' },
  });
  await run({ type: 'hideField', model: 'Sale', field: 'hidden' });
  for (const field of ['hidden', 'foreign', 'created_at'])
    await expect(
      host.plan({
        type: 'defineReport',
        name: 'bad',
        definition: { spec: spec({ measures: [{ fn: 'sum', field }] }) },
      }),
    ).rejects.toThrow();
  await expect(
    host.plan({
      type: 'defineReport',
      name: 'bad',
      definition: { spec: spec({ measures: [{ fn: 'sum', field: 'day' }] }) },
    }),
  ).rejects.toThrow();
  await expect(
    host.plan({ type: 'hideField', model: 'Sale', field: 'day' }),
  ).rejects.toThrow(/report sales/);
  await run({ type: 'renameField', model: 'Sale', from: 'day', to: 'soldAt' });
  expect(host.def.reports?.sales.spec.dimensions[0].field).toBe('soldAt');
  expect((await host.runReport('sales')).rowCount).toBe(2);
  await run({ type: 'undo' });
  expect(host.def.reports?.sales.spec.dimensions[0].field).toBe('day');
});

it('renames/removes/replaces with undo, survives restart and runs frozen and draft', async () => {
  await run({ type: 'renameReport', from: 'sales', to: 'monthly' });
  await run({ type: 'removeReport', name: 'monthly' });
  await expect(host.runReport('monthly')).rejects.toThrow(/unknown report/);
  await run({ type: 'undo' });
  await run({ type: 'undo' });
  await run({
    type: 'defineReport',
    name: 'sales',
    definition: { spec: spec({ title: 'Replacement' }) },
  });
  await run({ type: 'undo' });
  await host.close();
  host = await AppHost.open(dir, { store });
  host.setFrozen(true);
  expect((await host.runReport('sales')).title).toBe('Sales');
  await expect(host.runReport('sales', { maxRows: 1001 })).rejects.toThrow(
    /limits/,
  );
  await expect(host.runReport('sales', { timeoutMs: 0 })).rejects.toThrow(
    /limits/,
  );
  host.setFrozen(false);
  const draft = await host.forkDraft(`${dir}-draft`, {
    store: new MemoryVersionStore(),
  });
  try {
    await draft.execute(
      { type: 'renameReport', from: 'sales', to: 'monthly' },
      { author: 't' },
    );
    expect((await draft.runReport('monthly')).rowCount).toBe(2);
    const p = await host.previewPublish(draft);
    await host.publishDraft(draft, {
      author: 't',
      approved: true,
      expect: p.digest,
    });
    expect((await host.runReport('monthly')).rowCount).toBe(2);
    await run({ type: 'undo' });
    expect((await host.runReport('sales')).rowCount).toBe(2);
  } finally {
    await draft.discard();
  }
});

it('keeps display label aliases distinct and rejects prototype names', async () => {
  const result = await host.runReport(
    spec({
      dimensions: [
        { field: 'customer', as: 'a' },
        { field: 'customer', as: 'a_label' },
      ],
    }),
  );
  const labelColumns = result.columns
    .filter((c) => c.reference)
    .map((c) => c.labelColumn);
  expect(new Set(labelColumns).size).toBe(2);
  for (const column of labelColumns)
    expect(result.rows[0][String(column)]).toBe('Ada');
  await expect(
    host.plan({
      type: 'defineReport',
      name: '__proto__',
      definition: { spec: spec() },
    }),
  ).rejects.toThrow(/invalid report name/);
});

it('terminates a timed-out aggregate without stopping the live worker', async () => {
  await run({
    type: 'defineModel',
    name: 'Slow',
    fields: { amount: { type: 'integer' } },
  });
  const db = new DatabaseSync(join(dir, 'app.db'));
  try {
    db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<200000)
      INSERT INTO u_slows (id, slug, context, created_at, updated_at, amount)
      SELECT printf('%032d', x), '', '', '2026-01-01', '2026-01-01', x FROM n`);
  } finally {
    db.close();
  }
  const report = parseRuntimeReportSpec({
    version: 1,
    title: 'Slow sum',
    source: 'Slow',
    measures: [{ fn: 'sum', field: 'amount' }],
  });
  await expect(host.runReport(report, { timeoutMs: 1 })).rejects.toThrow(
    /time limit/,
  );
  expect(host.appAlive).toBe(true);
  expect((await host.runReport('sales')).rowCount).toBe(2);
});

it('normalizes omitted spec defaults and compiles template reports against their proposed models', async () => {
  await run({
    type: 'defineReport',
    name: 'minimal',
    definition: {
      spec: {
        version: 1,
        title: 'Minimal',
        source: 'Sale',
        measures: [{ fn: 'sum', field: 'price' }],
      } as never,
    },
  });
  expect(host.def.reports?.minimal.spec.dimensions).toEqual([]);
  await expect(
    host.plan({ type: 'hideField', model: 'Sale', field: 'price' }),
  ).rejects.toThrow(/report minimal/);
  const imported = await AppHost.open(`${dir}-import`, {
    store: new MemoryVersionStore(),
  });
  try {
    const definition = {
      format: 1 as const,
      name: 'Import',
      recipes: [],
      models: { Order: { fields: { day: { type: 'date' as const } } } },
      reports: {
        invalid: {
          spec: parseRuntimeReportSpec({
            version: 1,
            title: 'Invalid aggregate',
            source: 'Order',
            measures: [{ fn: 'sum', field: 'day' }],
          }),
        },
      },
    };
    await expect(
      imported.plan({
        type: 'importTemplate',
        data: { format: 1, definition },
      }),
    ).rejects.toThrow(/numeric|number|sum/);
    expect(imported.version).toBe(0);
    definition.reports.invalid.spec = parseRuntimeReportSpec({
      version: 1,
      title: 'Orders',
      source: 'Order',
      measures: [{ fn: 'count', as: 'orders' }],
    });
    await imported.execute(
      { type: 'importTemplate', data: { format: 1, definition } },
      { author: 't' },
    );
    expect((await imported.runReport('invalid')).rows[0].orders).toBe(0);
  } finally {
    await imported.close();
    rmSync(`${dir}-import`, { recursive: true, force: true });
  }
});
