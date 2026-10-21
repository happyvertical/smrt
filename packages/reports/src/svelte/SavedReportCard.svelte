<script lang="ts">
/**
 * One saved report as a card: its title (the whole card opens it), a line
 * saying what it covers, a headline figure from its latest run with a
 * sparkline over time, and when it was saved and run. The same card is the
 * Saved reports page's and the Reports section page's.
 */

import type { MenuItem } from '@happyvertical/smrt-ui';
import {
  Chart,
  formatTimeBucket,
  type TimeBucketUnit,
} from '@happyvertical/smrt-ui/charts';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge, Menu, Skeleton } from '@happyvertical/smrt-ui/ui';
import {
  describeReport,
  measureColumns,
  measureFormat,
  type ReportSourceInfo,
  relativeTime,
  reportFigures,
  timeAxis,
} from './describe.js';
import { M } from './messages.js';
import { reportCell } from './result.js';
import type { RuntimeReportResult, SavedRuntimeReport } from './types.js';

export interface Props {
  /** The saved report to show: its title, spec and saved-at time. */
  report: SavedRuntimeReport;
  /** The report's page. */
  href: string;
  /** Its latest run; `undefined` while it runs, `null` when it could not run. */
  result?: RuntimeReportResult | null;
  /** The report's source by label and fields, for its description line. */
  source?: ReportSourceInfo;
  /** The secondary actions (Archive, Restore) of its "more" menu. */
  actions?: MenuItem[];
  /** Who saved it, as the host names them ("You"). */
  author?: string;
  /** Heading level of the title, under the surrounding page's heading. */
  headingLevel?: 2 | 3;
  /** BCP 47 locale for dates, numbers and relative times; default `en`. */
  locale?: string;
  /** ISO 4217 code that formats currency measures; default `USD`. */
  currency?: string;
}
let {
  report,
  href,
  result,
  source,
  actions = [],
  author,
  headingLevel = 2,
  locale = 'en',
  currency = 'USD',
}: Props = $props();
const { t } = useI18n();

const description = $derived(
  describeReport(report.spec, {
    t,
    locale,
    currency,
    source,
    columns: result?.columns,
  }),
);
const measure = $derived(result ? measureColumns(result)[0] : undefined);
const axis = $derived(result ? timeAxis(result) : undefined);
const groupLabel = (row: RuntimeReportResult['rows'][number]) => {
  const x = axis ?? result?.columns.find((c) => c.role === 'dimension');
  const value = x ? row[x.id] : undefined;
  if (typeof value === 'string' && axis?.bucket) {
    return formatTimeBucket(value, axis.bucket as TimeBucketUnit, locale);
  }
  return x ? reportCell(value, x, locale, currency) : '';
};
const fn = $derived(
  measure
    ? report.spec.measures.find((m) => m.as === measure.id)?.fn
    : undefined,
);
/** The card's one figure: the total when it adds up, else the latest or peak. */
const figure = $derived.by(() => {
  if (!result || !measure) return null;
  const figures = reportFigures(result, measure, {
    t,
    locale,
    currency,
    groupLabel,
    fn,
  });
  const total = figures.find((f) => f.label === t(M['reports.figure.total']));
  if (figures.length === 1)
    return { label: measure.label, value: figures[0].value };
  // A total is the measure itself over the period.
  if (total) return { label: measure.label, value: total.value };
  const peak = figures.at(-1);
  return peak
    ? {
        label: `${measure.label} · ${t(M['reports.figure.peak']).toLowerCase()}`,
        value: peak.value,
        detail: peak.detail,
      }
    : null;
});
/** An ungrouped report's other measures, one line each ("Total amount $12,400"). */
const extra = $derived.by(() => {
  if (!result || axis || result.columns.some((c) => c.role === 'dimension'))
    return [];
  const row = result.rows[0];
  return row
    ? measureColumns(result)
        .slice(1, 3)
        .map((column) => ({
          label: column.label,
          value: reportCell(row[column.id], column, locale, currency),
        }))
    : [];
});
const series = $derived.by(() => {
  if (!result || !measure || !axis) return null;
  const points = result.rows
    .filter((row) => typeof row[measure.id] === 'number')
    .map((row) => ({
      label: groupLabel(row),
      value: row[measure.id] as number,
    }));
  return points.length > 1
    ? { points, format: measureFormat(measure), currency }
    : null;
});
const groups = $derived(
  result && !axis && result.columns.some((c) => c.role === 'dimension')
    ? result.rows.length
    : 0,
);
const saved = $derived(
  report.savedAt
    ? author
      ? t(M['reports.saved_by_at'], {
          author,
          time: relativeTime(report.savedAt, locale),
        })
      : t(M['reports.saved_at'], { time: relativeTime(report.savedAt, locale) })
    : author
      ? t(M['reports.saved_by'], { author })
      : '',
);
</script>

