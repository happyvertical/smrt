<script lang="ts">
/**
 * Saved reports as a grid of cards, each run for its headline figure. `page`
 * is the Saved reports page (its heading, "New report", whose and archived
 * filters); `section` is the Reports section page's widget (a hint, "New
 * report", "View all"). "New report" asks the page's assistant (smrt-ui
 * `requestAssistant`); with none on the page it says where to ask.
 */
import { requestAssistant } from '@happyvertical/smrt-ui/chat';
import { ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { SegmentedControl, Switch } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { EmptyState } from '@happyvertical/smrt-ui/layout';
import { Button, Skeleton } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import type { ReportSourceInfo } from './describe.js';
import { M } from './messages.js';
import { reportError, validReportResult } from './result.js';
import SavedReportCard from './SavedReportCard.svelte';
import type {
  RuntimeReportResult,
  RuntimeReportsClient,
  SavedRuntimeReport,
} from './types.js';

export interface Props {
  client?: RuntimeReportsClient;
  reportHref?: (id: string) => string;
  /** Host-owned identity projection; report transport never expands users. */
  authorLabel?: (userId: string) => string | undefined;
  /** The report sources by label and fields (`reports.runtime.sources`). */
  sources?: readonly ReportSourceInfo[];
  /** `page` (default) or `section`, the Reports section page's widget. */
  variant?: 'page' | 'section';
  /** Most cards shown (and run); the section shows its first few. */
  limit?: number;
  /** The Saved reports page, for the section's "View all". */
  listHref?: string;
  /** Replace "New report" asking the page's assistant. */
  onnewreport?: () => void;
  locale?: string;
  currency?: string;
}
let {
  client,
  reportHref = (id) => `/reports/${encodeURIComponent(id)}`,
  authorLabel = () => undefined,
  sources = [],
  variant = 'page',
  limit = variant === 'section' ? 6 : 48,
  listHref,
  onnewreport,
  locale = 'en',
  currency = 'USD',
}: Props = $props();
const { t } = useI18n();
let whose = $state<'all' | 'mine'>('all');
let includeArchived = $state(false);
let rows = $state<SavedRuntimeReport[]>([]);
let total = $state(0);
let results = $state<Record<string, RuntimeReportResult | null>>({});
let loading = $state(false);
let error = $state<ReturnType<typeof reportError> | null>(null);
let refresh = $state(0);
let pending = $state<string | null>(null);
let confirming = $state<SavedRuntimeReport | null>(null);
let askNote = $state(false);
let epoch = 0;

/** Run the shown reports a few at a time, for their cards' figures. */
async function runAll(
  transport: RuntimeReportsClient,
  reports: SavedRuntimeReport[],
  current: number,
) {
  const queue = reports.filter((r) => r.status === 'active');
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const id = next.id;
      let value: RuntimeReportResult | null = null;
      try {
        const ran = await transport.run(id);
        value = validReportResult(ran) ? ran : null;
      } catch {
        value = null;
      }
      if (current !== epoch) return;
      results = { ...results, [id]: value };
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

$effect(() => {
  const transport = client;
  const options = { onlyMine: whose === 'mine', includeArchived };
  const max = limit;
  refresh;
  const current = ++epoch;
  rows = [];
  results = {};
  error = null;
  pending = null;
  loading = !!transport;
  if (transport) {
    void transport
      .list(options)
      .then((value) => {
        if (current !== epoch) return;
        total = value.length;
        rows = value.slice(0, max);
        void runAll(transport, rows, current);
      })
      .catch((e) => {
        if (current === epoch) error = reportError(e);
      })
      .finally(() => {
        if (current === epoch) loading = false;
      });
  }
  return () => {
    ++epoch;
  };
});

async function setArchived(report: SavedRuntimeReport, archived: boolean) {
  if (!client || pending || !report.canArchive) return;
  const current = epoch;
  pending = report.id;
  error = null;
  try {
    await client.archive(report.id, archived);
    if (current === epoch) refresh = untrack(() => refresh) + 1;
  } catch (e) {
    if (current === epoch) error = reportError(e);
  } finally {
    if (current === epoch) pending = null;
    confirming = null;
  }
}

function actionsFor(report: SavedRuntimeReport) {
  if (!report.canArchive) return [];
  return report.status === 'archived'
    ? [
        {
          id: 'restore',
          label: t(M['reports.restore']),
          disabled: pending !== null,
          onselect: () => void setArchived(report, false),
        },
      ]
    : [
        {
          id: 'archive',
          label: t(M['reports.archive']),
          disabled: pending !== null,
          onselect: () => {
            confirming = report;
          },
        },
      ];
}

let root = $state<HTMLElement | null>(null);
function newReport() {
  if (onnewreport) {
    onnewreport();
    return;
  }
  askNote = !(
    root && requestAssistant(root, { prompt: t(M['reports.new_prompt']) })
  );
}
const sourceOf = (id: string) => sources.find((s) => s.id === id);
const headingLevel = $derived(variant === 'page' ? 2 : 3);
</script>

<section
  bind:this={root}
  class="saved-reports"
  data-smrt-component="SavedReports"
  data-variant={variant}
  aria-label={t(M['reports.title'])}
>
  {#if variant === 'page'}
    <header class="saved-reports__head">
      <h1 class="saved-reports__title">{t(M['reports.title'])}</h1>
      {#if client}<Button variant="primary" onclick={newReport}>{t(M['reports.new'])}</Button>{/if}
    </header>
  {/if}
  {#if !client}
    <p class="saved-reports__note">{t(M['reports.unavailable'])}</p>
  {:else}
    {#if variant === 'page'}
      <div class="saved-reports__toolbar">
        <SegmentedControl
          label={t(M['reports.filter_label'])}
          options={[
            { value: 'all', label: t(M['reports.filter_all']) },
            { value: 'mine', label: t(M['reports.filter_mine']) },
          ]}
          value={whose}
          onvaluechange={(value) => (whose = value === 'mine' ? 'mine' : 'all')}
        />
        <Switch bind:checked={includeArchived} label={t(M['reports.archived'])} size="sm" />
      </div>
    {:else if rows.length > 0}
      <div class="saved-reports__toolbar">
        <p class="saved-reports__hint">{t(M['reports.hint'])}</p>
        <div class="saved-reports__actions">
          {#if listHref && total > rows.length}<Button variant="ghost" size="sm" href={listHref}>{t(M['reports.view_all'])}</Button>{/if}
          <Button variant="primary" size="sm" onclick={newReport}>{t(M['reports.new'])}</Button>
        </div>
      </div>
    {/if}
    {#if askNote}<p class="saved-reports__note" role="status">{t(M['reports.ask_where'])}</p>{/if}
    {#if error}
      <div class="saved-reports__error">
        <p role="alert">{t(M[error])}</p>
        <Button variant="secondary" size="sm" onclick={() => refresh++}>{t(M['reports.retry'])}</Button>
      </div>
    {/if}
    {#if loading}
      <ul class="saved-reports__grid" aria-busy="true" aria-label={t(M['reports.loading'])}>
        {#each [0, 1, 2] as index (index)}
          <li class="saved-reports__placeholder"><Skeleton variant="text" lines={4} /></li>
        {/each}
      </ul>
    {:else if rows.length === 0 && !error}
      <EmptyState
        title={t(M['reports.empty_title'])}
        description={t(M['reports.empty'])}
        icon="document"
        actionLabel={t(M['reports.new'])}
        onaction={newReport}
        size={variant === 'page' ? 'md' : 'sm'}
      />
    {:else if rows.length > 0}
      <ul class="saved-reports__grid">
        {#each rows as report (report.id)}
          <li>
            <SavedReportCard
              {report}
              href={reportHref(report.id)}
              result={report.status === 'archived' ? null : results[report.id]}
              source={sourceOf(report.sourceId)}
              actions={actionsFor(report)}
              author={authorLabel(report.createdByUserId)}
              {headingLevel}
              {locale}
              {currency}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
  <ConfirmDialog
    open={confirming !== null}
    title={t(M['reports.archive_confirm_title'], { title: confirming?.title ?? '' })}
    message={t(M['reports.archive_confirm'])}
    confirmLabel={t(M['reports.archive'])}
    cancelLabel={t(M['reports.cancel'])}
    loading={pending !== null}
    onconfirm={() => confirming && void setArchived(confirming, true)}
    oncancel={() => (confirming = null)}
  />
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .saved-reports { display: grid; gap: var(--smrt-spacing-4); min-inline-size: 0; container-type: inline-size; }
  .saved-reports[data-variant='section'] { gap: var(--smrt-spacing-3); }
  .saved-reports__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-3); }
  .saved-reports__title { margin: 0; font: var(--smrt-typography-headline-medium-font); }
  .saved-reports__toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-2) var(--smrt-spacing-4); }
  .saved-reports__actions { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-2); }
  .saved-reports__hint, .saved-reports__note { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-medium-size); }
  .saved-reports__error { display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-3); color: var(--smrt-color-error); }
  .saved-reports__error p { margin: 0; }
  .saved-reports__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)); gap: var(--smrt-spacing-3); margin: 0; padding: 0; list-style: none; }
  .saved-reports__grid > li { display: grid; min-inline-size: 0; }
  .saved-reports__placeholder { padding: var(--smrt-spacing-4); border: var(--smrt-hairline); border-radius: var(--smrt-radius-large); }
}
</style>
