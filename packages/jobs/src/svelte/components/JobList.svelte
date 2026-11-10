<script lang="ts">
/**
 * JobList - Display a filterable, sortable list of background jobs.
 *
 * Sorting follows the list-sort contract (`@happyvertical/smrt-ui/data`):
 * every column header toggles its column ascending/descending (dates and
 * counts start with the largest). Rows keep the order they are supplied in
 * until the host passes `sort` or the person activates a header, so a host
 * that already orders its jobs is not silently reordered. A parent that pages
 * on the server passes `sort` + `onSortChange` and supplies rows already in
 * that order.
 */
import {
  type ListSort,
  type ListSortSpec,
  SortableHeader,
  sortListRows,
  toggleListSort,
} from '@happyvertical/smrt-ui/data';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { M } from '../i18n.js';
import JobActions from './JobActions.svelte';
import JobStatusBadge from './JobStatusBadge.svelte';
import type { JobData, JobFilter, JobSort } from './types.js';
import { formatRelativeTime, getPriorityLabel } from './types.js';

const { t } = useI18n();

export interface Props {
  /** Jobs to display */
  jobs: JobData[];
  /** Loading state */
  loading?: boolean;
  /** Selectable rows */
  selectable?: boolean;
  /** Selected job IDs */
  selected?: Set<string>;
  /** Show actions column */
  showActions?: boolean;
  /** Callback when selection changes */
  onSelectionChange?: (selected: Set<string>) => void;
  /** Callback when job is clicked */
  onJobClick?: (job: JobData) => void;
  /** Callback when retry is clicked */
  onRetry?: (job: JobData) => void;
  /** Callback when cancel is clicked */
  onCancel?: (job: JobData) => void;
  /** Empty state snippet */
  empty?: Snippet;
  /**
   * Current order. Omitted: rows render as supplied (headers show no sort)
   * until a header is activated.
   */
  sort?: ListSort;
  /**
   * Called when a header is activated. When given, the parent owns the order
   * (e.g. a server-sorted list) and `jobs` are rendered as supplied.
   */
  onSortChange?: (sort: ListSort) => void;
}

const JOB_LIST_SORT: ListSortSpec = {
  columns: [
    'status',
    'queue',
    'objectType',
    'method',
    { id: 'priority', firstDirection: 'desc' },
    { id: 'attempts', firstDirection: 'desc' },
    { id: 'createdAt', firstDirection: 'desc' },
    { id: 'runAt', firstDirection: 'desc' },
  ],
  default: { columnId: 'createdAt', direction: 'desc' },
};

let {
  jobs = [],
  loading = false,
  selectable = false,
  selected = $bindable(new Set<string>()),
  showActions = true,
  onSelectionChange,
  onJobClick,
  onRetry,
  onCancel,
  empty,
  sort = $bindable<ListSort | undefined>(undefined),
  onSortChange,
}: Props = $props();

function sortValue(job: JobData, columnId: string) {
  const value = job[columnId as keyof JobData];
  return value instanceof Date ||
    typeof value === 'string' ||
    typeof value === 'number'
    ? value
    : null;
}

const rows = $derived(
  onSortChange || !sort ? jobs : sortListRows(jobs, sort, sortValue),
);

function handleSort(columnId: string) {
  // With no sort yet, the clicked column starts at its first direction.
  const next = toggleListSort(
    sort ?? { columnId: '', direction: 'asc' },
    columnId,
    JOB_LIST_SORT,
  );
  if (onSortChange) onSortChange(next);
  else sort = next;
}

// Handle row click
function handleRowClick(job: JobData) {
  onJobClick?.(job);
}

// Keyboard activation for the row when it acts as a button (role="button").
// Without this, keyboard users can focus the row (tabindex=0) but cannot
// activate it — Enter/Space were dead. Space is prevented to stop page scroll.
function handleRowKeydown(job: JobData, event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    handleRowClick(job);
  }
}

// Handle row selection
function handleRowSelect(jobId: string, event: Event) {
  event.stopPropagation();
  const newSelected = new Set(selected);
  if (newSelected.has(jobId)) {
    newSelected.delete(jobId);
  } else {
    newSelected.add(jobId);
  }
  selected = newSelected;
  onSelectionChange?.(newSelected);
}

// Handle select all
function handleSelectAll() {
  if (allSelected) {
    selected = new Set();
  } else {
    selected = new Set(jobs.map((job) => job.id));
  }
  onSelectionChange?.(selected);
}

// Selection state
const allSelected = $derived(
  jobs.length > 0 && jobs.every((job) => selected.has(job.id)),
);
const someSelected = $derived(
  jobs.some((job) => selected.has(job.id)) && !allSelected,
);

// Action to set indeterminate state
function setIndeterminate(node: HTMLInputElement, value: boolean) {
  node.indeterminate = value;
  return {
    update(newValue: boolean) {
      node.indeterminate = newValue;
    },
  };
}

