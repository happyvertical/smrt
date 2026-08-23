<script lang="ts">
import { onMount } from 'svelte';
import {
  createDataTableConformanceRows,
  dataTableConformanceColumns,
  dataTableConformanceRows,
  dataTableConformanceScenarios,
} from '../../components/data/__fixtures__/DataTableConformanceFixture.js';
import DataTable from '../../components/data/DataTable.svelte';
import { createDataTableController } from '../../components/data/DataTableController.js';
import type {
  DataTableColumn,
  DataTableStructuralRow,
} from '../../components/data/types.js';
import Toggle from '../../components/forms/Toggle.svelte';
import Badge from '../../components/ui/Badge.svelte';
import Button from '../../components/ui/Button.svelte';

interface WorkspaceUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastSeen: string;
}

interface ReportLine {
  id: string;
  account: string;
  actual: number;
  forecast: number;
  variance: number;
  status: string;
  action: string;
}

const users: WorkspaceUser[] = [
  {
    id: 'user-ada',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    role: 'Admin',
    status: 'Active',
    lastSeen: '2 min ago',
  },
  {
    id: 'user-grace',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    role: 'Editor',
    status: 'Active',
    lastSeen: '18 min ago',
  },
  {
    id: 'user-alan',
    name: 'Alan Turing',
    email: 'alan@example.com',
    role: 'Viewer',
    status: 'Pending',
    lastSeen: 'Yesterday',
  },
  {
    id: 'user-margaret',
    name: 'Margaret Hamilton',
    email: 'margaret@example.com',
    role: 'Editor',
    status: 'Active',
    lastSeen: 'Yesterday',
  },
  {
    id: 'user-katherine',
    name: 'Katherine Johnson',
    email: 'katherine@example.com',
    role: 'Viewer',
    status: 'Inactive',
    lastSeen: '4 days ago',
  },
];

const columns: DataTableColumn<WorkspaceUser>[] = [
  { id: 'name', label: 'Name', sortable: true, minWidth: '10rem' },
  { id: 'email', label: 'Email', sortable: true, minWidth: '13rem' },
  { id: 'role', label: 'Role', sortable: true },
  { id: 'status', label: 'Status', sortable: true },
  { id: 'lastSeen', label: 'Last seen', sortable: true, align: 'right' },
];

const reportRows: ReportLine[] = [
  {
    id: 'revenue',
    account: 'Subscription revenue',
    actual: 182400,
    forecast: 176000,
    variance: 6400,
    status: 'On track',
    action: 'Review',
  },
  {
    id: 'services',
    account: 'Professional services',
    actual: 48300,
    forecast: 52000,
    variance: -3700,
    status: 'Watch',
    action: 'Review',
  },
];

const reportColumns: DataTableColumn<ReportLine>[] = [
  {
    id: 'account',
    label: 'Account',
    headerPath: [{ id: 'dimension', label: 'Dimensions' }],
    minWidth: '13rem',
    resizable: true,
  },
  {
    id: 'actual',
    label: 'Actual',
    headerPath: [{ id: 'performance', label: 'Performance' }],
    align: 'right',
    resizable: true,
  },
  {
    id: 'forecast',
    label: 'Forecast',
    headerPath: [{ id: 'performance', label: 'Performance' }],
    align: 'right',
    resizable: true,
  },
  {
    id: 'variance',
    label: 'Variance',
    headerPath: [{ id: 'performance', label: 'Performance' }],
    align: 'right',
  },
  {
    id: 'status',
    label: 'Status',
    role: 'status',
    responsive: { keepVisible: true, priority: 10 },
  },
  {
    id: 'action',
    label: 'Action',
    role: 'action',
    responsive: { keepVisible: true, priority: 10 },
  },
];

const reportStructuralRows: DataTableStructuralRow<ReportLine>[] = [
  {
    id: 'forecast-subtotal',
    kind: 'subtotal',
    label: 'Current forecast',
    values: { actual: 230700, forecast: 228000, variance: 2700 },
  },
  {
    id: 'forecast-total',
    kind: 'footer',
    label: 'All accounts',
    values: { actual: 230700, forecast: 228000, variance: 2700 },
  },
];

