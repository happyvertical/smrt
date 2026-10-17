/**
 * #4100 in a DOM: the assistant's report preview is smrt-reports' own
 * `ReportConfirmation`, and Saved reports are its `SavedReports` /
 * `ReportDetail`, all over the plan's sample data.
 */
import { AssistantDock } from '@happyvertical/smrt-chat/svelte';
import { SHELL_NAVIGATED_EVENT } from '@happyvertical/smrt-svelte/workspace';
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserAssistantTransport } from '../src/lib/assistant/transport.ts';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import PlannerReports from '../src/lib/components/PlannerReports.svelte';
import PlannerSavedReportsWidget from '../src/lib/components/PlannerSavedReportsWidget.svelte';
import ReportProposalCard from '../src/lib/components/ReportProposalCard.svelte';
import { DATA_SOURCE_KEY } from '../src/lib/data/context.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { getLibraryCookbook } from '../src/lib/library/index.ts';
import { resolveRecipeExport } from '../src/lib/overviews/registry.ts';
import { plannerRuntime } from '../src/lib/planner/instance.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import {
  openSavedReportFrom,
  plannerReportsFor,
} from '../src/lib/reports/planner.ts';
import {
  REPORTS_RECIPE,
  RUNTIME_REPORT_MODEL,
} from '../src/lib/reports/sources.ts';

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.replaceChildren();
  recipeState.clear();
});

function app() {
  const cookbook = getLibraryCookbook('mechanic');
  if (!cookbook) throw new Error('mechanic');
  recipeState.add(...cookbook.document.recipes, REPORTS_RECIPE);
  const data = createMemoryDataSource({ empty: [RUNTIME_REPORT_MODEL] });
  return { data, reports: plannerReportsFor(data) };
}

function render(
  component:
    | typeof ReportProposalCard
    | typeof PlannerReports
    | typeof PlannerSavedReportsWidget,
  props: Record<string, unknown>,
  data: ReturnType<typeof createMemoryDataSource>,
) {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(
    mount(component as never, {
      target,
      props,
      context: new Map([[DATA_SOURCE_KEY, data]]),
    }),
  );
  return target;
}