// Sortable header columns (labels routed through i18n where keyed).
const sortColumns = $derived([
  { id: 'status', label: 'Status' },
  { id: 'queue', label: 'Queue' },
  { id: 'objectType', label: 'Object' },
  { id: 'method', label: 'Method' },
  { id: 'priority', label: 'Priority' },
  { id: 'attempts', label: 'Attempts' },
  { id: 'createdAt', label: 'Created' },
  { id: 'runAt', label: t(M['jobs.job_list.run_at']) },
]);
</script>

<div class="smrt-job-list__root" data-smrt-component="JobList">
  <table class="smrt-job-list__table" data-smrt-part="table" class:smrt-job-list__loading={loading}>
    <thead class="smrt-job-list__head" data-smrt-part="header">
      <tr>
        {#if selectable}
          <th class="smrt-job-list__cell smrt-job-list__cell-checkbox" data-smrt-part="cell">
            <!-- raw-primitive-allow: the CheckboxInput form primitive lives in @happyvertical/smrt-svelte, which transitively depends on smrt-jobs (smrt-svelte to smrt-languages to smrt-jobs), so importing it would close a DAG cycle (#1582); this select-all control also needs the use:setIndeterminate action, which cannot be applied to a component -->
            <input
              type="checkbox"
              checked={allSelected}
              use:setIndeterminate={someSelected}
              onchange={handleSelectAll}
              aria-label={t(M['jobs.job_list.select_all_jobs'])}
            />
          </th>
        {/if}
        {#each sortColumns as column (column.id)}
          <SortableHeader
            class="smrt-job-list__cell smrt-job-list__cell-sortable"
            columnId={column.id}
            label={column.label}
            {sort}
            spec={JOB_LIST_SORT}
            onSort={handleSort}
          />
        {/each}
        {#if showActions}
          <th class="smrt-job-list__cell" data-smrt-part="cell">Actions</th>
        {/if}
      </tr>
    </thead>

    <tbody class="smrt-job-list__body" data-smrt-part="body">
      {#if loading}
        <tr class="smrt-job-list__row smrt-job-list__row-loading" data-smrt-part="row">
          <td class="smrt-job-list__cell smrt-job-list__cell-loading" data-smrt-part="cell" colspan="10">
            <div class="smrt-job-list__progress" data-smrt-part="progress">
              <span class="smrt-job-list__spinner" data-smrt-part="spinner"></span>
              <span>{t(M['jobs.job_list.loading_jobs'])}</span>
            </div>
          </td>
        </tr>
      {:else if jobs.length === 0}
        <tr class="smrt-job-list__row smrt-job-list__row-empty" data-smrt-part="row">
          <td class="smrt-job-list__cell smrt-job-list__cell-empty" data-smrt-part="cell" colspan="10">
            {#if empty}
              {@render empty()}
            {:else}
              <div class="smrt-job-list__empty" data-smrt-part="empty">
                <span>{t(M['jobs.job_list.no_jobs_found'])}</span>
              </div>
            {/if}
          </td>
        </tr>
      {:else}
        {#each rows as job (job.id)}
          {@const isSelected = selected.has(job.id)}
          <tr
            class="smrt-job-list__row" data-smrt-part="row"
            class:smrt-job-list__row-selected={isSelected}
            onclick={() => handleRowClick(job)}
            onkeydown={onJobClick
              ? (e) => handleRowKeydown(job, e)
              : undefined}
            role={onJobClick ? 'button' : undefined}
            tabindex={onJobClick ? 0 : undefined}
          >
            {#if selectable}
              <td class="smrt-job-list__cell smrt-job-list__cell-checkbox" data-smrt-part="cell">
                <!-- raw-primitive-allow: the CheckboxInput form primitive lives in @happyvertical/smrt-svelte, which transitively depends on smrt-jobs (smrt-svelte to smrt-languages to smrt-jobs), so importing it would close a DAG cycle (#1582); native checkbox keeps full keyboard/AT a11y -->
                <input
                  type="checkbox"
                  checked={isSelected}
                  onchange={(e) => handleRowSelect(job.id, e)}
                  aria-label={t(M['jobs.job_list.select_job'])}
                />
              </td>
            {/if}
            <td class="smrt-job-list__cell" data-smrt-part="cell">
              <JobStatusBadge status={job.status} />
            </td>
            <td class="smrt-job-list__cell smrt-job-list__cell-queue" data-smrt-part="cell">
              {job.queue}
            </td>
            <td class="smrt-job-list__cell smrt-job-list__cell-object" data-smrt-part="cell">
              <span class="smrt-job-list__object-type" data-smrt-part="title">{job.objectType}</span>
              {#if job.objectId}
                <span class="smrt-job-list__object-id" data-smrt-part="meta">#{job.objectId.slice(0, 8)}</span>
              {/if}
            </td>
            <td class="smrt-job-list__cell smrt-job-list__cell-method" data-smrt-part="cell">
              <code>{job.method}</code>
            </td>
            <td class="smrt-job-list__cell smrt-job-list__cell-priority" data-smrt-part="cell">
              {getPriorityLabel(job.priority)}
            </td>
            <td class="smrt-job-list__cell smrt-job-list__cell-attempts" data-smrt-part="cell">
              {job.attempts}/{job.maxAttempts}
            </td>
            <td class="smrt-job-list__cell smrt-job-list__cell-date" data-smrt-part="cell">
              {formatRelativeTime(job.createdAt)}
            </td>
            <td class="smrt-job-list__cell smrt-job-list__cell-date" data-smrt-part="cell">
              {formatRelativeTime(job.runAt)}
            </td>
            {#if showActions}
              <td class="smrt-job-list__cell smrt-job-list__cell-actions" data-smrt-part="cell">
                <JobActions
                  {job}
                  compact
                  showDelete={false}
                  {onRetry}
                  {onCancel}
                />
              </td>
            {/if}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-job-list__root {
    width: 100%;
    overflow-x: auto;
  }
  .smrt-job-list__table {
    width: 100%;
  }
  /* Sortable headers are SortableHeader's own <th>: :global, and their
  control carries the padding. */
  .smrt-job-list__head :global(th) {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    white-space: nowrap;
  }
  .smrt-job-list__head :global(th[data-smrt-component="SortableHeader"]) {
    padding: 0;
  }
  .smrt-job-list__body tr:hover:not(.smrt-job-list__row-loading):not(.smrt-job-list__row-empty) {
    cursor: pointer;
  }
  .smrt-job-list__cell {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
  }
  .smrt-job-list__cell-checkbox {
    width: 40px;
  }
  .smrt-job-list__cell-checkbox input {
    cursor: pointer;
  }
  .smrt-job-list__cell-object {
    max-width: 200px;
  }
  .smrt-job-list__object-id {
    margin-left: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-job-list__cell-method code {
    padding: 0.125rem 0.375rem;
  }
  .smrt-job-list__cell-date {
    white-space: nowrap;
  }
  .smrt-job-list__cell-actions {
    white-space: nowrap;
  }
  .smrt-job-list__cell-loading,
  .smrt-job-list__cell-empty {
    padding: var(--smrt-spacing-xl, 2rem);
  }
  .smrt-job-list__progress {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-job-list__spinner {
    width: 20px;
    height: 20px;
  }
  .smrt-job-list__table.smrt-job-list__loading {
    pointer-events: none;
  }
  .smrt-job-list__head :global(th[data-smrt-component="SortableHeader"]) {
    --smrt-sortable-header-padding: var(--smrt-spacing-sm, 0.5rem)
      var(--smrt-spacing-md, 1rem);
  }
}

@layer smrt.theme {
  .smrt-job-list__table {
    border-collapse: collapse;
    border-spacing: 0;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    background: var(--smrt-color-surface);
  }
  .smrt-job-list__table.smrt-job-list__loading {
    opacity: 0.7;
  }
  .smrt-job-list__head {
    background: var(--smrt-color-surface-container);
  }
  /* Sortable headers are SortableHeader's own <th>: :global, and their
  control carries the padding. */
  .smrt-job-list__head :global(th) {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-align: left;
    border-bottom: var(--smrt-hairline);
  }
  .smrt-job-list__body tr {
    border-bottom: var(--smrt-hairline);
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-job-list__body tr:hover:not(.smrt-job-list__row-loading):not(.smrt-job-list__row-empty) {
    background: var(--smrt-color-surface-container-low);
  }
  /* Mirrors the :hover rule's guards so selection wins the tie by source order. */
  .smrt-job-list__body tr.smrt-job-list__row-selected:not(.smrt-job-list__row-loading):not(.smrt-job-list__row-empty) {
    background: var(--smrt-color-primary-container);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-job-list__body tr {
      transition: none;
    }
    .smrt-job-list__spinner {
      animation: none;
    }
  }
  .smrt-job-list__cell {
    vertical-align: middle;
  }
  .smrt-job-list__cell-checkbox {
    text-align: center;
  }
  .smrt-job-list__cell-queue {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }
  .smrt-job-list__object-type {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-job-list__object-id {
    color: var(--smrt-color-on-surface-variant);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }
  .smrt-job-list__cell-method code {
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }
  .smrt-job-list__cell-priority {
    text-align: center;
  }
  .smrt-job-list__cell-attempts {
    text-align: center;
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }
  .smrt-job-list__cell-date {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-job-list__cell-loading,
  .smrt-job-list__cell-empty {
    text-align: center;
  }
  .smrt-job-list__progress {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-job-list__spinner {
    border: 2px solid var(--smrt-color-outline-variant);
    border-top-color: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-full);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .smrt-job-list__empty {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
