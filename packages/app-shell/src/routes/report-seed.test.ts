import { readFileSync } from 'node:fs';
import { RuntimeReportError } from '@happyvertical/smrt-reports';
import { expect, it } from 'vitest';
import { toolSummary } from '../lib/assistant/tool-summary.ts';
import { applyOwnBatch } from '../lib/server/approvals.ts';
import {
  call,
  drive,
  say,
  scripted,
} from '../lib/server/assistant/test-helpers.ts';
import { runCommand } from '../lib/server/builder.ts';
import { changesState, flushChecks } from '../lib/server/changes.ts';
import { getHost } from '../lib/server/host.ts';
import { callTool } from '../lib/server/policy.ts';
import { openShell, runAs } from '../lib/server/test-support.ts';
import { hostOwner } from '../test/engine-principal.ts';
import { GET } from './api/shell/reports/[name]/+server.ts';
import { GET as csv } from './api/shell/reports/[name]/csv/+server.ts';
import { load } from './reports/[name]/+page.server.ts';

async function importSeed(
  h: Awaited<ReturnType<typeof openShell>>,
  data: unknown,
) {
  await runAs(h.owner, async () => {
    const waiting = await runCommand(
      { type: 'importTemplate', data } as never,
      h.owner,
    );
    expect(waiting).toMatchObject({ status: 'change_waiting' });
    await changesState();
    await flushChecks();
    const state = await changesState();
    expect(state.canApply).toBe(true);
    await applyOwnBatch(state.digest);
  });
}

it('the production QA seed imports into an empty app and exercises report states', async () => {
  const h = await openShell();
  try {
    const seed = JSON.parse(
      readFileSync(
        new URL('../../agents/reports-ui-seed.json', import.meta.url),
        'utf8',
      ),
    );
    // The template's records travel with its card and arrive on Apply.
    await importSeed(h, seed.data);
    const host = await getHost();
    expect(
      (await host.runReport(hostOwner(host), 'salesByCustomer')).rows,
    ).toHaveLength(3);
    expect(
      (await host.runReport(hostOwner(host), 'salesByMonth')).chart.type,
    ).toBe('line');
    expect(
      (await host.runReport(hostOwner(host), 'emptyOrders')).rows,
    ).toHaveLength(0);
    expect(
      (await host.runReport(hostOwner(host), 'limitedCustomers')).truncated,
    ).toBe(true);
    const rows = await host.list(hostOwner(host), 'Order');
    expect(
      rows.map((r) => r.total).sort((a, b) => Number(a) - Number(b)),
    ).toEqual([1250, 5000, 11250]);
  } finally {
    await h.close();
  }
});

it('explains an unsafe seeded total consistently across the worker, page, CSV and assistant', async () => {
  const h = await openShell();
  try {
    const seed = JSON.parse(
      readFileSync(
        new URL('../../agents/reports-ui-seed.json', import.meta.url),
        'utf8',
      ),
    );
    // The template's records travel with its card and arrive on Apply.
    await importSeed(h, seed.data);
    const host = await getHost();
    const [order] = await host.list(hostOwner(host), 'Order');
    const huge = await host.create(hostOwner(host), 'Order', {
      title: 'Large order',
      customer: order.customer,
      issuedAt: order.issuedAt,
      status: order.status,
      quantity: 1,
      price: Number.MAX_SAFE_INTEGER,
    });
    expect(huge.price).toBe(Number.MAX_SAFE_INTEGER);
    await expect(
      host.runReport(hostOwner(host), 'salesByCustomer'),
    ).rejects.toMatchObject({
      code: 'invalid_result',
      path: 'total',
    });
    await expect(
      host.runReport(hostOwner(host), 'salesByCustomer'),
    ).rejects.toBeInstanceOf(RuntimeReportError);
    const message =
      'The total of Total is too large to show exactly. One of the Orders probably has a mistyped Quantity or Price.';
    const event = {
      request: new Request(
        'http://localhost/api/shell/reports/salesByCustomer',
      ),
      url: new URL('http://localhost/api/shell/reports/salesByCustomer'),
      params: { name: 'salesByCustomer' },
      locals: {
        user: { id: h.owner.id },
        tenantId: h.owner.tenantId,
        permissions: [],
      },
    } as never;
    for (const route of [GET, csv]) {
      const response = await route(event);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: message });
    }
    const page = await load({
      ...(event as object),
      parent: async () => ({
        description: { ...host.describe(), mode: 'live' },
      }),
      params: { name: 'salesByCustomer' },
      depends() {},
      fetch: async () => GET(event),
    } as never);
    expect(page).toMatchObject({ result: null, problem: message });
    const failedTool = await callTool(h.owner, 'app_runreport', {
      report: 'salesByCustomer',
    });
    expect(failedTool.isError).toBe(true);
    expect(
      toolSummary('app_runreport', JSON.stringify(failedTool), false),
    ).toBe(message);
    const { model } = scripted([
      () => say('', call('app_runreport', { report: 'salesByCustomer' })),
      () => say('Please check the order.'),
    ]);
    const out = await drive({ principal: h.owner, model });
    expect(out.events.find((e) => e.type === 'tool_result')).toMatchObject({
      ok: false,
      summary: message,
    });
    expect(JSON.stringify(out.events)).not.toMatch(
      /SELECT|app\.db|safe range|RuntimeReportError/,
    );
  } finally {
    await h.close();
  }
});
