<script lang="ts">
/**
 * RecordTable (internal): the compact records table shared by the `records`
 * widget (with columns), each tab of `related`, and `lineItems`. Columns
 * render by role (identifier monospace, status badge, date, money and
 * quantity right-aligned); the first column links to the row. The footer is
 * smrt-ui `DataTable`'s `summaries`: the count in the first column and the
 * sums of the money and quantity columns. A sum covers EVERY matching record
 * only when the host sent `summaryValues` or every record is loaded;
 * otherwise that cell stays empty rather than adding up a partial page.
 */

import type {
  DataTableColumn,
  DataTableSummary,
} from '@happyvertical/smrt-ui/data';
import { DataTable } from '@happyvertical/smrt-ui/data';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge } from '@happyvertical/smrt-ui/ui';
import { M } from '../../../i18n/strings.overview.js';
import { safeHref } from '../markdown.js';
import type {
  RecordListColumn,
  RecordListRow,
  RecordStatusTone,
} from './data.js';
import {
  formatRecordCell,
  isSummedColumn,
  isSummedRole,
  statusTone,
} from './record-table.js';

interface Props {
  rows: readonly RecordListRow[];
  columns: readonly RecordListColumn[];
  locale: string;
  currency?: string;
  timeZone?: string;
  /** Render the footer (count and sums). */
  summaries?: boolean;
  /** Footer values over every matching record, keyed by column (money in minor units). */
  summaryValues?: Readonly<Record<string, number>>;
  /** Every matching record; more than `rows.length` means the rows are a page. */
  total?: number | null;
  statusTones?: Readonly<Record<string, RecordStatusTone>>;
  /** Accessible name of the table. */
  label?: string;
}

let {
  rows,
  columns,
  locale,
  currency,
  timeZone,
  summaries = false,
  summaryValues,
  total = null,
  statusTones,
  label,
}: Props = $props();

const { t } = useI18n();

interface TableRow {
  id: string;
  title: string;
  href: string | null;
  cells: Record<string, unknown>;
}

const tableRows = $derived(
  rows.map(
    (row): TableRow => ({
      id: row.id,
      title: row.title,
      href: typeof row.href === 'string' ? safeHref(row.href) : null,
      cells: row.cells ?? {},
    }),
  ),
);

const byKey = $derived(new Map(columns.map((c) => [c.key, c])));
const firstKey = $derived(columns[0]?.key);
const complete = $derived(total === null || total <= rows.length);
const context = $derived({ currency, locale, timeZone });

const tableColumns = $derived(
  columns.map(
    (column): DataTableColumn<TableRow> => ({
      id: column.key,
      label: column.label,
      accessor: `cells.${column.key}`,
      ...(isSummedRole(column.role) ? { align: 'right' as const } : {}),
      summaryFormat: (value: number) =>
        formatRecordCell(column, value, context),
    }),
  ),
);

const tableSummaries = $derived.by(() => {
  if (!summaries || columns.length === 0) return undefined;
  const out: Record<string, DataTableSummary<TableRow>> = {};
  const count = total ?? rows.length;
  if (firstKey && !isSummedRole(byKey.get(firstKey)?.role)) {
    out[firstKey] = () =>
      t(M['ui.overview.records.total'], {
        count: new Intl.NumberFormat(locale).format(count),
      });
  }
  for (const column of columns) {
    if (!isSummedColumn(column)) continue;
    const hosted = summaryValues?.[column.key];
    if (typeof hosted === 'number' && Number.isFinite(hosted)) {
      out[column.key] = () => formatRecordCell(column, hosted, context);
    } else if (complete) {
      out[column.key] = 'sum';
    } else {
      out[column.key] = () => '';
    }
  }
  return out;
});
</script>

{#snippet cell({ column, row, value }: { column: DataTableColumn<TableRow>; row: TableRow; value: unknown })}
  {@const meta = byKey.get(column.id)}
  {@const text = meta ? formatRecordCell(meta, value, context) : String(value ?? '')}
  {@const shown = text === '' && column.id === firstKey ? row.title : text}
  {#if column.id === firstKey && row.href && shown !== ''}
    <a class="smrt-record-table__link" href={row.href}>
      {#if meta?.role === 'identifier'}<code>{shown}</code>{:else}{shown}{/if}
    </a>
  {:else if meta?.role === 'status' && shown !== ''}
    <Badge size="sm" variant={statusTone(value, statusTones)}>{shown}</Badge>
  {:else if meta?.role === 'identifier' && shown !== ''}
    <code>{shown}</code>
  {:else}
    {shown}
  {/if}
{/snippet}

<div class="smrt-record-table" data-smrt-component="RecordTable" role="group" aria-label={label}>
  <DataTable
    data={tableRows}
    columns={tableColumns}
    rowKey="id"
    {cell}
    dense
    size="sm"
    hoverable={false}
    phoneLayout="cards"
    summaries={tableSummaries}
    summaryLabel={t(M['ui.overview.table.total'])}
  />
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-record-table { min-inline-size: 0; font-variant-numeric: tabular-nums; }
  .smrt-record-table code { font-family: var(--smrt-font-family-mono); }
  .smrt-record-table__link { color: var(--smrt-color-primary); text-decoration: none; }
  .smrt-record-table__link:hover { text-decoration: underline; }
}
</style>
