<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from './messages.js';
import ReportResult from './ReportResult.svelte';
import { reportError, validReportProposal } from './result.js';
import type { RuntimeReportProposal, SavedRuntimeReport } from './types.js';

export interface Props {
  proposal: RuntimeReportProposal;
  /** Posts the exact displayed spec and hash to the authenticated confirm route. */
  confirm: (proposal: RuntimeReportProposal) => Promise<SavedRuntimeReport>;
  reportHref?: (id: string) => string;
  ondecline?: () => void;
  onsaved?: (report: SavedRuntimeReport) => void;
  locale?: string;
  currency?: string;
}
let {
  proposal,
  confirm,
  reportHref = (id) => `/reports/${encodeURIComponent(id)}`,
  ondecline,
  onsaved,
  locale = 'en',
  currency = 'USD',
}: Props = $props();
const { t } = useI18n();
let status = $state<'idle' | 'saving' | 'declined' | 'saved'>('idle');
let saved = $state<SavedRuntimeReport | null>(null);
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
const label = (field: string) => field;
async function approve(event: MouseEvent) {
  // Approval is an immediate local human action, never a model-callable tool.
  if (!event.isTrusted || status !== 'idle' || !valid) return;
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
  if (status !== 'idle') return;
  status = 'declined';
  ondecline?.();
}
</script>

<section data-smrt-component="ReportConfirmation" aria-label={t(M['reports.confirm_title'])}>
  <h2>{valid ? proposal.spec.title : t(M['reports.confirm_title'])}</h2>
  {#if !valid}
    <p role="alert">{t(M['reports.invalid'])}</p>
  {:else if saved}
    <p role="status">{t(M['reports.saved'])}</p>
    <a href={reportHref(saved.id)}>{saved.title}</a>
  {:else if status === 'declined'}
    <p role="status">{t(M['reports.declined'])}</p>
  {:else}
    {#if proposal.spec.description}<p>{proposal.spec.description}</p>{/if}
    <dl>
      <dt>{t(M['reports.source'])}</dt><dd>{proposal.sourceLabel}</dd>
      <dt>{t(M['reports.groupings'])}</dt>
      <dd>{#each proposal.spec.dimensions as d (d.as)}<p>{label(d.field)}{#if d.bucket} · {t(`reports.bucket.${d.bucket}`)}{/if}</p>{:else}{t(M['reports.none'])}{/each}</dd>
      <dt>{t(M['reports.measures'])}</dt>
      <dd>{#each proposal.spec.measures as m (m.as)}<p>{t(`reports.aggregate.${m.fn}`, { field: m.field ? label(m.field) : t(M['reports.rows']) })}</p>{/each}</dd>
      <dt>{t(M['reports.filters'])}</dt>
      <dd>{#each proposal.spec.filters as f, i (i)}<p>{label(f.field)} {t(`reports.operator.${f.op}`)} {Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '')}</p>{:else}{t(M['reports.none'])}{/each}</dd>
      {#if proposal.spec.having.length}<dt>{t(M['reports.having'])}</dt><dd>{#each proposal.spec.having as h, i (i)}<p>{h.measure} {t(`reports.operator.${h.op}`)} {h.value}</p>{/each}</dd>{/if}
    </dl>
    <ReportResult result={proposal.preview} {locale} {currency} />
    {#if error}<p role="alert">{t(M[error])}</p>{/if}
    <Button disabled={status === 'saving'} onclick={approve}>{t(M[status === 'saving' ? 'reports.saving' : 'reports.approve'])}</Button>
    <Button disabled={status === 'saving'} onclick={decline}>{t(M['reports.decline'])}</Button>
  {/if}
</section>
