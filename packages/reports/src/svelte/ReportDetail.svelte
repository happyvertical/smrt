<script lang="ts">
/**
 * A saved report's page: its title and description, what it covers (source,
 * groupings, the period with its dates, measures, filters, who saved it and
 * when it last ran), then its result run afresh: headline figures and a chart
 * or table. The primary action follows the report's state: Edit (asks the
 * page's assistant), Try again after a failed run, Restore when archived.
 * Export CSV sits beside it; Re-run and Archive are in the "more" menu.
 */
import { requestAssistant } from '@happyvertical/smrt-ui/chat';
import { ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge, Button, Menu } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import {
  describeReport,
  type ReportSourceInfo,
  relativeTime,
  reportCsv,
} from './describe.js';
import { M } from './messages.js';
import ReportResult from './ReportResult.svelte';
import { reportCell, reportError, validReportResult } from './result.js';
import type {
  RuntimeReportResult,
  RuntimeReportsClient,
  SavedRuntimeReport,
} from './types.js';

export interface Props {
  id: string;
  client?: RuntimeReportsClient;
  /** The report sources by label and fields (`reports.runtime.sources`). */
  sources?: readonly ReportSourceInfo[];
  /** Host-owned identity projection ("You"); others stay unnamed. */
  authorLabel?: (userId: string) => string | undefined;
  /** Called with the report once it loads (a host titles its page with it). */
  onreport?: (report: SavedRuntimeReport) => void;
  /** Replace Edit asking the page's assistant. */
  onedit?: (report: SavedRuntimeReport) => void;
  locale?: string;
  currency?: string;
}
let {
  id,
  client,
  sources = [],
  authorLabel = () => undefined,
  onreport,
  onedit,
  locale = 'en',
  currency = 'USD',
}: Props = $props();
const { t } = useI18n();
let report = $state<SavedRuntimeReport | null>(null);
let result = $state<RuntimeReportResult | null>(null);
let error = $state<ReturnType<typeof reportError> | null>(null);
let loading = $state(false);
let revision = $state(0);
let view = $state<'chart' | 'table'>('chart');
let confirming = $state(false);
let archiving = $state(false);
let askNote = $state(false);
let root = $state<HTMLElement | null>(null);
let shownId: string | null = null;
$effect(() => {
  const transport = client;
  const reportId = id;
  revision;
  let active = true;
  // A re-run keeps the report shown; another report starts blank.
  if (shownId !== reportId) report = null;
  shownId = reportId;
  result = null;
  error = null;
  loading = !!transport;
  if (transport) {
    void (async () => {
      try {
        const saved = await transport.get(reportId);
        if (!active) return;
        report = saved;
        untrack(() => onreport)?.(saved);
        if (saved.status === 'archived') return;
        const value = await transport.run(reportId);
        if (!active) return;
        if (!validReportResult(value)) error = 'reports.invalid';
        else result = value;
      } catch (e) {
        if (active) error = reportError(e);
      } finally {
        if (active) loading = false;
      }
    })();
  }
  return () => {
    active = false;
  };
});

const source = $derived(
  report ? sources.find((s) => s.id === report?.sourceId) : undefined,
);
const description = $derived(
  report
    ? describeReport(report.spec, {
        t,
        locale,
        currency,
        source,
        columns: result?.columns,
      })
    : null,
);
const author = $derived(
  report ? authorLabel(report.createdByUserId) : undefined,
);
const savedText = $derived.by(() => {
  if (!report) return '';
  const time = report.savedAt ? relativeTime(report.savedAt, locale) : '';
  if (author && time) return t(M['reports.saved_by_at'], { author, time });
  if (author) return t(M['reports.saved_by'], { author });
  return time ? t(M['reports.saved_at'], { time }) : '';
});
const ranText = $derived(
  result?.ranAt
    ? t(M['reports.ran_at'], {
        time: relativeTime(
          result.ranAt,
          locale,
          undefined,
          t(M['reports.just_now']),
        ),
      })
    : '',
);
const archived = $derived(report?.status === 'archived');

function edit() {
  if (!report) return;
  if (onedit) {
    onedit(report);
    return;
  }
  askNote = !(
    root &&
    requestAssistant(root, {
      prompt: t(M['reports.edit_prompt'], { title: report.title }),
    })
  );
}

