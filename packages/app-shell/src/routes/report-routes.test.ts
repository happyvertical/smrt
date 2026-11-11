import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { runCommand } from '../lib/server/builder.ts';
import {
  discardNow,
  historyFor,
  previewDraft,
  startDraft,
} from '../lib/server/drafts.ts';
import { hostFor } from '../lib/server/host.ts';
import { openShell, type ShellHarness } from '../lib/server/test-support.ts';
import { GET, POST } from './api/shell/reports/[name]/+server.ts';
import { GET as csv } from './api/shell/reports/[name]/csv/+server.ts';

let h: ShellHarness;
const spec = {
  version: 1,
  title: 'Totals',
  source: 'Order',
  dimensions: [{ field: 'customer', as: 'customer' }],
  measures: [{ fn: 'sum', field: 'amount', as: 'total' }],
  chart: { type: 'table' },
};
beforeAll(async () => {
  h = await openShell();
  await runCommand(
    {
      type: 'defineModel',
      name: 'Customer',
      fields: { name: { type: 'text' } },
    },
    h.owner.id,
    'live',
  );
  await runCommand(
    {
      type: 'defineModel',
      name: 'Order',
      fields: {
        customer: { type: 'reference', ref: 'Customer' },
        amount: { type: 'money' },
      },
    },
    h.owner.id,
    'live',
  );
  const host = await hostFor('live');
  const c = await host.create('Customer', { name: 'Acme, "Ltd"' });
  await host.create('Order', { customer: c.id, amount: 1250 });
  await runCommand(
    {
      type: 'defineReport',
      name: 'sales',
      definition: { label: 'Sales', spec },
    } as never,
    h.owner.id,
    'live',
  );
});
afterAll(async () => {
  await h.close();
});
function event(
  who: typeof h.owner | null,
  target = 'live',
  body?: unknown,
  name = 'sales',
) {
  const url = new URL(
    `http://localhost/api/shell/reports/${name}?target=${target}`,
  );
  return {
    url,
    params: { name },
    request: new Request(url, {
      method: body ? 'POST' : 'GET',
      headers: { origin: url.origin, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    locals: who
      ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] }
      : { user: null, tenantId: null },
  } as never;
}
it('requires the owner for results, CSV and mutations, including a different tenant', async () => {
  for (const call of [GET, csv, POST])
    for (const who of [null, h.member, h.stranger])
      expect((await call(event(who))).status).toBe(who ? 403 : 401);
});
it('runs and exports display labels, money and RFC 4180 quotes', async () => {
  expect((await GET(event(h.owner))).status).toBe(200);
  const response = await csv(event(h.owner));
  expect(response.headers.get('content-type')).toContain('text/csv');
  expect(await response.text()).toContain('"Acme, ""Ltd""",$12.50\r\n');
  expect((await GET(event(h.owner, 'wrong'))).status).toBe(400);
  expect((await GET(event(h.owner, 'draft'))).status).toBe(404);
  expect((await csv(event(h.owner, 'live', undefined, 'missing'))).status).toBe(
    404,
  );
});
it('renames and removes only in the draft; history and preview use plain words', async () => {
  await startDraft('Reports', h.owner.id);
  expect(
    (await POST(event(h.owner, 'live', { action: 'remove' }))).status,
  ).toBe(409);
  expect(
    (await POST(event(h.owner, 'draft', { action: 'rename', to: 'newSales' })))
      .status,
  ).toBe(200);
  expect((await previewDraft()).preview.versions.at(-1)?.summary).toContain(
    'Renamed report Sales',
  );
  expect((await historyFor('draft')).at(-1)?.summary).toContain(
    'Renamed report Sales',
  );
  expect((await GET(event(h.owner, 'live'))).status).toBe(200);
  expect((await GET(event(h.owner, 'draft'))).status).toBe(404);
  expect(
    (await POST(event(h.owner, 'draft', { action: 'remove' }, 'newSales')))
      .status,
  ).toBe(200);
  expect(
    (await POST(event(h.owner, 'draft', { action: 'bogus' }))).status,
  ).toBe(400);
  await discardNow();
});

it('redacts compiler and timeout failures for both reads and CSV', async () => {
  const host = await hostFor('live');
  for (const call of [GET, csv]) {
    const failed = vi
      .spyOn(host, 'runReport')
      .mockRejectedValueOnce(new Error('SELECT password FROM /private/app.db'));
    const response = await call(event(h.owner));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toMatch(/SELECT|password|private/);
    failed.mockRestore();
    const timeout = vi
      .spyOn(host, 'runReport')
      .mockRejectedValueOnce(new Error('report time limit exceeded'));
    expect(await (await call(event(h.owner))).text()).toContain(
      'took too long',
    );
    timeout.mockRestore();
  }
});
