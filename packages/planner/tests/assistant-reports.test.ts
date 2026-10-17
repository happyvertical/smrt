/**
 * #4100: the browser assistant builds runtime reports. The model only names an
 * intent; the planner's code runs smrt-reports' `reports.runtime.*` steps
 * (sources, define as a preview, run) over the sample data, and only the
 * person's approval saves the report into the plan. Found in Will's QA of
 * #4092: "a summary of all sales last month" could not be built at all.
 */

import {
  parseRuntimeReportSpec,
  runtimeReportSpecDigest,
} from '@happyvertical/smrt-reports/spec';
import { runtimeReportProposalFromMessage } from '@happyvertical/smrt-reports/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatModel,
  createBrowserAssistantTransport,
  REPORT_DEFINE_TOOL,
} from '../src/lib/assistant/transport.ts';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { EPOCH } from '../src/lib/data/fakes.ts';
import { setSamplePack } from '../src/lib/data/packs.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { applyLibraryCookbook } from '../src/lib/library/apply.ts';
import { getLibraryCookbook } from '../src/lib/library/index.ts';
import { createPlannerController } from '../src/lib/planner/commands/index.ts';
import { plannerRuntime } from '../src/lib/planner/instance.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import { openSavedReport } from '../src/lib/reports/planner.ts';
import {
  REPORTS_RECIPE,
  RUNTIME_REPORT_MODEL,
} from '../src/lib/reports/sources.ts';
import { createPlannerReports, reportPath } from '../src/lib/reports/store.ts';

const INVOICE = '@happyvertical/smrt-commerce:Invoice';
const model = (id: string) => {
  const found = getModelByQualifiedName(id)?.model;
  if (!found) throw new Error(id);
  return found;
};

beforeEach(() => recipeState.clear());
afterEach(() => {
  setSamplePack(null);
  recipeState.clear();
  plannerRuntime.openPath = undefined;
});

/** The Mechanic cookbook's app, its sample data, and a scripted model. */
function mechanic(...replies: object[]) {
  const store = new CookbookStore();
  const cookbook = getLibraryCookbook('mechanic');
  if (!cookbook) throw new Error('mechanic');
  expect(applyLibraryCookbook(cookbook, store).ok).toBe(true);
  const data = createMemoryDataSource({ empty: [RUNTIME_REPORT_MODEL] });
  // The sample clock: "last month" is December 2025, where the samples are.
  const reports = createPlannerReports({
    data,
    recipeIds: () => recipeState.ids,
    recipes,
    now: () => new Date(EPOCH),
  });
  const queue = replies.map((reply) => JSON.stringify(reply));
  const message = vi.fn<ChatModel['message']>(
    async () => queue.shift() ?? '{}',
  );
  const setSection = vi.fn();
  const controller = createPlannerController(store, {
    navigation: { getTab: () => 'recipes', setTab: () => {}, setSection },
  });
  const transport = createBrowserAssistantTransport({
    model: () => ({ message }),
    store: recipeState,
    recipes,
    controller,
    menu: () =>
      controller
        .snapshot()
        .sections.filter((s) => !s.hidden)
        .map(({ id, label }) => ({ id, label })),
    reports: () => reports,
  });
  let n = 0;
  const say = async (content: string) =>
    (
      await transport.sendMessage({
        threadId: 'planner',
        content,
        clientRequestId: `r${++n}`,
      })
    ).assistantMessage;
  const saved = async () => data.list(model(RUNTIME_REPORT_MODEL));
  return { data, reports, message, say, saved, setSection, controller };
}

/** Sample invoices issued in December 2025, as the report should count them. */
async function decemberInvoices(
  data: ReturnType<typeof createMemoryDataSource>,
) {
  const rows = (await data.list(model(INVOICE))).filter((row) => {
    const at = typeof row.issueDate === 'string' ? row.issueDate : '';
    return at >= '2025-12-01' && at < '2026-01-01';
  });
  return {
    count: rows.length,
    total: rows.reduce(
      (sum, row) =>
        sum + (typeof row.totalAmount === 'number' ? row.totalAmount : 0),
      0,
    ),
  };
}

const SALES_LAST_MONTH = {
  reply: 'Here is a summary of last month.',
  add: [],
  remove: [],
  report: { source: 'invoices', period: 'last_month' },
};

