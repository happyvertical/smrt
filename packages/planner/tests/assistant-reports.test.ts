/**
 * #4100: the browser assistant builds runtime reports. The model only names an
 * intent; the planner's code runs smrt-reports' `reports.runtime.*` steps
 * (sources, define as a preview, run) over the sample data, and only the
 * person's approval saves the report into the plan. Found in Will's QA of
 * #4092: "a summary of all sales last month" could not be built at all.
 */

import { assistantQuestionFromMessage } from '@happyvertical/smrt-chat/svelte';
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
  return {
    data,
    reports,
    message,
    say,
    saved,
    setSection,
    controller,
    transport,
  };
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
  for (const stage of ['model report', 'question answer'] as const) {
    it(`fences a pending ${stage} definition after reset while a new turn owns busy state`, async () => {
      const test = mechanic({
        reply: 'Report',
        add: [],
        remove: [],
        report: {
          source: 'invoices',
          groupBy: stage === 'question answer' ? 'flavour' : 'status',
        },
      });
      const first =
        stage === 'question answer'
          ? await test.say('invoices by flavour')
          : undefined;
      const question = assistantQuestionFromMessage(first ?? {});
      let entered!: () => void;
      const defining = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const define = test.reports.define.bind(test.reports);
      vi.spyOn(test.reports, 'define').mockImplementationOnce(
        async (...args) => {
          const result = await define(...args);
          expect(result.ok).toBe(true);
          entered();
          await held;
          return result;
        },
      );
      const old =
        stage === 'question answer'
          ? test.transport.answerQuestion!({
              threadId: 'planner',
              messageId: first!.id,
              questionId: question!.id,
              values: { groupBy: 'status' },
              clientRequestId: 'old-answer',
            })
          : test.say('report invoices by status');
      await defining;
      test.transport.reset();
      recipeState.clear();
      test.controller.resetWorkspace?.();
      let resolveFresh!: (value: string) => void;
      test.message.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFresh = resolve;
          }),
      );
      const fresh = test.say('fresh question');
      release();
      await old;
      expect(recipeState.ids).not.toContain(REPORTS_RECIPE);
      expect(test.transport.busy).toBe(true);
      expect(
        test.transport.conversation().map((message) => message.content),
      ).toEqual(['What would you like to build?', 'fresh question']);
      resolveFresh('{"reply":"Fresh answer","add":[],"remove":[]}');
      expect((await fresh)?.content).not.toContain('could not answer');
      expect(test.transport.busy).toBe(false);
    });
  }
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
    expect((answer?.toolCallData as { name: string } | undefined)?.name).toBe(
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

    // Approval opens the saved report under Saved reports.
    const openPath = vi.fn();
    plannerRuntime.openPath = openPath;
    await openSavedReport(report);
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

  it('asks a follow-up for an intent it cannot build, then never repeats it', async () => {
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
    expect(first?.content).toBe('Which amount on Invoices should I total?');
    // The choices are a form (smrt-chat's structured question), not prose,
    // and the document total leads.
    const amount = assistantQuestionFromMessage(first ?? {});
    expect(amount?.fields[0].options[0].label).toBe('Total amount');
    expect(amount?.fields[0].default).toBe('totalAmount');
    expect(recipeState.ids).not.toContain(REPORTS_RECIPE);

    // A reply that answers nothing is a miss: the default is taken and said,
    // never the identical question again.
    const second = await say('hmm, not sure');
    expect(second?.content).toMatch(
      /^Added Reports\. I went with Total amount\. Here is a preview/,
    );
    expect(await saved()).toEqual([]);
  });

  it('a report request with no intent asks which records, as a form', async () => {
    const { say } = mechanic({ reply: 'Sure.', add: [], remove: [] });
    const answer = await say('can I get a sales report');
    expect(answer?.content).toBe('Which records should the report cover?');
    const question = assistantQuestionFromMessage(answer ?? {});
    expect(question?.fields[0].options[0].label).not.toBe('Customers');
    expect(question?.fields[0].options.map((o) => o.label)).toContain(
      'Invoices',
    );
  });

  it('adding Reports alone builds nothing, so it still asks which records', async () => {
    const { say } = mechanic({
      reply: 'Done.',
      add: [REPORTS_RECIPE],
      remove: [],
    });
    const answer = await say('summarize sales last month');
    expect(answer?.content).toMatch(
      /^Added Reports\. Which records should the report cover\?$/,
    );
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

  it('"sales by month": the invoice date by month, no follow-up, totals per month', async () => {
    for (const report of [
      { source: 'invoices' },
      { source: 'invoices', groupBy: 'month' },
      { source: 'invoices', groupBy: 'the date month' },
    ]) {
      recipeState.clear();
      const { data, say } = mechanic({
        reply: 'Here.',
        add: [],
        remove: [],
        report,
      });
      const answer = await say('Show me a report of sales by month');
      const proposal = runtimeReportProposalFromMessage(answer ?? {});
      if (!proposal)
        throw new Error(`no preview for ${JSON.stringify(report)}`);
      expect(proposal.spec.dimensions).toEqual([
        { field: 'issueDate', bucket: 'month', as: 'issue_date_month' },
      ]);
      // Totals per month match the sample invoices' issue dates.
      const rows = await data.list(model(INVOICE));
      const expected = new Map<string, { n: number; total: number }>();
      for (const row of rows) {
        if (typeof row.issueDate !== 'string') continue;
        const month = `${row.issueDate.slice(0, 7)}-01T00:00:00.000Z`;
        const entry = expected.get(month) ?? { n: 0, total: 0 };
        entry.n += 1;
        entry.total +=
          typeof row.totalAmount === 'number' ? row.totalAmount : 0;
        expected.set(month, entry);
      }
      expect(proposal.preview.rows).toEqual(
        [...expected.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([month, { n, total }]) => ({
            issue_date_month: month,
            number_of_invoices: n,
            total_amount: total,
          })),
      );
    }
  });

  it('offers human groupings, then resolves "the date month" without the model', async () => {
    const { say, message } = mechanic({
      reply: 'Here.',
      add: [],
      remove: [],
      report: { source: 'invoices', groupBy: 'flavour' },
    });
    const first = await say('a report of invoices by flavour and date');
    expect(first?.content).toBe('Group Invoices by…');
    const question = assistantQuestionFromMessage(first ?? {});
    const labels = question?.fields[0].options.map((o) => o.label) ?? [];
    // Time came up, so the natural date by month leads.
    expect(labels[0]).toBe('Issue date by month');
    expect(labels).toEqual(expect.arrayContaining(['Status', 'Customer']));
    for (const internal of [
      'Id',
      'Money authority',
      'Historical source key hash',
      'Invoice number',
      'Reference',
      'External',
    ]) {
      expect(labels).not.toContain(internal);
    }
    const calls = message.mock.calls.length;
    const second = await say('the date month');
    expect(message.mock.calls.length).toBe(calls);
    expect(
      runtimeReportProposalFromMessage(second ?? {})?.spec.dimensions,
    ).toEqual([
      { field: 'issueDate', bucket: 'month', as: 'issue_date_month' },
    ]);
  });

  it('a submitted follow-up form continues with no model call and reads back as answered', async () => {
    const { say, message, transport } = mechanic({
      reply: 'Here.',
      add: [],
      remove: [],
      report: { source: 'invoices', groupBy: 'flavour' },
    });
    const first = await say('a report of invoices by flavour');
    const question = assistantQuestionFromMessage(first ?? {});
    if (!question || !first) throw new Error('no form');
    const calls = message.mock.calls.length;
    const result = await transport.answerQuestion?.({
      threadId: 'planner',
      messageId: first.id,
      questionId: question.id,
      values: { groupBy: 'status' },
      clientRequestId: 'answer-1',
    });
    expect(message.mock.calls.length).toBe(calls);
    expect(
      runtimeReportProposalFromMessage(result?.assistantMessage ?? {})?.spec
        .dimensions,
    ).toEqual([{ field: 'status', as: 'status' }]);
    // The transcript keeps the question, now answered (a read-only summary).
    const stored = (await transport.loadMessages('planner')).find(
      (m) => m.id === first.id,
    );
    expect(assistantQuestionFromMessage(stored ?? {})?.answer).toEqual({
      groupBy: 'status',
    });
  });

  it('a typed answer keeps its own words, and a different request goes to the model', async () => {
    const { say, message } = mechanic(
      {
        reply: 'Here.',
        add: [],
        remove: [],
        report: { source: 'invoices', groupBy: 'flavour' },
      },
      { reply: 'Added invoicing.', add: ['commerce.invoicing'], remove: [] },
      {
        reply: 'Here.',
        add: [],
        remove: [],
        report: { source: 'invoices', groupBy: 'flavour' },
      },
    );
    await say('a report of invoices by flavour');
    const calls = message.mock.calls.length;
    const answer = await say('status last month');
    expect(message.mock.calls.length).toBe(calls);
    const spec = runtimeReportProposalFromMessage(answer ?? {})?.spec;
    expect(spec?.dimensions).toEqual([{ field: 'status', as: 'status' }]);
    expect(spec?.filters).toEqual([
      { field: 'issueDate', op: 'gte', value: '2025-12-01' },
      { field: 'issueDate', op: 'lt', value: '2026-01-01' },
    ]);

    // A threshold or a period the code cannot read goes to the model.
    for (const reply of ['status over 500', 'status next month']) {
      await say('a report of invoices by flavour');
      const n = message.mock.calls.length;
      await say(reply);
      expect(message.mock.calls.length, reply).toBe(n + 1);
    }

    // A new follow-up, then an unrelated request: the model sees it.
    await say('a report of invoices by flavour');
    const before = message.mock.calls.length;
    await say('add the invoicing recipe please');
    expect(message.mock.calls.length).toBe(before + 1);
  });

  it('keeps a report answer on the transcript, so a reload shows it', async () => {
    const { say, transport } = mechanic(SALES_LAST_MONTH);
    const answer = await say('give me a summary of all sales last month');
    const proposal = runtimeReportProposalFromMessage(answer ?? {});
    if (!proposal || !answer) throw new Error('no preview');
    const changes: unknown[][] = [];
    const unsubscribe = transport.subscribeConversation((messages) =>
      changes.push(messages),
    );
    transport.recordReportOutcome(proposal.specHash, { status: 'declined' });
    expect(changes).toHaveLength(2);
    expect(changes[0]).not.toEqual(changes[1]);
    expect(transport.conversation()).toEqual(changes[1]);
    unsubscribe();
    const reloaded = (await transport.loadMessages('planner')).find(
      (m) => m.id === answer.id,
    );
    expect(
      (reloaded?.toolCallData as { outcome?: unknown } | undefined)?.outcome,
    ).toEqual({
      status: 'declined',
    });
  });
});
