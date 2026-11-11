import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runCommand } from '../lib/server/builder.ts';
import { getHost } from '../lib/server/host.ts';
import { openShell } from '../lib/server/test-support.ts';

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
