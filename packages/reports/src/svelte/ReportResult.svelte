<script lang="ts">
import { Chart } from '@happyvertical/smrt-ui/charts';
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
function cell(value: unknown, column: RuntimeReportResult['columns'][number]) {
  return typeof value === 'boolean'
    ? t(M[value ? 'reports.yes' : 'reports.no'])
    : reportCell(value, column, locale, currency);
}
</script>

<div data-smrt-component="ReportResult">
  {#if !valid}
    <p role="alert">{t(M['reports.invalid'])}</p>
  {:else if result.rows.length === 0}
    <p>{t(M['reports.no_rows'])}</p>
  {:else}
    {#if result.chart.type !== 'table'}
      <Button type="button" onclick={() => table = !table}>{t(M[table ? 'reports.chart' : 'reports.table'])}</Button>
    {/if}
    {#if table || result.chart.type === 'table'}
      <table>
        <caption>{result.title}</caption>
        <thead><tr>{#each result.columns as column (column.id)}<th scope="col">{column.label}</th>{/each}</tr></thead>
        <tbody>{#each result.rows as row, i (i)}<tr>{#each result.columns as column (column.id)}<td>{cell(row[column.id], column)}</td>{/each}</tr>{/each}</tbody>
      </table>
    {:else}
      {#each measures as column (column.id)}
        <Chart title={column.label} style={result.chart.type} {locale} data={{
          points: result.rows.filter(row => typeof row[column.id] === 'number').map(row => ({ label: result.chart.x ? String(row[result.chart.x] ?? '–') : column.label, value: row[column.id] as number })),
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
  [data-smrt-component='ReportResult'] { display: grid; gap: var(--smrt-spacing-3); overflow: auto; }
  table { border-collapse: collapse; inline-size: 100%; }
  th, td { padding: var(--smrt-spacing-2); border-block-end: var(--smrt-hairline); text-align: start; font-variant-numeric: tabular-nums; }
}
</style>
