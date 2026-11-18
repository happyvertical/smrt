// Real shell database and engine workers; only SvelteKit's request event is supplied.
import {
  checkLoaded,
  runImport,
} from '@happyvertical/smrt-spreadsheets/import';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { businessWorkbook } from '../../test-support/import-workbook.ts';
import { toRuntimeModel } from '../engine/definition.ts';
import { createEngineImportTarget } from '../engine/import-target.ts';
import { startDraft } from '../lib/server/drafts.ts';
import { closeHost, hostFor } from '../lib/server/host.ts';
import { openShell, type ShellHarness } from '../lib/server/test-support.ts';
import * as approvalRoute from './api/shell/approvals/[id]/+server.ts';
import * as publishRoute from './api/shell/draft/publish/+server.ts';
import * as recordsRoute from './api/shell/records/[model]/+server.ts';
import * as recordRoute from './api/shell/records/[model]/[id]/+server.ts';

let h: ShellHarness;
beforeEach(async () => {
  h = await openShell();
});
afterEach(async () => {
  await h.close();
});

function event(
  path: string,
  method: string,
  body: unknown,
  params: Record<string, string> = {},
) {
  const url = new URL(path, 'http://shell');
  return {
    url,
    params,
    request: new Request(url, {
      method,
      headers: { origin: url.origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    locals: {
      user: { id: h.owner.id },
      tenantId: h.owner.tenantId,
      permissions: [],
    },
  } as never;
}

it.each([
  ['draft', 'host'],
  ['draft', 'route'],
  ['live', 'host'],
  ['live', 'route'],
] as const)('creates and updates imported records on %s through the %s after sealing', async (copy, surface) => {
  await startDraft('Workbook', h.owner.id);
  const draft = await hostFor('draft');
  const fixture = businessWorkbook();
  const orders = fixture.plan.tables[0];
  for (const field of orders.fields) field.required = true;
  // A formula retained as a plain cached value is an ordinary, fillable input.
  orders.fields.push({
    key: 'cached_total',
    label: 'Workbook total',
    type: 'number',
    column: 4,
    required: true,
  });
  const target = createEngineImportTarget(draft);
  const proof = await runImport({ ...fixture, target });
  expect(proof.ok).toBe(true);
  for (const model of Object.values(draft.def.models)) {
    expect(model.fields.workbookRow.required).toBeFalsy();
    expect(model.fields.workbookLookup.required).toBeFalsy();
  }
  await target.seal();
  const retainedProof = structuredClone(proof);
  if (copy === 'live') {
    const pendingResponse = await publishRoute.POST(
      event('/api/shell/draft/publish', 'POST', {}),
    );
    expect(pendingResponse.status).toBe(202);
    const pending = await pendingResponse.json();
    expect(pending.status).toBe('pending_approval');
    const decision = await approvalRoute.POST(
      event(
        `/api/shell/approvals/${pending.approvalId}`,
        'POST',
        { approve: true },
        { id: pending.approvalId },
      ),
    );
    expect(decision.status).toBe(200);
    expect((await decision.json()).status).toBe('approved');
  }
  const host = await hostFor(copy);
  const write = async (
    model: string,
    values: Record<string, unknown>,
    id?: string,
  ) => {
    if (surface === 'host')
      return id ? host.update(model, id, values) : host.create(model, values);
    const path = `/api/shell/records/${model}${id ? `/${id}` : ''}?target=${copy}`;
    const response = id
      ? await recordRoute.PUT(event(path, 'PUT', values, { model, id }))
      : await recordsRoute.POST(event(path, 'POST', values, { model }));
    expect(response.status).toBe(id ? 200 : 201);
    return response.json();
  };
  const customer = await write('Customers', {
    name: 'Lin',
    email: 'lin@example.test',
  });
  expect(customer).toMatchObject({ name: 'Lin', email: 'lin@example.test' });
  const original = (await host.list('Customers')).find(
    (row) => row.name === 'Ada',
  );
  if (!original) throw new Error('Missing imported customer');
  expect(
    await write(
      'Customers',
      { email: 'ada.updated@example.test' },
      String(original.id),
    ),
  ).toMatchObject({ email: 'ada.updated@example.test' });
  const order = await write('Orders', {
    customer: customer.id,
    price: 250,
    quantity: 4,
    status: 'Open',
    cachedTotal: 10,
  });
  expect(order).toMatchObject({
    customer: customer.id,
    total: 1000,
    cachedTotal: 10,
  });
  expect(
    await write('Orders', { quantity: 5, cachedTotal: 12.5 }, String(order.id)),
  ).toMatchObject({ customer: customer.id, total: 1250, cachedTotal: 12.5 });
  expect(host.describe().models.Customers.fields.name.required).toBe(true);
  expect(host.describe().models.Orders.fields.customer.required).toBe(true);
  expect(host.describe().models.Orders.fields.cachedTotal.required).toBe(true);
  expect(
    toRuntimeModel('Orders', host.def.models.Orders).fields?.total.required,
  ).toBe(false);
  await expect(
    host.create('Customers', { email: 'missing-name@example.test' }),
  ).rejects.toThrow(/name.*required/i);
  await expect(
    host.create('Orders', {
      price: 250,
      quantity: 4,
      status: 'Open',
      cachedTotal: 10,
    }),
  ).rejects.toThrow(/customer.*required/i);
  await expect(
    host.create('Orders', {
      customer: customer.id,
      price: 250,
      quantity: 4,
      status: 'Open',
    }),
  ).rejects.toThrow(/cachedTotal.*required/i);
  const rows = await host.readStoredRows(
    'Orders',
    ['workbookRow', 'workbookLookup', 'total'],
    'workbookRow',
  );
  expect(rows.filter((row) => row.workbookRow != null)).toEqual([
    { workbookRow: 4, workbookLookup: '[]', total: 2500 },
    { workbookRow: 5, workbookLookup: '[]', total: 1500 },
  ]);
  expect(rows.filter((row) => row.workbookRow == null)).toEqual([
    { workbookRow: null, workbookLookup: null, total: 1250 },
  ]);
  expect(proof).toEqual(retainedProof);
  if (copy === 'draft') {
    const readback = [];
    for await (const row of target.values('orders', ['total']))
      readback.push(row);
    expect(readback).toEqual([
      { sourceRow: 4, values: { total: 2500 } },
      { sourceRow: 5, values: { total: 1500 } },
    ]);
    const selected = [];
    for await (const row of target.values('orders', ['total'], [4]))
      selected.push(row);
    expect(selected).toEqual([readback[0]]);
    // Owner additions change counts, but must never be checked as fictitious workbook row 0.
    const recheck = await checkLoaded(
      proof.plan,
      fixture.workbook,
      target,
      proof.facts,
    );
    expect(recheck.findings.map((finding) => finding.code)).toEqual([
      'row-count-mismatch',
      'row-count-mismatch',
    ]);
  }
});

it('repairs a persisted pre-release sealed import through a fresh draft and owner publish approval', async () => {
  for (const phase of ['legacy', 'repair']) {
    await startDraft(phase, h.owner.id);
    const draft = await hostFor('draft');
    if (phase === 'legacy') {
      await draft.execute(
        {
          type: 'defineModel',
          name: 'Customers',
          fields: {
            workbookRow: {
              type: 'integer',
              label: 'Workbook row',
              required: true,
            },
            workbookLookup: { type: 'text', label: 'Workbook lookup' },
            name: { type: 'text', required: true },
          },
        },
        { author: h.owner.id },
      );
      await draft.execute(
        {
          type: 'loadRecords',
          model: 'Customers',
          mode: 'insert',
          rows: [{ name: 'Ada', workbookRow: 2, workbookLookup: '["Ada"]' }],
        },
        { author: h.owner.id },
      );
      await draft.execute(
        { type: 'hideField', model: 'Customers', field: 'workbookLookup' },
        { author: h.owner.id },
      );
    } else {
      // A versioned conversion rebuilds the physical NOT NULL column as nullable.
      await draft.execute(
        {
          type: 'changeFieldType',
          model: 'Customers',
          field: 'workbookRow',
          to: { type: 'integer', required: false },
        },
        { author: h.owner.id },
      );
    }
    await draft.execute(
      { type: 'hideField', model: 'Customers', field: 'workbookRow' },
      { author: h.owner.id },
    );
    const request = await publishRoute.POST(
      event('/api/shell/draft/publish', 'POST', {}),
    );
    expect(request.status).toBe(202);
    const { approvalId } = await request.json();
    const decision = await approvalRoute.POST(
      event(
        `/api/shell/approvals/${approvalId}`,
        'POST',
        { approve: true },
        { id: approvalId },
      ),
    );
    expect((await decision.json()).status).toBe('approved');
    await closeHost();
    const live = await hostFor('live');
    if (phase === 'legacy') {
      await expect(live.create('Customers', { name: 'Lin' })).rejects.toThrow(
        /workbook_row.*missing/i,
      );
    } else {
      expect(await live.create('Customers', { name: 'Lin' })).toMatchObject({
        name: 'Lin',
      });
      const stored = await live.readStoredRows(
        'Customers',
        ['workbookRow'],
        'workbookRow',
      );
      expect(stored).toEqual([{ workbookRow: null }, { workbookRow: 2 }]);
      expect(live.def.models.Customers.fields.workbookRow).toMatchObject({
        required: false,
        hidden: true,
      });
    }
  }
});

it('requires real workbook rows on import batches before inserting anything', async () => {
  await startDraft('Workbook', h.owner.id);
  const target = createEngineImportTarget(await hostFor('draft'));
  await target.applyStructure(businessWorkbook().plan);
  for (const sourceRow of [0, undefined as never]) {
    await expect(
      target.load({
        table: 'customers',
        index: 0,
        records: [
          { sourceRow: 2, values: { name: 'Ada' }, references: {} },
          { sourceRow, values: { name: 'Grace' }, references: {} },
        ],
      }),
    ).rejects.toThrow();
    expect(await target.count('customers')).toBe(0);
  }
  await target.load({
    table: 'customers',
    index: 0,
    records: [{ sourceRow: 2, values: { name: 'Ada' }, references: {} }],
  });
  const rows = [];
  for await (const row of target.values('customers', ['name'])) rows.push(row);
  expect(rows).toEqual([{ sourceRow: 2, values: { name: 'Ada' } }]);
});
