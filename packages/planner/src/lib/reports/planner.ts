/**
 * The app's runtime reports: `createPlannerReports` over the planner's sample
 * data, the recipes that are on and the sample clock. The assistant, the
 * Shared reports page and a saved report's page all use one of these per
 * data source.
 */

import { announceShellNavigation } from '@happyvertical/smrt-svelte/workspace';
import { EPOCH } from '../data/fakes.ts';
import type { DataSource } from '../data/source.ts';
import { plannerRuntime } from '../planner/instance.ts';
import { recipes } from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import {
  createPlannerReports,
  type PlannerReports,
  reportPath,
} from './store.ts';

const bound = new WeakMap<DataSource, PlannerReports>();

/**
 * Reports over `data`. Periods ("last month") are relative to the sample
 * data's clock (`EPOCH`), as the overview charts are, so they find the rows
 * the sample records carry.
 */
export function plannerReportsFor(data: DataSource): PlannerReports {
  let reports = bound.get(data);
  if (!reports) {
    reports = createPlannerReports({
      data,
      recipeIds: () => recipeState.ids,
      recipes,
      now: () => new Date(EPOCH),
    });
    bound.set(data, reports);
  }
  return reports;
}

/**
 * After the person approved a report: open it under Shared reports, through
 * the running app's own navigation (the static layout's router or a mounted
 * planner's fragment). Unset, the confirmation card's link still reaches it.
 */
export async function openSavedReport(report: { id: string }): Promise<void> {
  await plannerRuntime.openPath?.(reportPath(report.id));
}

/**
 * Open a saved report, then announce the navigation from `from` (inside the
 * dock) so the shell closes an overlaying dock and focuses the report's own
 * heading. Announced only once the app's navigation has finished: a router
 * that resets focus when it lands (SvelteKit's `goto`) would otherwise undo
 * the shell's focus, most visibly when the report is already open.
 */
export async function openSavedReportFrom(
  from: Element | null,
  report: { id: string },
): Promise<void> {
  try {
    await openSavedReport(report);
  } catch {
    // An aborted navigation still leaves the card's link to the report.
  }
  if (from?.isConnected) {
    announceShellNavigation(from, {
      // This report's own heading: never the page the person approved from.
      focus: `[data-smrt-component="ReportDetail"][data-report-id="${CSS.escape(report.id)}"] h1`,
    });
  }
}