let loading = $state(false);
let dense = $state(false);
const tableController = createDataTableController({
  columnIds: columns.map((column) => column.id),
  initialState: { pageSize: 3 },
});
const reportController = createDataTableController({
  columnIds: reportColumns.map((column) => column.id),
  initialState: {
    columnOrder: reportColumns.map((column) => column.id),
    columnWidths: [
      { columnId: 'account', width: 240 },
      { columnId: 'actual', width: 112 },
      { columnId: 'forecast', width: 112 },
    ],
    columnPinning: [
      { columnId: 'account', position: 'start' },
      { columnId: 'action', position: 'end' },
    ],
  },
});
const manualController = createDataTableController({
  columnIds: dataTableConformanceColumns.map((column) => column.id),
  modes: { filtering: 'manual', sorting: 'manual', pagination: 'manual' },
  initialState: { page: 2, pageSize: 25 },
});
const virtualRows = createDataTableConformanceRows(120);
const virtualColumns = dataTableConformanceColumns.slice(0, 2);
const virtualization = { rowHeight: 32, viewportHeight: 176, overscan: 3 };
const manualQueryCommands = new Set([
  'setSearch',
  'setFilters',
  'setSorting',
  'toggleSorting',
  'setPage',
  'setPageSize',
]);
let tableState = $state(tableController.getState());
let manualState = $state(manualController.getState());
let manualLifecycle = $state<'ready' | 'refreshing' | 'stale' | 'error'>(
  'ready',
);
let manualQueryRevision = $state(1);
const manualQueryFingerprint = $derived(
  JSON.stringify({
    search: manualState.search,
    filters: manualState.filters,
    sorting: manualState.sorting,
    page: manualState.page,
    pageSize: manualState.pageSize,
  }),
);

onMount(() => {
  const unsubscribeTable = tableController.subscribe((transition) => {
    tableState = transition.next.state;
  });
  const unsubscribeManual = manualController.subscribe((transition) => {
    manualState = transition.next.state;
    if (
      transition.command &&
      manualQueryCommands.has(transition.command.type)
    ) {
      manualQueryRevision += 1;
      manualLifecycle = 'refreshing';
    }
  });
  return () => {
    unsubscribeTable();
    unsubscribeManual();
  };
});

function clearSelection() {
  tableController.dispatch({ type: 'setSelectedRows', rowIds: [] });
}

function toggleActiveFilter() {
  tableController.dispatch({
    type: 'setFilters',
    filters: tableState.filters.length
      ? []
      : [{ columnId: 'status', operator: 'equals', value: 'Active' }],
  });
}

function restoreReportLayout() {
  reportController.replaceState({
    ...reportController.getState(),
    columnOrder: reportColumns.map((column) => column.id),
    columnVisibility: reportColumns.map((column) => ({
      columnId: column.id,
      visible: true,
    })),
    columnWidths: [
      { columnId: 'account', width: 240 },
      { columnId: 'actual', width: 112 },
      { columnId: 'forecast', width: 112 },
    ],
    columnPinning: [
      { columnId: 'account', position: 'start' },
      { columnId: 'action', position: 'end' },
    ],
  });
}

function showStaleManualResult() {
  manualQueryRevision += 1;
  manualLifecycle = 'stale';
}

function resolveManualQuery() {
  manualLifecycle = 'ready';
}

function retryManualQuery() {
  manualLifecycle = 'refreshing';
  manualQueryRevision += 1;
}

function showManualFailure() {
  manualLifecycle = 'error';
}

function toggleManualFilter() {
  manualController.dispatch({
    type: 'setFilters',
    filters: manualState.filters.length
      ? []
      : [{ columnId: 'status', operator: 'equals', value: 'On track' }],
  });
}

function selectAllMatching() {
  manualController.dispatch({
    type: 'selectAllMatching',
    queryFingerprint: manualQueryFingerprint,
    queryRevision: `revision-${manualQueryRevision}`,
    expectedCount: 120,
  });
}
</script>

