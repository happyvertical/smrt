import { afterAll, beforeAll, expect, it } from 'vitest';
import { callTool } from '../policy.ts';
import { openShell, type ShellHarness } from '../test-support.ts';
import { call, drive, say, scripted } from './test-helpers.ts';
import { historyFor, viewMessages } from './threads.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
  await callTool(h.owner, 'app_definemodel', {
    name: 'Sale',
    fields: { amount: { type: 'money' } },
  });
  const made = await callTool(h.owner, 'app_definereport', {
    name: 'sales',
    definition: {
      label: 'Sales by month',
      spec: {
        version: 1,
        title: 'Sales by month',
        source: 'Sale',
        measures: [{ fn: 'count', as: 'total' }],
      },
    },
  });
  expect(made.structuredContent).toMatchObject({
    summary: 'Made the report Sales by month',
  });
});
afterAll(async () => {
  await h.close();
});
it('streams a shared report projection, saves only human text and a link', async () => {
  const { model } = scripted([
    () => say('', call('app_runreport', { report: 'sales' })),
    () => say('Here is your report.'),
  ]);
  const out = await drive({
    principal: h.owner,
    model,
    limits: { toolResultChars: 32 },
  });
  const result = out.events.find((e) => e.type === 'tool_result');
  expect(result).toMatchObject({
    summary: 'Ran Sales by month: 1 row',
    report: { href: '/reports/sales', result: { rowCount: 1 } },
  });
  const messages = await viewMessages(out.threadId);
  expect(messages.find((m) => m.tool)?.tool).toMatchObject({
    summary: 'Ran Sales by month: 1 row',
    reportHref: '/reports/sales',
  });
  const history = await historyFor(out.threadId);
  expect(history.find((m) => m.role === 'tool')?.content).toBe(
    'Ran Sales by month: 1 row',
  );
});
it('an ad-hoc run has a result but no saved-report link', async () => {
  const { model } = scripted([
    () =>
      say(
        '',
        call('app_runreport', {
          report: {
            version: 1,
            title: 'One time',
            source: 'Sale',
            measures: [{ fn: 'count', as: 'total' }],
          },
        }),
      ),
    () => say('Done.'),
  ]);
  const out = await drive({ principal: h.owner, model });
  const result = out.events.find((e) => e.type === 'tool_result');
  expect(result?.type === 'tool_result' && result.report?.result.title).toBe(
    'One time',
  );
  expect(result?.type === 'tool_result' && result.report?.href).toBeUndefined();
});
