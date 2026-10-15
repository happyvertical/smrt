<script lang="ts">
  import type { MaterializedReportDrilldownPresentation } from '@happyvertical/smrt-reports';
  import { formatWidgetValue } from '@happyvertical/smrt-ui/charts/format';
  import { DataTable, type DataTableColumn } from '@happyvertical/smrt-ui/data';
  import { Alert } from '@happyvertical/smrt-ui/feedback';
  import { Badge, Card } from '@happyvertical/smrt-ui/ui';
  import { parseMaterializedReportDrilldown } from '$lib/materialized-report-drilldown';

  interface ContributorRow {
    id: string;
    source: string;
    identity: string;
    date: string;
    party: string;
    value: string;
    taxable: string;
    tax: string;
  }

  interface Props {
    details: unknown;
    locale?: string;
  }

  let { details, locale = 'en' }: Props = $props();
  let presentation = $derived(parseMaterializedReportDrilldown(details));

  const columns: DataTableColumn<ContributorRow>[] = [
    { id: 'source', label: 'Source', accessor: 'source', responsive: { keepVisible: true } },
    { id: 'identity', label: 'Document or source', accessor: 'identity', responsive: { keepVisible: true } },
    { id: 'date', label: 'Date', accessor: 'date' },
    { id: 'party', label: 'Party', accessor: 'party' },
    { id: 'value', label: 'Selected measure', accessor: 'value', align: 'right' },
    { id: 'taxable', label: 'Taxable', accessor: 'taxable', align: 'right' },
    { id: 'tax', label: 'Tax', accessor: 'tax', align: 'right' },
  ];

  function currency(value: number | null | undefined, code: string): string {
    return value === null || value === undefined
      ? '–'
      : formatWidgetValue(value, { format: 'money', currency: code, locale });
  }

  function calendarDate(value: string | null | undefined): string {
    return value?.slice(0, 10) || '–';
  }

  function rows(value: MaterializedReportDrilldownPresentation): ContributorRow[] {
    return value.contributors.map((contributor) => ({
      id: contributor.id,
      source: contributor.source,
      identity: contributor.identity,
      date: calendarDate(contributor.date),
      party: contributor.party || '–',
      value: currency(contributor.values.valueMinor, value.currency),
      taxable: currency(contributor.values.taxableMinor, value.currency),
      tax: currency(contributor.values.taxMinor, value.currency),
    }));
  }
</script>

<section class="drilldown" aria-label="Report drilldown" data-smrt-component="MaterializedReportDrilldown">
  {#if presentation}
    <Card>
      <div class="heading">
        <div>
          <h2>Report drilldown</h2>
          <p>Selected measure: <strong>{presentation.selectedMeasure.label}</strong></p>
        </div>
        <Badge variant={presentation.complete ? 'success' : 'warning'}>
          {presentation.complete ? 'Complete' : 'Needs attention'}
        </Badge>
      </div>

      {#each presentation.warnings as warning (warning.code)}
        <Alert variant={warning.kind === 'drift' ? 'warning' : 'info'} title={warning.kind === 'drift' ? 'Source data changed' : 'Detail is incomplete'}>
          {warning.message}
        </Alert>
      {/each}

      {#if !presentation.complete && presentation.warnings.length === 0}
        <Alert variant="warning" title="Detail is incomplete">
          This report cannot establish the selected amount exactly.
        </Alert>
      {/if}

      <DataTable
        data={rows(presentation)}
        {columns}
        rowKey="id"
        caption="Report contributors"
        responsiveMode="hide-columns"
      />
    </Card>
  {:else}
    <Alert variant="error" title="Report drilldown unavailable">
      This report returned a detail that this application cannot display safely.
    </Alert>
  {/if}
</section>

<style>
  @layer smrt.theme {
    .drilldown {
      width: min(100%, 72rem);
      margin-inline: auto;
    }

    .heading {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: var(--smrt-spacing-4);
      margin-bottom: var(--smrt-spacing-5);
    }

    h2,
    p {
      margin: 0;
    }

    h2 {
      font: var(--smrt-typography-title-medium-font);
    }

    p {
      margin-top: var(--smrt-spacing-1);
      color: var(--smrt-color-on-surface-variant);
    }

    :global(.smrt-alert__root) {
      margin-block: var(--smrt-spacing-3);
    }
  }
</style>
