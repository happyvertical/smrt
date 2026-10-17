<script lang="ts">
import {
  ReportConfirmation,
  type RuntimeReportProposal,
  type SavedRuntimeReport,
} from '@happyvertical/smrt-reports/svelte';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { useDataSource } from '../data/context.ts';
import { appHref } from '../planner/app.svelte.ts';
import { openSavedReport, plannerReportsFor } from '../reports/planner.ts';
import { reportPath } from '../reports/store.ts';

interface ReportProposalCardProps {
  /** The assistant's `reports.runtime.define` preview. */
  proposal: RuntimeReportProposal;
}

let { proposal }: ReportProposalCardProps = $props();

// smrt-reports' own confirmation card. Approve is the person's click and
// nothing else: it saves the report into the plan (the browser's confirmed
// save), then opens it under Shared reports. Decline saves nothing.
const reports = plannerReportsFor(useDataSource());
const currency = $derived(cookbookStore.settings().currency);
const onsaved = (report: SavedRuntimeReport) => openSavedReport(report);
</script>

<ReportConfirmation
  {proposal}
  confirm={reports.save}
  reportHref={(id) => appHref(reportPath(id))}
  {onsaved}
  {currency}
/>
