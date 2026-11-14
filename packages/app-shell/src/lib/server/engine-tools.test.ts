import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { discardNow, startDraft } from './drafts.ts';
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
  expect(result.structuredContent).toMatchObject({
    summary: 'Ran Revenue: 1 row',
    reportName: 'sales',
  });
  const loaded = await callTool(h.owner, 'app_loadrecords', {
    model: 'Sale',
    mode: 'insert',
    rows: [{ amount: 200 }, { amount: 300 }],
  });
  expect(loaded.structuredContent).toMatchObject({ summary: 'Loaded 2 Sale' });
  const gated = await callTool(h.owner, 'app_setcalculation', {
    model: 'Sale',
    field: 'amount',
    calculated: { value: 9 },
    approved: true,
  });
  expect(gated.pending?.status).toBe('pending_approval');
  expect((await host.list('Sale')).map((row) => row.amount).sort()).toEqual([
    100, 200, 300,
  ]);
});

it('uses the kept record label in a draft merge summary without exposing ids', async () => {
  await callTool(h.owner, 'app_definemodel', {
    name: 'Customer',
    label: 'Customers',
    fields: { name: { type: 'text' } },
  });
  const host = await getHost();
  const keep = await host.create('Customer', { name: 'Acme Ltd' });
  const other = await host.create('Customer', { name: 'Duplicate' });
  await startDraft('Merge', h.owner.id);
  const result = await callTool(
    h.owner,
    'app_mergerecords',
    { model: 'Customer', keep: keep.id, merge: [other.id] },
    { structure: 'draft', records: 'draft' },
  );
  expect(result.structuredContent).toMatchObject({
    summary: 'Merged 1 Customers into Acme Ltd',
  });
  await discardNow();
});

it('describes a report key rename as a link change without printing either key', async () => {
  await startDraft('Report link', h.owner.id);
  try {
    const result = await callTool(
      h.owner,
      'app_renamereport',
      { from: 'sales', to: 'draftSummary' },
      { structure: 'draft', records: 'draft' },
    );
    expect(result.structuredContent).toMatchObject({
      summary: 'Changed the link of report Revenue.',
    });
    expect(
      (result.structuredContent as { summary: string }).summary,
    ).not.toMatch(/sales|draftSummary/);
  } finally {
    await discardNow();
  }
});