<div class="workbench">
  <div class="workbench__header">
    <div>
      <p class="eyebrow">Interactive data</p>
      <h4>Workspace users</h4>
      <p class="supporting">
        Sort columns, select rows, and toggle the loading or dense states.
      </p>
    </div>
    <div class="summary" aria-live="polite">
      <Badge variant={tableState.selectedRowIds.length > 0 ? 'primary' : 'default'}>
        {tableState.selectedRowIds.length} selected
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        disabled={tableState.selectedRowIds.length === 0}
        onclick={clearSelection}
      >
        Clear
      </Button>
    </div>
  </div>

  <div class="table-controls" aria-label="Table display controls">
    <Toggle label="Dense rows" size="sm" bind:checked={dense} />
    <Toggle label="Loading state" size="sm" bind:checked={loading} />
    <Button variant="ghost" size="sm" onclick={toggleActiveFilter}>
      {tableState.filters.length ? 'Clear active filter' : 'Show active'}
    </Button>
    <span>
      Sort: {tableState.sorting.length
        ? tableState.sorting.map((rule) => `${rule.columnId} ${rule.direction}`).join(', ')
        : 'none'}
    </span>
  </div>

  <div class="table-frame">
    <DataTable
      data={users}
      {columns}
      rowKey="id"
      selectable
      sortable
      striped
      hoverable
      stickyHeader
      {loading}
      {dense}
      controller={tableController}
      caption="Workspace users"
    />
  </div>

  <section class="report-fixture" aria-labelledby="report-fixture-title">
    <div class="report-fixture__header">
      <div>
        <p class="eyebrow">Report structure</p>
        <h4 id="report-fixture-title">Forecast report</h4>
        <p class="supporting">
          Grouped headers, structural totals, restored widths, and pinned status/action columns.
        </p>
      </div>
      <Button variant="ghost" size="sm" onclick={restoreReportLayout}>
        Restore saved layout
      </Button>
    </div>
    <div class="table-frame">
      <DataTable
        data={reportRows}
        columns={reportColumns}
        rowKey="id"
        structuralRows={reportStructuralRows}
        controller={reportController}
        caption="Forecast report"
        hoverable
        stickyHeader
      />
    </div>
  </section>

  <section class="manual-fixture" aria-labelledby="manual-fixture-title">
    <div class="report-fixture__header">
      <div>
        <p class="eyebrow">Manual query and async states</p>
        <h4 id="manual-fixture-title">Server-owned results</h4>
        <p class="supporting">
          Supplied rows remain usable through refresh, stale, and error states. The caller owns
          query revisions and discards late responses.
        </p>
      </div>
      <Badge variant={manualLifecycle === 'error' ? 'error' : 'default'}>
        Revision {manualQueryRevision}
      </Badge>
    </div>
    <div class="table-controls" aria-label="Manual query controls">
      <Button variant="ghost" size="sm" onclick={showStaleManualResult}>
        Show stale result
      </Button>
      <Button variant="ghost" size="sm" onclick={resolveManualQuery}>
        Accept newer result
      </Button>
      <Button variant="ghost" size="sm" onclick={showManualFailure}>
        Show failure
      </Button>
      <Button variant="ghost" size="sm" onclick={toggleManualFilter}>
        {manualState.filters.length ? 'Clear manual filter' : 'Request manual filter'}
      </Button>
      <Button variant="ghost" size="sm" onclick={selectAllMatching}>
        Select all 120 matching
      </Button>
      {#if manualState.selection.scope === 'allMatching'}
        <span>All matching selection is bound to {manualState.selection.queryRevision}.</span>
      {/if}
    </div>
    <div class="table-frame">
      <DataTable
        data={dataTableConformanceRows}
        columns={dataTableConformanceColumns}
        rowKey="id"
        selectable
        controller={manualController}
        sortable
        totalRows={120}
        refreshing={manualLifecycle === 'refreshing'}
        stale={manualLifecycle === 'stale'}
        partialResults={manualLifecycle === 'stale'}
        error={manualLifecycle === 'error' ? 'The query failed. Retry to request the current revision.' : null}
        onRetry={retryManualQuery}
        caption="Manual workspace report"
        stickyHeader
      />
    </div>
  </section>

  <section class="scale-fixture" aria-labelledby="scale-fixture-title">
    <div>
      <p class="eyebrow">Scale boundary</p>
      <h4 id="scale-fixture-title">Virtualized result window</h4>
      <p class="supporting">
        A fixed-height, keyboard-scrollable body renders a stable row-key window while its
        semantic header remains visible.
      </p>
    </div>
    <div class="table-frame table-frame--virtual">
      <DataTable
        data={virtualRows}
        columns={virtualColumns}
        rowKey="id"
        {virtualization}
        caption="Virtual workspace report"
        striped
        stickyHeader
      />
    </div>
  </section>

  <section class="coverage-fixture" aria-labelledby="coverage-fixture-title">
    <div>
      <p class="eyebrow">Release conformance</p>
      <h4 id="coverage-fixture-title">Every supported DataTable surface</h4>
    </div>
    <ul>
      {#each dataTableConformanceScenarios as scenario}
        <li><strong>{scenario.title}:</strong> {scenario.contracts.join(', ')}</li>
      {/each}
    </ul>
  </section>

  <div class="empty-state">
    <div>
      <strong>Empty state</strong>
      <span>The same columns with no records.</span>
    </div>
    <div class="table-frame">
      <DataTable
        data={[]}
        columns={columns.slice(0, 3)}
        rowKey="id"
        dense
        caption="Empty workspace users"
      />
    </div>
  </div>
</div>

<style>
  .workbench {
    display: grid;
    gap: var(--smrt-spacing-5);
    color: var(--smrt-color-on-surface);
  }

  .workbench__header,
  .summary,
  .table-controls,
  .empty-state > div:first-child {
    display: flex;
    align-items: center;
  }

  .workbench__header {
    justify-content: space-between;
    gap: var(--smrt-spacing-4);
    padding-bottom: var(--smrt-spacing-4);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  h4,
  p {
    margin: 0;
  }

  h4 {
    font: var(--smrt-typography-headline-small-font);
  }

  .eyebrow {
    margin-bottom: var(--smrt-spacing-1);
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-small-font);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .supporting {
    margin-top: var(--smrt-spacing-1);
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-medium-font);
  }

  .summary,
  .table-controls {
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
  }

  .table-controls {
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container-low);
  }

  .table-controls > span {
    margin-left: auto;
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-small-font);
  }

  .table-frame {
    overflow: auto;
    max-width: 100%;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-medium);
  }

  .empty-state {
    display: grid;
    gap: var(--smrt-spacing-3);
    padding-top: var(--smrt-spacing-4);
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .report-fixture {
    display: grid;
    gap: var(--smrt-spacing-3);
    padding-top: var(--smrt-spacing-4);
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .manual-fixture,
  .scale-fixture,
  .coverage-fixture {
    display: grid;
    gap: var(--smrt-spacing-3);
    padding-top: var(--smrt-spacing-4);
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .table-frame--virtual {
    max-height: 20rem;
  }

  .coverage-fixture ul {
    display: grid;
    gap: var(--smrt-spacing-2);
    padding: 0;
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-small-font);
    list-style: none;
  }

  .coverage-fixture strong {
    color: var(--smrt-color-on-surface);
  }

  .report-fixture__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--smrt-spacing-4);
  }

  .empty-state > div:first-child {
    justify-content: space-between;
    gap: var(--smrt-spacing-4);
  }

  .empty-state span {
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-small-font);
  }

  @media (max-width: 760px) {
    .workbench__header,
    .report-fixture__header,
    .empty-state > div:first-child {
      align-items: flex-start;
      flex-direction: column;
    }

    .table-controls > span {
      width: 100%;
      margin-left: 0;
    }
  }
</style>
