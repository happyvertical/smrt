import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ENGINE_TOOLS } from '../../engine/tool-definitions.ts';
import { hostOwner } from '../../test/engine-principal.ts';
import { discardChanges, waitingCount } from './changes.ts';
import { historyFor } from './drafts.ts';
import { getHost } from './host.ts';
import { callTool, toolsFor } from './policy.ts';
import {
  applyWaiting,
  openShell,
  runAs,
  type ShellHarness,
} from './test-support.ts';

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
  // structure waits for the owner; apply it so the records below have a model
  await applyWaiting(h.owner);
  const host = await getHost();
  await host.create(hostOwner(host), 'Sale', { amount: 100 });
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
  await applyWaiting(h.owner);
  const result = await callTool(h.owner, 'app_runreport', {
    report: 'sales',
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
  const repeated = await callTool(h.owner, 'app_loadrecords', {
    model: 'Sale',
    mode: 'upsert',
    key: ['amount'],
    rows: [{ amount: 200 }, { amount: 300 }],
  });
  expect(repeated.structuredContent).toMatchObject({
    summary: 'Loaded 0 Sale: 0 inserted, 0 updated, 2 unchanged',
  });
  // the load waits: live has only the first record until the owner applies
  expect(await host.countRows(hostOwner(host), 'Sale')).toBe(1);
  await applyWaiting(h.owner);
  expect(loaded.structuredContent).toMatchObject({
    summary: 'Loaded 2 Sale: 2 inserted, 0 updated, 0 unchanged',
  });
  const gated = await callTool(h.owner, 'app_setcalculation', {
    model: 'Sale',
    field: 'amount',
    calculated: { value: 9 },
  });
  expect(gated.pending).toBeUndefined();
  expect(gated.structuredContent).toMatchObject({ status: 'change_waiting' });
  expect(
    (await host.list(hostOwner(host), 'Sale')).map((row) => row.amount).sort(),
  ).toEqual([100, 200, 300]);
  await runAs(h.owner, () => discardChanges());
});

it('uses the kept record label in a draft merge summary without exposing ids', async () => {
  await callTool(h.owner, 'app_definemodel', {
    name: 'Customer',
    label: 'Customers',
    fields: { name: { type: 'text' } },
  });
  await applyWaiting(h.owner);
  const host = await getHost();
  const keep = await host.create(hostOwner(host), 'Customer', {
    name: 'Acme Ltd',
  });
  const other = await host.create(hostOwner(host), 'Customer', {
    name: 'Duplicate',
  });
  const result = await callTool(h.owner, 'app_mergerecords', {
    model: 'Customer',
    keep: keep.id,
    merge: [other.id],
  });
  expect(result.structuredContent).toMatchObject({
    summary: 'Merged 1 Customers into Acme Ltd',
    humanSummary: 'Merge 1 record in Customers',
  });
  const history = await historyFor('draft');
  expect(history.at(-1)).toMatchObject({
    humanSummary: 'Merge 1 record in Customers',
  });
  expect(
    JSON.stringify(
      history.map(
        (v) => (v as unknown as { humanSummary: string }).humanSummary,
      ),
    ),
  ).not.toContain(String(keep.id));
  await runAs(h.owner, () => discardChanges());
});

it('describes a report key rename as a link change without printing either key', async () => {
  try {
    const result = await callTool(h.owner, 'app_renamereport', {
      from: 'sales',
      to: 'draftSummary',
    });
    expect(result.structuredContent).toMatchObject({
      summary: 'Changed the link of report Revenue.',
    });
    expect(
      (result.structuredContent as { summary: string }).summary,
    ).not.toMatch(/sales|draftSummary/);
  } finally {
    await runAs(h.owner, () => discardChanges());
  }
});

