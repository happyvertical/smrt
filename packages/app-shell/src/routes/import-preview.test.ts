// Real owner checks, import target and SQLite draft; only the current-run
// projection is supplied, so these reads do not need an AI/job runner.
import { checkPlan } from '@happyvertical/smrt-spreadsheets/import';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { businessWorkbook } from '../../test-support/import-workbook.ts';
import { createEngineImportTarget } from '../engine/import-target.ts';
import { startDraft } from '../lib/server/drafts.ts';
import { getDraftSlot, hostFor } from '../lib/server/host.ts';
import type { Principal } from '../lib/server/owner.ts';
import { openShell, type ShellHarness } from '../lib/server/test-support.ts';
import type { ImportState } from '../lib/ui/import.ts';
import { GET } from './api/shell/import/preview/+server.ts';

const saved = vi.hoisted(() => ({ current: null as ImportState | null }));
vi.mock('../lib/server/import-runtime', () => ({
  shellImports: async () => ({ current: async () => saved.current }),
}));
let h: ShellHarness;
beforeEach(async () => {
  h = await openShell();
  saved.current = null;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});
function read(query = '', actor: Principal | null = h.owner) {
  const url = new URL(`/api/shell/import/preview${query}`, 'http://shell');
  return GET({
    url,
    request: new Request(url),
    locals: actor
      ? {
          user: { id: actor.id },
          tenantId: actor.tenantId,
          permissions: [],
        }
      : {},
  } as never);
}

it('returns a database-limited workbook prefix, nulls last, and labels for only the linked ids even beyond the first thousand', async () => {
  await startDraft('Workbook', h.owner.id);
  const host = await hostFor('draft');
  const { plan, workbook } = businessWorkbook();
  plan.tables[0].key = 'sales_orders';
  delete plan.reports;
  delete plan.tables[1].titleField;
  const target = createEngineImportTarget(host);
  await target.applyStructure(plan);
  // Ada is loaded first, and will be beyond the generic newest 1,000 read.
  await target.load({
    table: 'customers',
    index: 0,
    records: Array.from({ length: 1002 }, (_, i) => ({
      sourceRow: i + 2,
      references: {},
      values: {
        name: i === 0 ? 'Ada' : `Customer ${i}`,
        email: `${i}@example.test`,
      },
    })),
  });
  await target.load({
    table: 'sales_orders',
    index: 0,
    records: [7, 2, 5, 5, 3].map((sourceRow, i) => ({
      sourceRow,
      values: { price: 100 + i, quantity: 1, status: 'Paid' },
      references: { customer: { table: 'customers', key: ['Ada'] } },
    })),
  });
  await target.seal();
  const customers = await host.list('Customers', 1002);
  const ada = customers.find((row) => row.name === 'Ada')!;
  expect(
    (await host.list('Customers', 1000)).some((row) => row.id === ada.id),
  ).toBe(false);
  // The actual engine definition, not the plan types, decides the label.
  await host.execute(
    {
      type: 'addField',
      model: 'Customers',
      field: 'displayName',
      definition: { type: 'text', label: 'Name' },
    },
    { author: 'test' },
  );
  await host.update('Customers', String(ada.id), { displayName: 'Ada’s shop' });
  await host.execute(
    { type: 'hideField', model: 'Customers', field: 'name' },
    { author: 'test' },
  );
  for (let i = 0; i < 2; i++)
    await host.create('SalesOrders', {
      price: 900 + i,
      quantity: 1,
      status: 'Open',
      customer: ada.id,
    });
  saved.current = {
    id: 'run',
    draftId: (await getDraftSlot())!.id,
    status: 'review',
    state: 'done',
    step: 'review',
    stopReason: null,
    plan: { ...plan, engineNames: target.names },
    proof: {
      ok: true,
      plan,
      facts: checkPlan(plan, workbook).facts,
      findings: [],
      loaded: { customers: 1002, sales_orders: 5 },
      work: 1,
    },
  };
  const lookup = vi.spyOn(host, 'listByIds');
  const generic = vi.spyOn(host, 'list');
  const prefixResponse = await read('?table=sales_orders&limit=3');
  expect(prefixResponse.status).toBe(200);
  expect(prefixResponse.headers.get('cache-control')).toBe('no-store');
  const prefix = await prefixResponse.json();
  expect(prefix.records).toHaveLength(3);
  expect(lookup).toHaveBeenCalledExactlyOnceWith('Customers', [ada.id]);
  expect(generic).not.toHaveBeenCalled();
  const full = await (await read('?table=sales_orders&limit=1000')).json();
  expect(full.records).toHaveLength(7);
  expect(prefix.records).toEqual(full.records.slice(0, 3));
  const original = (await host.list('SalesOrders')).filter(
    (row) => Number(row.price) < 900,
  );
  const tieIds = original
    .filter((row) => row.price === 102 || row.price === 103)
    .map((row) => row.id)
    .sort();
  expect(full.records.map((row: { price: number }) => row.price)).toEqual([
    101,
    104,
    ...tieIds.map((id) => original.find((row) => row.id === id)!.price),
    100,
    ...full.records
      .slice(5)
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id))
      .map((row: { price: number }) => row.price),
  ]);
  for (const row of full.records) {
    expect(full.labels[row.id]).toEqual({ customer: 'Ada’s shop' });
    expect(row).not.toHaveProperty('workbookRow');
    expect(row).not.toHaveProperty('workbookLookup');
  }
  for (const query of [
    '?table=SalesOrders',
    '?table=unknown',
    '?table=orders%22%3BDROP',
    '',
  ])
    expect((await read(query)).status).toBe(404);
  for (const limit of ['0', '1001', '1.5', 'NaN', '-3'])
    expect((await read(`?table=sales_orders&limit=${limit}`)).status).toBe(400);
});
it('refuses anonymous, non-owner and wrong-tenant readers before consulting an import', async () => {
  expect((await read('?table=orders', null)).status).toBe(401);
  expect((await read('?table=orders', h.member)).status).toBe(403);
  expect((await read('?table=orders', h.stranger)).status).toBe(403);
});
it('plainly refuses when no import is ready, even if another draft exists', async () => {
  expect(await (await read('?table=orders')).json()).toEqual({
    error: 'There is no workbook import ready to review.',
  });
  expect((await read('?table=orders')).status).toBe(409);
  await startDraft('Other draft', h.owner.id);
  saved.current = {
    id: 'run',
    draftId: 'old-draft',
    state: 'done',
    status: 'review',
    step: 'review',
    stopReason: null,
    proof: { ok: true } as ImportState['proof'],
  };
  expect((await read('?table=orders')).status).toBe(409);
  saved.current.status = 'running';
  expect((await read('?table=orders')).status).toBe(409);
});
