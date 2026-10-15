<script lang="ts">
import { onMount } from 'svelte';
import {
  createDataSurfaceRegistry,
  createDataTableController,
  DataTable,
  type DataSurfaceDescriptor,
  type DataTableColumn,
} from '@happyvertical/smrt-ui/data';
import { Button } from '@happyvertical/smrt-ui/ui';
import { formatInvoiceMinorUnits } from '../../src/svelte/invoice-display.js';

type ReportColumn = {
  id: string;
  label: string;
  accessor: string;
  sortable: boolean;
  filterable: boolean;
  align: 'left' | 'right';
  role: 'data' | 'status' | 'action';
  responsive: { priority?: number; keepVisible?: boolean };
  valueFormat: 'text' | 'date' | 'datetime' | 'percentage' | 'count' | 'money' | 'number';
};

type BrowserReport = {
  descriptor: {
    resourceId: string;
    schema: { version: number; fields: Array<{ id: string; projectable: boolean; sortable: boolean; filterOperators?: unknown }> };
    reportClassName: string;
    identityField: 'id';
    dataTable: { columns: ReportColumn[] };
  };
  tenantId: string;
  gstReportId: string | null;
  rows: Array<Record<string, unknown>>;
};

const params = new URLSearchParams(location.search);
const fixtureState = params.get('state') === 'empty' ||
  params.get('state') === 'unknown' ||
  params.get('state') === 'error'
  ? params.get('state')
  : 'data';
const principal = params.get('principal') === 'tenant-b' ? 'tenant-b' : 'tenant-a';
const requestedReportId = params.get('reportId') ?? '';

const registry = createDataSurfaceRegistry();
const visibleColumnIds = new Set([
  'currency',
  'row_kind',
  'tax_component_id',
  'taxable_minor',
  'tax_minor',
  'net_tax_minor',
  'document_count',
  'complete',
  'warning_code',
]);
let report = $state<BrowserReport | undefined>();
let error = $state<string | null>(null);
let loading = $state(true);
let drilldown = $state<Array<Record<string, unknown>> | undefined>();
let drilldownError = $state<string | null>(null);

function moneyCell(value: unknown, row: Record<string, unknown>): string {
  if (!Number.isSafeInteger(value) || typeof row.currency !== 'string') return '—';
  return formatInvoiceMinorUnits(value, row.currency, 'en-CA');
}

function columns(): DataTableColumn<Record<string, unknown>>[] {
  if (!report) return [];
  return report.descriptor.dataTable.columns
    .filter((column) => visibleColumnIds.has(column.id))
    .map((column) => ({
      id: column.id,
      label: column.label,
      accessor: column.accessor,
      sortable: column.sortable,
      filterable: column.filterable,
      align: column.align,
      role: column.role,
      responsive: column.responsive,
      ...(column.valueFormat === 'money' ? { cell: formattedMoneyCell } : {}),
    }));
}

function descriptor(): DataSurfaceDescriptor | undefined {
  if (!report) return undefined;
  const dataTableColumns = report.descriptor.dataTable.columns
    .filter((column) => visibleColumnIds.has(column.id));
  return {
    version: 1,
    identity: {
      surfaceId: report.descriptor.resourceId,
      kind: 'report',
      subject: { type: 'tenant', id: report.tenantId },
    },
    schemaVersion: report.descriptor.schema.version,
    label: report.descriptor.reportClassName,
    rowKey: report.descriptor.identityField,
    columns: [
      { id: report.descriptor.identityField, label: 'ID', capabilities: ['read'] },
      ...dataTableColumns.map((column) => ({
        id: column.id,
        label: column.label,
        role: column.role,
        capabilities: [
          'read',
          'project',
          ...(column.sortable ? ['sort' as const] : []),
          ...(column.filterable ? ['filter' as const] : []),
        ],
      })),
    ],
    query: {
      modes: ['rows', 'count'],
      projectableColumnIds: [
        report.descriptor.identityField,
        ...report.descriptor.schema.fields
          .filter((field) => field.projectable && visibleColumnIds.has(field.id))
          .map((field) => field.id),
      ],
      sortableColumnIds: report.descriptor.schema.fields
        .filter((field) => field.sortable && visibleColumnIds.has(field.id))
        .map((field) => field.id),
    },
    controls: [],
    actions: [],
    limits: { maxQueryRows: 50, maxQueryBytes: 20_000, maxSelectionSize: 10 },
  };
}

async function load(): Promise<void> {
  loading = true;
  error = null;
  try {
    const response = await fetch(`/tax-summary-report.json?state=${fixtureState}`);
    if (!response.ok) throw new Error((await response.json()).error ?? 'Tax summary request failed.');
    report = await response.json() as BrowserReport;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Tax summary request failed.';
  } finally {
    loading = false;
  }
}

async function showDrilldown(): Promise<void> {
  if (!report?.gstReportId && !requestedReportId) return;
  drilldown = undefined;
  drilldownError = null;
  const reportId = requestedReportId || report.gstReportId;
  try {
    const response = await fetch(`/tax-summary-drilldown.json?tenant=${principal}&reportId=${encodeURIComponent(reportId ?? '')}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'Tax summary drilldown failed.');
    drilldown = body;
  } catch (cause) {
    drilldownError = cause instanceof Error ? cause.message : 'Tax summary drilldown failed.';
  }
}

onMount(load);
</script>

{#snippet formattedMoneyCell({ row, value }: { row: Record<string, unknown>; value: unknown })}
  {moneyCell(value, row)}
{/snippet}

<main class="tax-summary-browser" aria-labelledby="tax-summary-title">
  <h1 id="tax-summary-title">Tax summary</h1>
  <p>Principal: {principal}</p>
  {#if report}
    <p data-testid="report-resource">{report.descriptor.resourceId}</p>
    <DataTable
      data={report.rows}
      columns={columns()}
      rowKey="id"
      controller={createDataTableController({ columnIds: columns().map((column) => column.id) })}
      dataSurface={descriptor() ? { registry, descriptor: descriptor()! } : undefined}
      caption="Tax summary report"
      responsiveMode="hide-columns"
      responsiveColumnMinWidth={140}
      phoneLayout="cards"
    />
    <Button onclick={showDrilldown} disabled={!report.gstReportId && !requestedReportId}>
      Inspect GST source
    </Button>
  {:else}
    <DataTable
      data={[]}
      columns={[]}
      rowKey="id"
      loading={loading}
      error={error}
      onRetry={load}
      caption="Tax summary report"
    />
  {/if}

  {#if drilldownError}<p role="alert">{drilldownError}</p>{/if}
  {#if drilldown}
    <section aria-label="GST invoice facts">
      <ul>
        {#each drilldown as fact}
          <li>{fact.documentId}: {formatInvoiceMinorUnits(Number(fact.taxMinor), String(fact.currency), 'en-CA')}</li>
        {/each}
      </ul>
    </section>
  {/if}
</main>