<article
  class="saved-report-card"
  data-smrt-component="SavedReportCard"
  data-report-id={report.id}
  data-archived={report.status === 'archived' ? '' : undefined}
>
  <div class="saved-report-card__head">
    <svelte:element this={`h${headingLevel}`} class="saved-report-card__title">
      <a href={href}>{report.title}</a>
    </svelte:element>
    {#if report.status === 'archived'}<Badge size="sm">{t(M['reports.archived_badge'])}</Badge>{/if}
    {#if actions.length}
      <div class="saved-report-card__menu">
        <Menu variant="icon" placement="bottom-end" triggerLabel={t(M['reports.more'], { title: report.title })} items={actions}>
          {#snippet trigger()}<span aria-hidden="true">⋯</span>{/snippet}
        </Menu>
      </div>
    {/if}
  </div>
  <p class="saved-report-card__line">{description.line}</p>
  <div class="saved-report-card__figure">
    {#if result === undefined}
      <Skeleton variant="text" lines={2} label={t(M['reports.running'])} />
    {:else if result === null}
      <p class="saved-report-card__muted">{t(M['reports.run_failed'])}</p>
    {:else if result.rows.length === 0}
      <p class="saved-report-card__muted">{t(M['reports.no_rows'])}</p>
    {:else if figure}
      <p class="saved-report-card__label">{figure.label}</p>
      <p class="saved-report-card__value">{figure.value}{#if figure.detail}<span class="saved-report-card__detail"> · {figure.detail}</span>{/if}</p>
      {#if series && measure}
        <div class="saved-report-card__spark">
          <Chart data={series} style="line" size="compact" title={measure.label} {locale} />
        </div>
      {:else if extra.length}
        <dl class="saved-report-card__extra">
          {#each extra as item (item.label)}<div><dt>{item.label}</dt><dd>{item.value}</dd></div>{/each}
        </dl>
      {:else if groups > 1}
        <p class="saved-report-card__muted">{t(M['reports.groups_count'], { count: groups })}</p>
      {/if}
    {/if}
  </div>
  <!-- Its figures are fresh from this run, so the card says only when it was
       saved; the report's page also says when it last ran. -->
  {#if saved}
    <p class="saved-report-card__meta">{saved}</p>
  {/if}
</article>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .saved-report-card {
    position: relative;
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
    padding: var(--smrt-spacing-4);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-large);
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    transition: border-color var(--smrt-duration-fast) var(--smrt-easing-standard), background-color var(--smrt-duration-fast) var(--smrt-easing-standard);
  }
  .saved-report-card:hover { background: var(--smrt-color-surface-container); border-color: var(--smrt-color-outline); }
  .saved-report-card:focus-within:has(.saved-report-card__title a:focus-visible) { outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color); outline-offset: var(--smrt-focus-ring-offset); }
  .saved-report-card[data-archived] { background: var(--smrt-color-surface); }
  .saved-report-card__head { display: flex; align-items: flex-start; gap: var(--smrt-spacing-2); min-inline-size: 0; }
  .saved-report-card__title { flex: 1 1 auto; min-inline-size: 0; margin: 0; font: var(--smrt-typography-title-medium-font); overflow-wrap: anywhere; }
  .saved-report-card__title a { color: inherit; text-decoration: none; outline: none; }
  /* The whole card opens the report; the menu sits above the link. */
  .saved-report-card__title a::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
  .saved-report-card__menu { position: relative; z-index: 1; flex: none; margin-block: calc(var(--smrt-spacing-2) * -1); margin-inline-end: calc(var(--smrt-spacing-2) * -1); }
  .saved-report-card__line { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-size); overflow-wrap: anywhere; }
  .saved-report-card__figure { display: grid; align-content: start; gap: var(--smrt-spacing-1); min-block-size: 4.5rem; }
  .saved-report-card__label { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-medium-size); }
  .saved-report-card__value { margin: 0; font: var(--smrt-typography-headline-small-font); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .saved-report-card__detail { color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-body-small-font); }
  .saved-report-card__spark { margin-block-start: var(--smrt-spacing-1); }
  .saved-report-card__extra { display: grid; gap: var(--smrt-spacing-1); margin: 0; font-size: var(--smrt-typography-body-small-size); }
  .saved-report-card__extra > div { display: flex; flex-wrap: wrap; gap: 0 var(--smrt-spacing-2); }
  .saved-report-card__extra dt { color: var(--smrt-color-on-surface-variant); }
  .saved-report-card__extra dd { margin: 0; font-variant-numeric: tabular-nums; }
  .saved-report-card__muted { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-size); }
  .saved-report-card__meta { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-medium-size); }
  @media (prefers-reduced-motion: reduce) { .saved-report-card { transition: none; } }
}
</style>
