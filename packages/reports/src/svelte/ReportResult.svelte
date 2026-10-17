<script lang="ts">
/**
 * A report's result: one measure charted at a time (a measure switch when
 * there are several), or the whole result as a table with formatted columns
 * (money, "Jan 2025" buckets). `full` is a report's page: a Chart/Table
 * switch, headline figures for the shown measure (total, average, peak) and a
 * tall chart with a value axis. `compact` is the assistant's preview card: a
 * quiet table toggle and a regular chart.
 */
import {
  Chart,
  formatTimeBucket,
  type TimeBucketUnit,
} from '@happyvertical/smrt-ui/charts';
import { SegmentedControl, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import {
  measureColumns,
  measureFormat,
  reportFigures,
  timeAxis,
} from './describe.js';
import { M } from './messages.js';
import { reportCell, validReportResult } from './result.js';
import type { RuntimeReportResult, RuntimeReportSpec } from './types.js';

type Column = RuntimeReportResult['columns'][number];

export interface Props {
  result: RuntimeReportResult;
  /** `compact` (default) for a preview card, `full` for a report's page. */
  variant?: 'compact' | 'full';
  /** The report's spec, so figures know which measures add up. */
  spec?: RuntimeReportSpec;
  /** Chart or table, bindable so the page's actions can follow it. */
  view?: 'chart' | 'table';
  locale?: string;
  currency?: string;
}
let {
  result,
  variant = 'compact',
  spec,
  view = $bindable('chart'),
  locale = 'en',
  currency = 'USD',
}: Props = $props();
const { t } = useI18n();
const valid = $derived(validReportResult(result));
const measures = $derived(valid ? measureColumns(result) : []);
let picked = $state<string | null>(null);
const measure = $derived(measures.find((c) => c.id === picked) ?? measures[0]);
const xColumn = $derived(
  valid
    ? result.chart.x
      ? result.columns.find((c) => c.id === result.chart.x)
      : result.columns.find((c) => c.role === 'dimension')
    : undefined,
);
const axis = $derived(valid ? timeAxis(result) : undefined);
const tableOnly = $derived(valid && result.chart.type === 'table');
const showTable = $derived(tableOnly || view === 'table');

/** A time bucket reads by its granularity ("Jan 2025"), never as an ISO instant. */
function bucketLabel(value: unknown, column: Column | undefined) {
  if (typeof value === 'string' && column?.bucket) {
    return formatTimeBucket(value, column.bucket as TimeBucketUnit, locale);
  }
  return undefined;
}
function cell(value: unknown, column: Column) {
  return typeof value === 'boolean'
    ? t(M[value ? 'reports.yes' : 'reports.no'])
    : (bucketLabel(value, column) ??
        reportCell(value, column, locale, currency));
}
const groupLabel = (row: RuntimeReportResult['rows'][number]) =>
  xColumn ? cell(row[xColumn.id], xColumn) : (measure?.label ?? '');
const figures = $derived(
  variant === 'full' && valid && measure
    ? reportFigures(result, measure, {
        t,
        locale,
        currency,
        groupLabel,
        fn: spec?.measures.find((m) => m.as === measure.id)?.fn,
      })
    : [],
);
const chartData = $derived(
  valid && measure
    ? {
        points: result.rows
          .filter((row) => typeof row[measure.id] === 'number')
          .map((row) => ({
            label: groupLabel(row),
            value: row[measure.id] as number,
          })),
        format: measureFormat(measure),
        currency,
      }
    : null,
);
/** "Total amount by month", "Number of invoices by Status". */
const seriesLabel = $derived(
  measure
    ? axis?.bucket
      ? t(M['reports.dimension_bucket'], {
          field: measure.label,
          bucket: t(`reports.bucket_unit.${axis.bucket}`),
        })
      : xColumn
        ? t(M['reports.dimension_bucket'], {
            field: measure.label,
            bucket: xColumn.label.toLowerCase(),
          })
        : measure.label
    : '',
);
const numeric = (column: Column) =>
  column.type === 'integer' || column.type === 'decimal';
const measureOptions = $derived(
  measures.map((c) => ({ value: c.id, label: c.label })),
);
</script>

<div class="report-result" data-smrt-component="ReportResult" data-variant={variant}>
  {#if !valid}
    <p role="alert">{t(M['reports.invalid'])}</p>
  {:else if result.rows.length === 0}
    <p class="report-result__empty">{t(M['reports.no_rows'])}</p>
  {:else}
    {#if variant === 'full'}
      <div class="report-result__controls">
        {#if !tableOnly}
          <SegmentedControl
            label={t(M['reports.view'])}
            options={[
              { value: 'chart', label: t(M['reports.view_chart']) },
              { value: 'table', label: t(M['reports.view_table']) },
            ]}
            value={view}
            onvaluechange={(value) => (view = value === 'table' ? 'table' : 'chart')}
          />
        {/if}
        {#if measures.length > 1 && !showTable}
          {#if measures.length <= 3}
            <SegmentedControl
              label={t(M['reports.measure_pick'])}
              options={measureOptions}
              value={measure?.id}
              onvaluechange={(value) => (picked = String(value))}
            />
          {:else}
            <Select
              aria-label={t(M['reports.measure_pick'])}
              value={measure?.id}
              onchange={(event) => (picked = event.currentTarget.value)}
            >
              {#each measureOptions as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
            </Select>
          {/if}
        {/if}
      </div>
      {#if figures.length > 0 && !showTable}
        <dl class="report-result__figures" aria-label={t(M['reports.figures'])}>
          {#each figures as figure (figure.label)}
            <div class="report-result__figure">
              <dt>{figure.label}{#if figure.detail}<span class="report-result__figure-detail">{' · '}{figure.detail}</span>{/if}</dt>
              <dd><span class="report-result__figure-value">{figure.value}</span></dd>
            </div>
          {/each}
        </dl>
      {/if}
    {:else if !tableOnly}
      <div class="report-result__toggle">
        <Button type="button" variant="ghost" size="sm" aria-pressed={view === 'table'} onclick={() => (view = view === 'table' ? 'chart' : 'table')}>{t(M[view === 'table' ? 'reports.chart' : 'reports.table'])}</Button>
      </div>
    {/if}
    {#if showTable}
      <div class="report-result__table">
        <table>
          <caption>{result.title}</caption>
          <thead>
            <tr>
              {#each result.columns as column (column.id)}
                <th scope="col" class:report-result__num={numeric(column)}>{column.label}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each result.rows as row, i (i)}
              <tr>
                {#each result.columns as column (column.id)}
                  <td class:report-result__num={numeric(column)}>{cell(row[column.id], column)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if measure && chartData}
      {#if variant === 'full' || measures.length > 1}
        <p class="report-result__series">{seriesLabel}</p>
      {/if}
      <Chart
        title={measure.label}
        style={result.chart.type}
        size={variant === 'full' ? 'tall' : 'regular'}
        valueAxis={variant === 'full'}
        readout={variant !== 'full'}
        {locale}
        data={chartData}
      />
      {#if variant === 'compact' && measures.length > 1}
        <p class="report-result__more">
          {measures.slice(1).map((c) => c.label).join(', ')} · {t(M['reports.table']).toLowerCase()}
        </p>
      {/if}
    {/if}
    {#if result.truncated}<p class="report-result__empty">{t(M['reports.truncated'])}</p>{/if}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .report-result { display: grid; gap: var(--smrt-spacing-3); inline-size: 100%; min-inline-size: 0; }
  .report-result[data-variant='full'] { gap: var(--smrt-spacing-4); }
  .report-result__controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-2) var(--smrt-spacing-4); }
  .report-result__toggle { display: flex; justify-content: flex-end; }
  .report-result__empty, .report-result__more { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-size); }
  .report-result__series { margin: 0; color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-label-large-font); }
  .report-result__figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr)); gap: var(--smrt-spacing-3); margin: 0; }
  .report-result__figure { display: grid; gap: var(--smrt-spacing-1); padding: var(--smrt-spacing-3) var(--smrt-spacing-4); border: var(--smrt-hairline); border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface-container-low); }
  .report-result__figure dt { color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-medium-size); }
  .report-result__figure dd { display: grid; margin: 0; }
  .report-result__figure-value { font: var(--smrt-typography-headline-small-font); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .report-result__figure-detail { color: var(--smrt-color-on-surface-variant); }
  .report-result__table { overflow-x: auto; border: var(--smrt-hairline); border-radius: var(--smrt-radius-medium); }
  table { border-collapse: collapse; inline-size: 100%; font-size: var(--smrt-typography-body-small-size); }
  caption { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  th, td { padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border-block-end: var(--smrt-hairline); text-align: start; white-space: nowrap; }
  thead th { background: var(--smrt-surface-sunken); color: var(--smrt-color-on-surface-variant); font-weight: var(--smrt-typography-label-large-weight); }
  tbody tr:last-child td { border-block-end: none; }
  .report-result__num { text-align: end; font-variant-numeric: tabular-nums; }
  .report-result[data-variant='compact'] th, .report-result[data-variant='compact'] td { padding: var(--smrt-spacing-1) var(--smrt-spacing-2); }
}
</style>