function exportCsv() {
  if (!result || !report || typeof document === 'undefined') return;
  const csv = reportCsv(result, (value, column) =>
    typeof value === 'boolean'
      ? t(M[value ? 'reports.yes' : 'reports.no'])
      : reportCell(value, column, locale, currency),
  );
  const url = URL.createObjectURL(
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${
    report.title
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'report'
  }.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function setArchived(next: boolean) {
  if (!client || !report || archiving) return;
  archiving = true;
  error = null;
  try {
    await client.archive(report.id, next);
    revision++;
  } catch (e) {
    error = reportError(e);
  } finally {
    archiving = false;
    confirming = false;
  }
}

// The page runs the report afresh each time it opens, so Re-run is a
// secondary action beside Archive.
const menu = $derived([
  ...(report && !archived && !error
    ? [
        {
          id: 'rerun',
          label: t(M['reports.rerun']),
          disabled: loading,
          onselect: () => {
            revision++;
          },
        },
      ]
    : []),
  ...(report?.canArchive && !archived
    ? [
        {
          id: 'archive',
          label: t(M['reports.archive']),
          disabled: archiving,
          onselect: () => {
            confirming = true;
          },
        },
      ]
    : []),
]);
</script>

<section
  bind:this={root}
  class="report-detail"
  data-smrt-component="ReportDetail"
  data-report-id={id}
  aria-label={report?.title ?? t(M['reports.title'])}
>
  <header class="report-detail__head">
    <div class="report-detail__heading">
      <div class="report-detail__title-row">
        <h1 class="report-detail__title">{report?.title ?? t(M['reports.title'])}</h1>
        {#if archived}<Badge>{t(M['reports.archived_badge'])}</Badge>{/if}
      </div>
      {#if description}<p class="report-detail__line">{description.line}</p>{/if}
      {#if report?.description}<p class="report-detail__description">{report.description}</p>{/if}
    </div>
    {#if client && report}
      <div class="report-detail__actions">
        {#if archived}
          {#if report.canArchive}<Button variant="primary" disabled={archiving} onclick={() => setArchived(false)}>{t(M['reports.restore'])}</Button>{/if}
        {:else if error}
          <Button variant="primary" disabled={loading} onclick={() => revision++}>{t(M['reports.retry'])}</Button>
        {:else}
          <Button variant="secondary" disabled={!result} onclick={exportCsv}>{t(M['reports.export_csv'])}</Button>
          <Button variant="primary" onclick={edit}>{t(M['reports.edit'])}</Button>
        {/if}
        {#if menu.length}
          <Menu variant="icon" placement="bottom-end" triggerLabel={t(M['reports.more'], { title: report.title })} items={menu}>
          {#snippet trigger()}<span aria-hidden="true">⋯</span>{/snippet}
        </Menu>
        {/if}
      </div>
    {/if}
  </header>
  {#if !client}
    <p class="report-detail__note">{t(M['reports.unavailable'])}</p>
  {:else}
    {#if description}
      <dl class="report-detail__facts" aria-label={t(M['reports.details'])}>
        <div><dt>{t(M['reports.source'])}</dt><dd>{description.source}</dd></div>
        <div><dt>{t(M['reports.groupings'])}</dt><dd>{description.groupings || t(M['reports.none'])}</dd></div>
        {#if description.period}
          <div><dt>{t(M['reports.period'])}</dt><dd>{description.period.range}<span class="report-detail__aside">{' · '}{description.period.field}</span></dd></div>
        {/if}
        <div><dt>{t(M['reports.measures'])}</dt><dd>{description.measures.join(', ')}</dd></div>
        {#if description.filters.length}
          <div><dt>{t(M['reports.filters'])}</dt><dd>{description.filters.join('; ')}</dd></div>
        {/if}
        {#if description.having.length}
          <div><dt>{t(M['reports.having'])}</dt><dd>{description.having.join('; ')}</dd></div>
        {/if}
        {#if savedText || ranText}
          <div class="report-detail__meta"><dt class="report-detail__sr">{t(M['reports.author'])}</dt><dd>{[savedText, ranText].filter(Boolean).join(' · ')}</dd></div>
        {/if}
      </dl>
    {/if}
    {#if askNote}<p class="report-detail__note" role="status">{t(M['reports.ask_where'])}</p>{/if}
    {#if loading && !result}<p class="report-detail__note" role="status">{t(M['reports.running'])}</p>{/if}
    {#if error}<p class="report-detail__error" role="alert">{t(M[error])}</p>{/if}
    {#if result && report}
      <div class="report-detail__result">
        <ReportResult {result} spec={report.spec} variant="full" bind:view {locale} {currency} />
      </div>
    {/if}
  {/if}
  <ConfirmDialog
    open={confirming}
    title={t(M['reports.archive_confirm_title'], { title: report?.title ?? '' })}
    message={t(M['reports.archive_confirm'])}
    confirmLabel={t(M['reports.archive'])}
    cancelLabel={t(M['reports.cancel'])}
    loading={archiving}
    onconfirm={() => void setArchived(true)}
    oncancel={() => (confirming = false)}
  />
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .report-detail { display: grid; gap: var(--smrt-spacing-5); min-inline-size: 0; }
  .report-detail__head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--smrt-spacing-3) var(--smrt-spacing-5); }
  .report-detail__heading { display: grid; gap: var(--smrt-spacing-1); flex: 1 1 20rem; min-inline-size: 0; }
  .report-detail__title-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-2); }
  .report-detail__title { margin: 0; font: var(--smrt-typography-headline-medium-font); overflow-wrap: anywhere; }
  .report-detail__line { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-medium-size); }
  .report-detail__description { margin: 0; max-inline-size: 65ch; font-size: var(--smrt-typography-body-medium-size); }
  .report-detail__actions { display: flex; flex-wrap: nowrap; align-items: center; gap: var(--smrt-spacing-2); }
  .report-detail__facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 13rem), 1fr)); gap: var(--smrt-spacing-3) var(--smrt-spacing-5); margin: 0; padding: var(--smrt-spacing-4); border: var(--smrt-hairline); border-radius: var(--smrt-radius-large); background: var(--smrt-color-surface-container-low); }
  .report-detail__facts > div { display: grid; gap: var(--smrt-spacing-1); min-inline-size: 0; }
  .report-detail__facts dt { color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-medium-size); }
  .report-detail__facts dd { margin: 0; overflow-wrap: anywhere; font-size: var(--smrt-typography-body-medium-size); }
  .report-detail__meta { grid-column: 1 / -1; padding-block-start: var(--smrt-spacing-3); border-block-start: var(--smrt-hairline); }
  .report-detail__meta dd { color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-size); }
  .report-detail__aside { color: var(--smrt-color-on-surface-variant); }
  .report-detail__sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  .report-detail__note { margin: 0; color: var(--smrt-color-on-surface-variant); }
  .report-detail__error { margin: 0; color: var(--smrt-color-error); }
  .report-detail__result { padding: var(--smrt-spacing-4); border: var(--smrt-hairline); border-radius: var(--smrt-radius-large); background: var(--smrt-color-surface); }
}
</style>
