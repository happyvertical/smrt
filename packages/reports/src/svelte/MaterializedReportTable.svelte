<script lang="ts">
import { formatWidgetValue } from '@happyvertical/smrt-ui/charts/format';
import { DataTable, type DataTableColumn } from '@happyvertical/smrt-ui/data';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ReportDataTableColumn } from '../adapter.js';
import type {
  MaterializedReportDrilldown,
  MaterializedReportPage,
} from './materialized.js';

export interface Props {
  /** Server-projected descriptor and bounded row page. No client tenant selector exists. */
  page: MaterializedReportPage;
  locale?: string;
  onDrilldown?: MaterializedReportDrilldown;
  /** The application route owns URL navigation for a changed server page. */
  onPageChange?: (page: number) => void | Promise<void>;
  caption?: string;
}

let {
  page,
  locale = 'en',
  onDrilldown,
  onPageChange,
  caption = 'Materialized report',
}: Props = $props();

const validCurrency = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z]{3}$/.test(value);

function columns(): DataTableColumn<Record<string, unknown>>[] {
  return page.descriptor.dataTable.columns.map(
    (column: ReportDataTableColumn) => ({
      id: column.id,
      label: column.label,
      accessor: column.accessor,
      sortable: column.sortable,
      filterable: column.filterable,
      align: column.align,
      role: column.role,
      responsive: column.responsive,
    }),
  );
}

function formattedValue(
  columnId: string,
  value: unknown,
  row: Record<string, unknown>,
): string {
  const column = page.descriptor.dataTable.columns.find(
    (candidate) => candidate.id === columnId,
  );
  if (!column) return '–';
  if (column.valueFormat === 'money') {
    if (!Number.isSafeInteger(value) || !validCurrency(row.currency))
      return '–';
    return formatWidgetValue(value, {
      format: 'money',
      currency: row.currency,
      locale,
    });
  }
  return value == null ? '–' : String(value);
}

async function drilldown(id: unknown, columnId: string): Promise<void> {
  if (typeof id !== 'string' || !id || !onDrilldown) return;
  if (!page.drilldownColumnIds?.includes(columnId)) return;
  await onDrilldown({ id, columnId });
}
</script>

{#snippet cell({ column, row, value }: {
  column: DataTableColumn<Record<string, unknown>>;
  row: Record<string, unknown>;
  value: unknown;
})}
  {#if onDrilldown && page.drilldownColumnIds?.includes(column.id)}
    <Button
      variant="ghost"
      aria-label={`Inspect ${column.label}`}
      onclick={() => drilldown(row[page.descriptor.identityField], column.id)}
    >{formattedValue(column.id, value, row)}</Button>
  {:else}
    {formattedValue(column.id, value, row)}
  {/if}
{/snippet}

<div data-smrt-component="MaterializedReportTable">
  <DataTable
    data={page.rows}
    columns={columns()}
    rowKey={page.descriptor.identityField}
    manualPagination
    totalRows={page.totalRows}
    page={Math.floor(page.offset / page.limit) + 1}
    pageSize={page.limit}
    {caption}
    {onPageChange}
    {cell}
  />
</div>
