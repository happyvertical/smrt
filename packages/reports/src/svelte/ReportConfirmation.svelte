<script lang="ts">
import { formatWidgetValue } from '@happyvertical/smrt-ui/charts';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from './messages.js';
import ReportResult from './ReportResult.svelte';
import { reportError, validReportProposal } from './result.js';
import type { RuntimeReportProposal, SavedRuntimeReport } from './types.js';

/** How a confirmation was answered; it then renders as a read-only line. */
export type ReportConfirmationOutcome =
  | { status: 'saved'; report: Pick<SavedRuntimeReport, 'id' | 'title'> }
  | { status: 'declined' };

export interface Props {
  proposal: RuntimeReportProposal;
  /** Posts the exact displayed spec and hash to the authenticated confirm route. */
  confirm: (proposal: RuntimeReportProposal) => Promise<SavedRuntimeReport>;
  reportHref?: (id: string) => string;
  ondecline?: () => void;
  onsaved?: (report: SavedRuntimeReport) => void;
  /**
   * An earlier answer (from the transcript): the card shows its outcome line
   * and offers no buttons, so a reloaded or re-rendered card cannot approve
   * twice.
   */
  outcome?: ReportConfirmationOutcome | null;
  /**
   * The source's field labels and formats (its descriptor's `fields`), so
   * groupings and filters read "Issue date", "Total amount" and money, not
   * model field names. Omitted, names are humanized.
   */
  fields?: readonly { name: string; label: string; format?: string }[];
  locale?: string;
  currency?: string;
}
let {
  proposal,
  confirm,
  reportHref = (id) => `/reports/${encodeURIComponent(id)}`,
  ondecline,
  onsaved,
  outcome = null,
  fields = [],
  locale = 'en',
  currency = 'USD',
}: Props = $props();
const { t } = useI18n();
let status = $state<'idle' | 'saving' | 'declined' | 'saved'>('idle');
let saved = $state<Pick<SavedRuntimeReport, 'id' | 'title'> | null>(null);
let error = $state<ReturnType<typeof reportError> | null>(null);
let epoch = 0;
$effect(() => {
  proposal;
  confirm;
  ++epoch;
  status = 'idle';
  saved = null;
  error = null;
  return () => {
    ++epoch;
  };
});
const valid = $derived(validReportProposal(proposal));
const answered = $derived<ReportConfirmationOutcome | null>(
  outcome ??
    (status === 'saved' && saved
      ? { status: 'saved', report: saved }
      : status === 'declined'
        ? { status: 'declined' }
        : null),
);
const humanize = (name: string) =>
  name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
const fieldOf = (name: string) => fields.find((f) => f.name === name);
const label = (name: string) => fieldOf(name)?.label ?? humanize(name);
/** A result column's own label ("Total amount", "Number of invoices"). */
const columnLabel = (id: string) =>
  proposal.preview.columns.find((c) => c.id === id)?.label ?? humanize(id);
function value(field: string, raw: unknown) {
  const show = (v: unknown) =>
    fieldOf(field)?.format === 'money' && typeof v === 'number'
      ? formatWidgetValue(v, { format: 'money', currency, locale })
      : String(v ?? '');
  return Array.isArray(raw) ? raw.map(show).join(', ') : show(raw);
}
async function approve(event: MouseEvent) {
  // Approval is an immediate local human action, never a model-callable tool.
  if (!event.isTrusted || status !== 'idle' || !valid || answered) return;
  const current = epoch;
  const specHash = proposal.specHash;
  status = 'saving';
  error = null;
  try {
    const result = await confirm({ ...proposal, specHash });
    if (current !== epoch) return;
    saved = result;
    status = 'saved';
    onsaved?.(result);
  } catch (e) {
    if (current === epoch) {
      status = 'idle';
      error = reportError(e);
    }
  }
}
function decline() {
  if (status !== 'idle' || answered) return;
  status = 'declined';
  ondecline?.();
}
</script>