const button = (root: HTMLElement, name: RegExp) => {
  const found = [...root.querySelectorAll('button')].find((b) =>
    name.test(b.textContent ?? ''),
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
};

describe('report preview and saved reports (#4100)', () => {
  it('declining the preview saves nothing; only a real click approves', async () => {
    const { data, reports } = app();
    const defined = await reports.define({
      source: 'invoices',
      period: 'last_month',
    });
    if (!defined.ok) throw new Error(defined.question);
    const root = render(
      ReportProposalCard,
      { proposal: defined.proposal },
      data,
    );
    await settle();
    expect(root.textContent).toContain('Invoices, last month');
    const stored = () => {
      const model = getModelByQualifiedName(RUNTIME_REPORT_MODEL)?.model;
      if (!model) throw new Error('RuntimeReport');
      return data.list(model);
    };

    // A scripted click is not the person's: Approve ignores it.
    button(root, /approve/i).click();
    await settle();
    expect(await stored()).toEqual([]);

    button(root, /decline/i).click();
    await settle();
    expect(root.querySelector('[role="status"]')).not.toBeNull();
    expect(await stored()).toEqual([]);
  });

  it('announces the opened report only once the app has finished navigating', async () => {
    // A router (SvelteKit's goto) blurs and resets focus as it lands, even on
    // the page already open: announcing first would let it undo the shell's
    // focus on the report heading (R12-F1).
    let finish: () => void = () => {};
    const previous = plannerRuntime.openPath;
    const opened: string[] = [];
    plannerRuntime.openPath = (path) => {
      opened.push(path);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    const card = document.createElement('div');
    document.body.append(card);
    const announced: string[] = [];
    document.addEventListener(SHELL_NAVIGATED_EVENT, (event) => {
      announced.push(
        (event as CustomEvent<{ focus?: string }>).detail.focus ?? '',
      );
    });
    try {
      const done = openSavedReportFrom(card, { id: 'rpt-1' });
      await settle();
      expect(opened).toEqual(['/m/reports/RuntimeReport/rpt-1/']);
      expect(announced).toEqual([]);

      finish();
      await done;
      expect(announced).toEqual([
        '[data-smrt-component="ReportDetail"][data-report-id="rpt-1"] h1',
      ]);
    } finally {
      plannerRuntime.openPath = previous;
    }
  });

  it('the Reports section page is the saved reports as cards, from the recipe widget', async () => {
    const { data, reports } = app();
    const defined = await reports.define({
      source: 'invoices',
      period: 'last_month',
    });
    if (!defined.ok) throw new Error(defined.question);
    await reports.save(defined.proposal);
    // The overview registry resolves smrt-reports' widget to the planner's.
    const Widget = await resolveRecipeExport(
      '@happyvertical/smrt-reports/svelte',
      'SavedReportsWidget',
    );
    expect(Widget).toBe(PlannerSavedReportsWidget);
    const root = render(
      PlannerSavedReportsWidget as never,
      { options: {} },
      data,
    );
    await settle();
    const card = root.querySelector('[data-smrt-component="SavedReportCard"]');
    expect(card?.textContent).toContain('Invoices, last month');
    expect(card?.textContent).toContain('Saved by you');
    expect(card?.querySelector('a')?.getAttribute('href')).toMatch(
      /\/m\/reports\/RuntimeReport\/.+\/$/,
    );
  });

  it('lists a saved report under Saved reports and runs it on its page', async () => {
    const { data, reports } = app();
    const defined = await reports.define({
      source: 'invoices',
      period: 'last_month',
    });
    if (!defined.ok) throw new Error(defined.question);
    const saved = await reports.save(defined.proposal);

    const list = render(PlannerReports, {}, data);
    await settle();
    expect(list.textContent).toContain('Invoices, last month');

    const page = render(PlannerReports, { recordId: saved.id }, data);
    await settle();
    expect(
      page.querySelector('[data-smrt-component="ReportResult"]'),
    ).not.toBeNull();
  });

  it('shows a report follow-up as a form, and its submit continues with no model call', async () => {
    const { reports } = app();
    let calls = 0;
    const transport = createBrowserAssistantTransport({
      model: () => ({
        async message() {
          calls += 1;
          return JSON.stringify({
            reply: 'Here.',
            add: [],
            remove: [],
            report: { source: 'invoices', groupBy: 'flavour' },
          });
        },
      }),
      store: recipeState,
      recipes,
      reports: () => reports,
    });
    let controller:
      | {
          openThread(id: string): Promise<void>;
          send(text: string): Promise<void>;
        }
      | undefined;
    const target = document.createElement('div');
    document.body.append(target);
    mounted.push(
      mount(AssistantDock as never, {
        target,
        props: {
          transport,
          registry: createDataSurfaceRegistry(),
          oncontroller: (c: typeof controller) => {
            controller = c;
          },
        },
      }),
    );
    await settle();
    await controller?.openThread('planner');
    await controller?.send('a report of invoices by flavour and date');
    await settle();
    const fieldset = [...target.querySelectorAll('fieldset')].find((f) =>
      f.querySelector('legend')?.textContent?.includes('Group Invoices by'),
    );
    expect(fieldset).toBeDefined();
    // Eight groupings: a select, the natural date by month preselected.
    const select = fieldset?.querySelector('select');
    expect(select?.value).toBe('issueDate:month');
    expect(
      [...(select?.options ?? [])].map((o) => o.textContent?.trim()),
    ).not.toContain('Historical source key hash');
    expect(calls).toBe(1);
    button(target, /continue/i).click();
    await settle();
    expect(calls).toBe(1);
    expect(target.textContent).toContain(
      'Here is a preview of Invoices by month',
    );
    expect(target.querySelector('input[type="radio"]')).toBeNull();
    expect(target.textContent).toContain('Group by: Issue date by month');
  });

  it('records a decline on the transcript data, and a reloaded card shows the answer', async () => {
    const { data, reports } = app();
    const defined = await reports.define({
      source: 'invoices',
      period: 'last_month',
    });
    if (!defined.ok) throw new Error(defined.question);
    const recorded: unknown[] = [];
    const first = render(
      ReportProposalCard,
      {
        proposal: defined.proposal,
        onoutcome: (o: unknown) => recorded.push(o),
      },
      data,
    );
    await settle();
    button(first, /decline/i).click();
    await settle();
    expect(recorded).toEqual([{ status: 'declined' }]);
    // The same transcript data rendered again (a reload): no live buttons.
    const again = render(
      ReportProposalCard,
      { proposal: defined.proposal, answered: recorded[0] },
      data,
    );
    await settle();
    const actions = (root: HTMLElement) =>
      [...root.querySelectorAll('button')].filter((b) =>
        /approve|decline/i.test(b.textContent ?? ''),
      );
    expect(actions(again)).toEqual([]);
    expect(again.textContent).toContain('Declined — nothing saved');
    const saved = render(
      ReportProposalCard,
      {
        proposal: defined.proposal,
        answered: { status: 'saved', report: { id: 'r1', title: 'x' } },
      },
      data,
    );
    await settle();
    expect(actions(saved)).toEqual([]);
    expect(saved.querySelector('a')?.getAttribute('href')).toContain(
      '/m/reports/RuntimeReport/r1/',
    );
  });
});
