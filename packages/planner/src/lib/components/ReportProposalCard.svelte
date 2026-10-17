<script lang="ts">
import {
  ReportConfirmation,
  type ReportConfirmationOutcome,
  type RuntimeReportProposal,
  type SavedRuntimeReport,
} from '@happyvertical/smrt-reports/svelte';
import { announceShellNavigation } from '@happyvertical/smrt-svelte/workspace';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { useDataSource } from '../data/context.ts';
import { appHref } from '../planner/app.svelte.ts';
import { openSavedReport, plannerReportsFor } from '../reports/planner.ts';
import { reportPath } from '../reports/store.ts';

interface ReportProposalCardProps {
  /** The assistant's `reports.runtime.define` preview. */
  proposal: RuntimeReportProposal;
  /**
   * The transcript's tool data this preview rides on: its `outcome` is how
   * the card was answered, kept there so a re-rendered or reloaded card shows
   * the answer instead of live buttons.
   */
  reference?: { outcome?: ReportConfirmationOutcome };
}

let { proposal, reference }: ReportProposalCardProps = $props();

// smrt-reports' own confirmation card. Approve is the person's click and
// nothing else: it saves the report into the plan (the browser's confirmed
// save), then opens it under Shared reports; the shell closes a dock laid
// over the page and focuses the report's heading. Decline saves nothing.
const reports = plannerReportsFor(useDataSource());
const currency = $derived(cookbookStore.settings().currency);
const fields = $derived(reports.fieldsFor(proposal.spec.source));
let outcome = $state<ReportConfirmationOutcome | null>(
  (() => reference?.outcome ?? null)(),
);
let element = $state<HTMLDivElement | null>(null);
function record(next: ReportConfirmationOutcome) {
  outcome = next;
  if (reference) reference.outcome = next;
}
function onsaved(report: SavedRuntimeReport) {
  record({ status: 'saved', report: { id: report.id, title: report.title } });
  openSavedReport(report);
  if (element) {
    announceShellNavigation(element, {
      focus: '[data-smrt-component="ReportDetail"] h1',
    });
  }
}
</script>

<div bind:this={element}>
  <ReportConfirmation
    {proposal}
    confirm={reports.save}
    reportHref={(id) => appHref(reportPath(id))}
    {onsaved}
    ondecline={() => record({ status: 'declined' })}
    {outcome}
    {fields}
    {currency}
  />
</div>