<section data-smrt-component="ReportConfirmation" aria-label={t(M['reports.confirm_title'])}>
  <h3 class="report-confirmation-title">{valid ? proposal.spec.title : t(M['reports.confirm_title'])}</h3>
  {#if !valid}
    <p role="alert">{t(M['reports.invalid'])}</p>
  {:else}
    {#if proposal.spec.description}<p class="report-confirmation-description">{proposal.spec.description}</p>{/if}
    <dl class="report-confirmation-facts">
      <div><dt>{t(M['reports.source'])}</dt><dd>{proposal.sourceLabel}</dd></div>
      <div>
        <dt>{t(M['reports.groupings'])}</dt>
        <dd>{#if proposal.spec.dimensions.length}{proposal.spec.dimensions.map((d) => d.bucket ? t(M['reports.dimension_bucket'], { field: label(d.field), bucket: t(`reports.bucket_unit.${d.bucket}`) }) : label(d.field)).join(', ')}{:else}{t(M['reports.none'])}{/if}</dd>
      </div>
      <div><dt>{t(M['reports.measures'])}</dt><dd>{proposal.spec.measures.map((m) => columnLabel(m.as)).join(', ')}</dd></div>
      {#if proposal.spec.filters.length}
        <div><dt>{t(M['reports.filters'])}</dt><dd>{proposal.spec.filters.map((f) => `${label(f.field)} ${t(`reports.operator.${f.op}`)} ${value(f.field, f.value)}`.trim()).join('; ')}</dd></div>
      {/if}
      {#if proposal.spec.having.length}
        <div><dt>{t(M['reports.having'])}</dt><dd>{proposal.spec.having.map((h) => `${columnLabel(h.measure)} ${t(`reports.operator.${h.op}`)} ${h.value}`).join('; ')}</dd></div>
      {/if}
    </dl>
    <ReportResult result={proposal.preview} {locale} {currency} />
    {#if answered?.status === 'saved'}
      <p class="report-confirmation-outcome" role="status">{t(M['reports.saved'])} · <a href={reportHref(answered.report.id)}>{t(M['reports.open'])}</a></p>
    {:else if answered?.status === 'declined'}
      <p class="report-confirmation-outcome" role="status">{t(M['reports.declined'])}</p>
    {:else}
      {#if error}<p role="alert">{t(M[error])}</p>{/if}
      <div class="report-confirmation-actions">
        <Button variant="secondary" disabled={status === 'saving'} onclick={decline}>{t(M['reports.decline'])}</Button>
        <Button disabled={status === 'saving'} aria-busy={status === 'saving'} onclick={approve}>{t(M[status === 'saving' ? 'reports.saving' : 'reports.approve'])}</Button>
      </div>
    {/if}
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  [data-smrt-component='ReportConfirmation'] { display: grid; gap: var(--smrt-spacing-3); inline-size: 100%; min-inline-size: 0; box-sizing: border-box; padding: var(--smrt-spacing-3); border: var(--smrt-hairline); border-radius: var(--smrt-radius-large); background: var(--smrt-color-surface-container); color: var(--smrt-color-on-surface); container-type: inline-size; }
  .report-confirmation-title { margin: 0; font: var(--smrt-typography-title-medium-font); overflow-wrap: anywhere; }
  .report-confirmation-description { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-size); }
  .report-confirmation-facts { display: grid; gap: var(--smrt-spacing-1); margin: 0; font-size: var(--smrt-typography-body-small-size); }
  .report-confirmation-facts > div { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); gap: var(--smrt-spacing-2); align-items: baseline; }
  .report-confirmation-facts dt { color: var(--smrt-color-on-surface-variant); }
  .report-confirmation-facts dd { margin: 0; overflow-wrap: anywhere; }
  .report-confirmation-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--smrt-spacing-2); }
  /* A narrow dock: labels over values, and the actions share the row. */
  @container (max-width: 12rem) {
    .report-confirmation-facts > div { grid-template-columns: minmax(0, 1fr); gap: 0; }
  }
  @container (max-width: 22rem) {
    .report-confirmation-actions > :global(*) { flex: 1 1 0; }
  }
  .report-confirmation-outcome { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-size); }
}
</style>
