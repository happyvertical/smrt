<script lang="ts">
import { ReportDetail, SavedReports } from '@happyvertical/smrt-reports/svelte';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { useDataSource } from '../data/context.ts';
import { appHref } from '../planner/app.svelte.ts';
import { plannerReportsFor } from '../reports/planner.ts';
import { PLANNER_REPORT_AUTHOR, reportPath } from '../reports/store.ts';

interface PlannerReportsProps {
  /** A saved report to open; omitted, the list of shared reports. */
  recordId?: string;
}

let { recordId }: PlannerReportsProps = $props();

// Shared reports are smrt-reports' own screens over the plan's sample data:
// the list is `SavedReports`, a report is `ReportDetail`, which runs it afresh
// (in the browser, over the sample rows) every time it opens.
const reports = plannerReportsFor(useDataSource());
const currency = $derived(cookbookStore.settings().currency);
const reportHref = (id: string) => appHref(reportPath(id));
const authorLabel = (id: string) => (id === PLANNER_REPORT_AUTHOR ? 'You' : id);
</script>

<div class="reports">
  {#if recordId}
    <p><a href={appHref('/m/reports/RuntimeReport/')}>All shared reports</a></p>
    <!-- A new report is a new page: its heading is a new node (focus after a
         dock navigation targets it, #4100). -->
    {#key recordId}
      <ReportDetail id={recordId} client={reports.client} {currency} />
    {/key}
  {:else}
    <SavedReports client={reports.client} {reportHref} {authorLabel} />
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .reports {
    display: grid;
    gap: var(--smrt-spacing-4);
  }
}
</style>