describe('the assistant builds runtime reports (#4100)', () => {
  it('"a summary of all sales last month" on Mechanic: Reports on, a valid spec, the right totals, saved on approval, then opened', async () => {
    const { data, reports, say, saved, message } = mechanic(SALES_LAST_MONTH);
    expect(recipeState.ids).not.toContain(REPORTS_RECIPE);

    const answer = await say('give me a summary of all sales last month');

    // The prompt and schema offered the capability and the app's sources.
    const [, call] = message.mock.calls[0];
    const system = call?.history?.[0]?.content ?? '';
    expect(system).toContain('"report"');
    expect(system).toMatch(/Report sources: .*invoices \(Invoices\)/);
    const schema = call?.responseSchema as {
      properties: { report: { properties: { source: { enum: string[] } } } };
    };
    expect(schema.properties.report.properties.source.enum).toContain(
      'invoices',
    );

    // Reports was turned on, by a command, and the reply says so.
    expect(recipeState.ids).toContain(REPORTS_RECIPE);
    expect(answer?.content).toMatch(/^Added Reports\./);
    expect(answer?.content).toContain('Approve it to save it');

    // The preview is smrt-reports' own proposal shape.
    const proposal = runtimeReportProposalFromMessage(answer ?? {});
    if (!proposal) throw new Error('no report preview');
    expect((answer?.toolCallData as { name: string }).name).toBe(
      REPORT_DEFINE_TOOL,
    );
    expect(parseRuntimeReportSpec(proposal.spec)).toEqual(proposal.spec);
    expect(proposal.specHash).toBe(
      await runtimeReportSpecDigest(proposal.spec),
    );
    expect(proposal.spec.filters).toEqual([
      { field: 'issueDate', op: 'gte', value: '2025-12-01' },
      { field: 'issueDate', op: 'lt', value: '2026-01-01' },
    ]);

    // Its totals are the sample invoices dated in the previous month.
    const expected = await decemberInvoices(data);
    expect(expected.count).toBeGreaterThan(0);
    expect(proposal.preview.rows).toEqual([
      { number_of_invoices: expected.count, total_amount: expected.total },
    ]);

    // Nothing is saved until the person approves.
    expect(await saved()).toEqual([]);
    const report = await reports.client.confirm(proposal);
    expect(await saved()).toHaveLength(1);

    // Approval opens the saved report under Shared reports.
    const openPath = vi.fn();
    plannerRuntime.openPath = openPath;
    openSavedReport(report);
    expect(openPath).toHaveBeenCalledWith(reportPath(report.id));
    expect(reportPath(report.id)).toBe(
      `/m/reports/RuntimeReport/${report.id}/`,
    );
    const shared = await reports.client.list({
      onlyMine: false,
      includeArchived: false,
    });
    expect(shared.map((r) => r.title)).toEqual(['Invoices, last month']);
    expect((await reports.client.run(report.id)).rows).toEqual(
      proposal.preview.rows,
    );
  });

  it('declining saves nothing', async () => {
    const { say, saved } = mechanic(SALES_LAST_MONTH);
    const answer = await say('give me a summary of all sales last month');
    expect(runtimeReportProposalFromMessage(answer ?? {})).not.toBeNull();
    // Decline is the card's own button and never calls the save; the turn
    // itself saved nothing.
    expect(await saved()).toEqual([]);
  });

  it('asks a follow-up for an intent it cannot build, and turns nothing on', async () => {
    const { say, saved } = mechanic(
      {
        reply: 'Here you go.',
        add: [],
        remove: [],
        report: {
          source: 'invoices',
          measures: [{ fn: 'sum', field: 'mileage' }],
        },
      },
      { reply: 'Sure.', add: [], remove: [] },
    );
    const first = await say('total mileage on invoices');
    expect(first?.content).toMatch(
      /^Which amount on Invoices should I total: .+\?$/,
    );
    expect(first?.toolCallData).toBeUndefined();
    expect(recipeState.ids).not.toContain(REPORTS_RECIPE);

    // A report request with no intent at all asks which records, never guesses.
    const second = await say('can I get a sales report');
    expect(second?.content).toMatch(
      /^Which records should the report cover: .*Invoices.*\?$/,
    );
    expect(await saved()).toEqual([]);
  });

  it('"sales report" never routes to the catalogue', async () => {
    const { say, setSection, controller } = mechanic({
      reply: 'Opening the catalogue.',
      add: ['products.simple'],
      remove: [],
      open: 'section:products',
      report: { source: 'invoices', groupBy: 'status' },
    });
    const before = [...recipeState.ids];
    const answer = await say('sales report');
    expect(setSection).not.toHaveBeenCalled();
    expect(answer?.content).not.toMatch(/catalog|Opened/i);
    expect(runtimeReportProposalFromMessage(answer ?? {})?.spec).toMatchObject({
      source: 'invoices',
      dimensions: [{ field: 'status' }],
    });
    // Only Reports was turned on; the model's other recipe choice was ignored.
    expect(recipeState.ids.filter((id) => !before.includes(id))).toEqual([
      REPORTS_RECIPE,
    ]);
    expect(controller.snapshot().focus?.section).not.toBe('section:products');
  });
});