it('rejects malformed arguments and inherited names without presentation crashes', async () => {
  for (const [name, args] of [
    [
      'app_setcalculation',
      { model: 'constructor', field: 'toString', calculated: {} },
    ],
    [
      'app_extractmodel',
      { model: 'Sale', field: 'constructor', into: 'Buyer' },
    ],
    ['app_mergerecords', { model: 'Sale', keep: {}, merge: [] }],
    ['app_renamereport', { from: 'constructor', to: 'renamed' }],
    ['app_runreport', { report: 'constructor' }],
    ['app_removereport', { name: {} }],
  ] as const) {
    const before = (await getHost()).version;
    const outcome = await callTool(h.owner, name, args as never).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    if (outcome.error !== undefined) {
      expect(String(outcome.error)).not.toMatch(
        /Cannot read properties|is not a function/,
      );
    } else {
      expect(outcome.value?.isError).toBe(true);
      expect(JSON.stringify(outcome.value)).not.toMatch(
        /Cannot read properties|is not a function/,
      );
    }
    expect((await getHost()).version).toBe(before);
  }
});

it.each([
  'approved',
  'calcluated',
  'type',
  'constructor',
])('refuses unknown tool argument %s without storing a change', async (key) => {
  const host = await getHost();
  const version = host.version;
  const definition = structuredClone(host.def);
  await expect(
    callTool(h.owner, 'app_setcalculation', {
      model: 'Sale',
      field: 'amount',
      calculated: null,
      [key]: true,
    }),
  ).rejects.toThrow('unknown tool argument');
  expect(host.version).toBe(version);
  expect(host.def).toEqual(definition);
  expect(await runAs(h.owner, () => waitingCount())).toBe(0);
});

it('runs a not-equal report however the filter is spelled, and explains a bad comparison in plain words (#5172)', async () => {
  await callTool(h.owner, 'app_definemodel', {
    name: 'Order',
    fields: { status: { type: 'text' }, qty: { type: 'integer' } },
  });
  await applyWaiting(h.owner);
  const host = await getHost();
  for (const status of ['Open', 'Open', 'Cancelled', null])
    await host.create(hostOwner(host), 'Order', { status, qty: 1 });
  const count = async (filter: Record<string, unknown>) => {
    const out = await callTool(h.owner, 'app_runreport', {
      report: {
        title: 'Orders',
        source: 'Order',
        measures: [{ fn: 'count', as: 'order_count' }],
        filters: [filter],
      },
    });
    if (out.isError) throw new Error(JSON.stringify(out.structuredContent));
    return (out.structuredContent as { rows: { order_count: number }[] })
      .rows[0].order_count;
  };
  const viaGrammar = await count({
    field: 'status',
    op: 'ne',
    value: 'Cancelled',
  });
  for (const op of ['!=', '<>', 'neq', 'not_equal', 'notEqual', ' NE '])
    expect(await count({ field: 'status', op, value: 'Cancelled' })).toBe(
      viaGrammar,
    );
  expect(viaGrammar).toBeGreaterThanOrEqual(2);
  const advertised = JSON.stringify(
    ENGINE_TOOLS.find((t) => t.name === 'app_runreport'),
  );
  expect(advertised).toContain('eq, ne, gt');
  const failed = await callTool(h.owner, 'app_runreport', {
    report: {
      title: 'Orders',
      source: 'Order',
      measures: [{ fn: 'count', as: 'order_count' }],
      filters: [{ field: 'status', op: 'sounds-like', value: 'Open' }],
    },
  });
  const value = failed.structuredContent as {
    summary: string;
    error: string;
  };
  expect(failed.isError).toBe(true);
  // The model gets the path and the real reason so it can correct itself ...
  expect(value.error).toContain('spec.filters[0].op');
  expect(value.error).toContain('eq, ne');
  expect(value.error).not.toContain('Report could not run');
  // ... the owner gets one plain sentence the chip will actually show.
  expect(value.summary).toBe(
    'A filter in that report used a comparison the app cannot do, so nothing was run.',
  );
});
