import { readFileSync } from 'node:fs';
import { RuntimeReportError } from '@happyvertical/smrt-reports';
import { expect, it } from 'vitest';
import { toolSummary } from '../lib/assistant/tool-summary.ts';
import {
  call,
  drive,
  say,
  scripted,
} from '../lib/server/assistant/test-helpers.ts';
import { runCommand } from '../lib/server/builder.ts';
import { getHost } from '../lib/server/host.ts';
import { callTool } from '../lib/server/policy.ts';
import { openShell } from '../lib/server/test-support.ts';
import { GET } from './api/shell/reports/[name]/+server.ts';
import { GET as csv } from './api/shell/reports/[name]/csv/+server.ts';
import { load } from './reports/[name]/+page.server.ts';

it('the production QA seed imports into an empty app and exercises report states', async () => {
  const h = await openShell();
  try {
    const seed = JSON.parse(
      readFileSync(
        new URL('../../agents/reports-ui-seed.json', import.meta.url),
        'utf8',
      ),
    );
    await runCommand(
      { type: 'importTemplate', data: seed.data },
      h.owner.id,
      'live',
    );
    const host = await getHost();
    expect((await host.runReport('salesByCustomer')).rows).toHaveLength(3);
    expect((await host.runReport('salesByMonth')).chart.type).toBe('line');
    expect((await host.runReport('emptyOrders')).rows).toHaveLength(0);
    expect((await host.runReport('limitedCustomers')).truncated).toBe(true);
    const rows = await host.list('Order');
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
    await runCommand(
      { type: 'importTemplate', data: seed.data },
      h.owner.id,
      'live',
    );
    const host = await getHost();
    const [order] = await host.list('Order');
    const huge = await host.create('Order', {
      title: 'Large order',
      customer: order.customer,
      issuedAt: order.issuedAt,
      status: order.status,
      quantity: 1,
      price: Number.MAX_SAFE_INTEGER,
    });
    expect(huge.price).toBe(Number.MAX_SAFE_INTEGER);
    await expect(host.runReport('salesByCustomer')).rejects.toMatchObject({
      code: 'invalid_result',
      path: 'total',
    });
    await expect(host.runReport('salesByCustomer')).rejects.toBeInstanceOf(
      RuntimeReportError,
    );
    const message =
      'The total of Total is too large to show exactly. One of the Orders probably has a mistyped Quantity or Price.';
    const event = {
      request: new Request(
        'http://localhost/api/shell/reports/salesByCustomer',
      ),
      url: new URL(
        'http://localhost/api/shell/reports/salesByCustomer?target=live',
      ),
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
