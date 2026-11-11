import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getHost } from './host.ts';
import { callTool, toolsFor } from './policy.ts';
import { openShell, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
});
afterAll(async () => {
  await h.close();
});
it('offers engine additions only to the owner and dispatches reports through the named target', async () => {
  expect(await toolsFor(h.member)).toEqual([]);
  await expect(
    callTool(h.member, 'app_runreport', { report: 'sales' }),
  ).rejects.toMatchObject({ status: 403 });
  expect((await toolsFor(h.owner)).map((t) => t.name)).toContain(
    'app_runreport',
  );
  await callTool(h.owner, 'app_definemodel', {
    name: 'Sale',
    fields: { amount: { type: 'money' } },
  });
  const host = await getHost();
  await host.create('Sale', { amount: 100 });
  const spec = parseRuntimeReportSpec({
    version: 1,
    title: 'Revenue',
    source: 'Sale',
    measures: [{ fn: 'sum', field: 'amount', as: 'total' }],
  });
  await callTool(h.owner, 'app_definereport', {
    name: 'sales',
    definition: { spec },
  });
  const result = await callTool(h.owner, 'app_runreport', {
    report: 'sales',
    approved: true,
  });
  expect(JSON.stringify(result.structuredContent)).toContain('100');
  const gated = await callTool(h.owner, 'app_setcalculation', {
    model: 'Sale',
    field: 'amount',
    calculated: { value: 9 },
    approved: true,
  });
  expect(gated.pending?.status).toBe('pending_approval');
  expect((await host.list('Sale'))[0].amount).toBe(100);
});
