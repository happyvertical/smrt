<script lang="ts">
import {
  Chart,
  formatTimeBucket,
  type TimeBucketUnit,
} from '@happyvertical/smrt-ui/charts';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from './messages.js';
import { reportCell, validReportResult } from './result.js';
import type { RuntimeReportResult } from './types.js';

export interface Props {
  result: RuntimeReportResult;
  locale?: string;
  currency?: string;
}
let { result, locale = 'en', currency = 'USD' }: Props = $props();
const { t } = useI18n();
let table = $state(false);
const valid = $derived(validReportResult(result));
const measures = $derived(
  valid
    ? result.columns.filter((c) =>
        (
          result.chart.y ??
          result.columns.filter((c) => c.role === 'measure').map((c) => c.id)
        ).includes(c.id),
      )
    : [],
);
const xColumn = $derived(
  valid && result.chart.x
    ? result.columns.find((c) => c.id === result.chart.x)
    : undefined,
);
const BUCKETS = new Set([
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
]);
/** A time bucket reads by its granularity ("Jan 2025"), never as an ISO instant. */
function bucketLabel(
  value: unknown,
  column: RuntimeReportResult['columns'][number] | undefined,
) {
  if (
    typeof value === 'string' &&
    column?.bucket &&
    BUCKETS.has(column.bucket)
  ) {
    return formatTimeBucket(value, column.bucket as TimeBucketUnit, locale);
  }
  return undefined;
}
function cell(value: unknown, column: RuntimeReportResult['columns'][number]) {
  return typeof value === 'boolean'
    ? t(M[value ? 'reports.yes' : 'reports.no'])
    : (bucketLabel(value, column) ??
        reportCell(value, column, locale, currency));
}
</script>

<div data-smrt-component="ReportResult">
  {#if !valid}
    <p role="alert">{t(M['reports.invalid'])}</p>
  {:else if result.rows.length === 0}
    <p>{t(M['reports.no_rows'])}</p>
  {:else}
    {#if result.chart.type !== 'table'}
      <div class="report-result-toggle">
        <Button type="button" variant="ghost" size="sm" aria-pressed={table} onclick={() => table = !table}>{t(M[table ? 'reports.chart' : 'reports.table'])}</Button>
      </div>
    {/if}
    {#if table || result.chart.type === 'table'}
      <div class="report-result-table">
        <table>
          <caption>{result.title}</caption>
          <thead><tr>{#each result.columns as column (column.id)}<th scope="col">{column.label}</th>{/each}</tr></thead>
          <tbody>{#each result.rows as row, i (i)}<tr>{#each result.columns as column (column.id)}<td>{cell(row[column.id], column)}</td>{/each}</tr>{/each}</tbody>
        </table>
      </div>
    {:else}
      {#each measures as column (column.id)}
        <Chart title={column.label} style={result.chart.type} {locale} data={{
          points: result.rows.filter(row => typeof row[column.id] === 'number').map(row => ({
            label: result.chart.x ? (bucketLabel(row[result.chart.x], xColumn) ?? String(row[result.chart.x] ?? '–')) : column.label,
            value: row[column.id] as number,
          })),
          format: column.format === 'money' ? 'money' : column.type === 'integer' ? 'integer' : 'decimal', currency,
        }} />
      {/each}
    {/if}
    {#if result.truncated}<p>{t(M['reports.truncated'])}</p>{/if}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  [data-smrt-component='ReportResult'] { display: grid; gap: var(--smrt-spacing-3); inline-size: 100%; min-inline-size: 0; }
  .report-result-toggle { display: flex; justify-content: flex-end; }
  .report-result-table { overflow-x: auto; }
  table { border-collapse: collapse; inline-size: 100%; font-size: var(--smrt-typography-body-small-size); }
  caption { text-align: start; font: var(--smrt-typography-label-large-font); padding-block-end: var(--smrt-spacing-1); }
  th, td { padding: var(--smrt-spacing-1) var(--smrt-spacing-2); border-block-end: var(--smrt-hairline); text-align: start; font-variant-numeric: tabular-nums; white-space: nowrap; }
}
</style>
