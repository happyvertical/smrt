/**
 * #4100 in a DOM: the assistant's report preview is smrt-reports' own
 * `ReportConfirmation`, and Shared reports are its `SavedReports` /
 * `ReportDetail`, all over the plan's sample data.
 */
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import PlannerReports from '../src/lib/components/PlannerReports.svelte';
import ReportProposalCard from '../src/lib/components/ReportProposalCard.svelte';
import { DATA_SOURCE_KEY } from '../src/lib/data/context.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { getLibraryCookbook } from '../src/lib/library/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import { plannerReportsFor } from '../src/lib/reports/planner.ts';
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
  component: typeof ReportProposalCard | typeof PlannerReports,
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

describe('report preview and shared reports (#4100)', () => {
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

  it('lists a saved report under Shared reports and runs it on its page', async () => {
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
});
