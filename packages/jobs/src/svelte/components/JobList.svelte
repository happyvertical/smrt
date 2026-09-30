<script lang="ts">
/**
 * JobList - Display a filterable, sortable list of background jobs.
 *
 * Sorting follows the list-sort contract (`@happyvertical/smrt-ui/data`):
 * newest created first by default, and every column header toggles its
 * column ascending/descending (dates and counts start with the largest).
 * The rows given are the whole list — a parent that pages on the server
 * passes `sort` + `onSortChange` and supplies rows already in that order.
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
  /** Current order (default: newest created first). */
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
  sort = $bindable({ columnId: 'createdAt', direction: 'desc' }),
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
  onSortChange ? jobs : sortListRows(jobs, sort, sortValue),
);

function handleSort(columnId: string) {
  const next = toggleListSort(sort, columnId, JOB_LIST_SORT);
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
</script>

<div class="job-list-container">
  <table class="job-list" class:loading>
    <thead class="job-list__head">
      <tr>
        {#if selectable}
          <th class="job-list__cell job-list__cell--checkbox">
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
        {#each [
          { id: 'status', label: 'Status' },
          { id: 'queue', label: 'Queue' },
          { id: 'objectType', label: 'Object' },
          { id: 'method', label: 'Method' },
          { id: 'priority', label: 'Priority' },
          { id: 'attempts', label: 'Attempts' },
          { id: 'createdAt', label: 'Created' },
          { id: 'runAt', label: t(M['jobs.job_list.run_at']) },
        ] as column (column.id)}
          <SortableHeader
            class="job-list__cell job-list__cell--sortable"
            columnId={column.id}
            label={column.label}
            {sort}
            spec={JOB_LIST_SORT}
            onSort={handleSort}
          />
        {/each}
        {#if showActions}
          <th class="job-list__cell">Actions</th>
        {/if}
      </tr>
    </thead>

    <tbody class="job-list__body">
      {#if loading}
        <tr class="job-list__row job-list__row--loading">
          <td class="job-list__cell job-list__cell--loading" colspan="10">
            <div class="job-list__loading">
              <span class="job-list__spinner"></span>
              <span>{t(M['jobs.job_list.loading_jobs'])}</span>
            </div>
          </td>
        </tr>
      {:else if jobs.length === 0}
        <tr class="job-list__row job-list__row--empty">
          <td class="job-list__cell job-list__cell--empty" colspan="10">
            {#if empty}
              {@render empty()}
            {:else}
              <div class="job-list__empty">
                <span>{t(M['jobs.job_list.no_jobs_found'])}</span>
              </div>
            {/if}
          </td>
        </tr>
      {:else}
        {#each rows as job (job.id)}
          {@const isSelected = selected.has(job.id)}
          <tr
            class="job-list__row"
            class:job-list__row--selected={isSelected}
            onclick={() => handleRowClick(job)}
            onkeydown={onJobClick
              ? (e) => handleRowKeydown(job, e)
              : undefined}
            role={onJobClick ? 'button' : undefined}
            tabindex={onJobClick ? 0 : undefined}
          >
            {#if selectable}
              <td class="job-list__cell job-list__cell--checkbox">
                <!-- raw-primitive-allow: the CheckboxInput form primitive lives in @happyvertical/smrt-svelte, which transitively depends on smrt-jobs (smrt-svelte to smrt-languages to smrt-jobs), so importing it would close a DAG cycle (#1582); native checkbox keeps full keyboard/AT a11y -->
                <input
                  type="checkbox"
                  checked={isSelected}
                  onchange={(e) => handleRowSelect(job.id, e)}
                  aria-label={t(M['jobs.job_list.select_job'])}
                />
              </td>
            {/if}
            <td class="job-list__cell">
              <JobStatusBadge status={job.status} />
            </td>
            <td class="job-list__cell job-list__cell--queue">
              {job.queue}
            </td>
            <td class="job-list__cell job-list__cell--object">
              <span class="object-type">{job.objectType}</span>
              {#if job.objectId}
                <span class="object-id">#{job.objectId.slice(0, 8)}</span>
              {/if}
            </td>
            <td class="job-list__cell job-list__cell--method">
              <code>{job.method}</code>
            </td>
            <td class="job-list__cell job-list__cell--priority">
              {getPriorityLabel(job.priority)}
            </td>
            <td class="job-list__cell job-list__cell--attempts">
              {job.attempts}/{job.maxAttempts}
            </td>
            <td class="job-list__cell job-list__cell--date">
              {formatRelativeTime(job.createdAt)}
            </td>
            <td class="job-list__cell job-list__cell--date">
              {formatRelativeTime(job.runAt)}
            </td>
            {#if showActions}
              <td class="job-list__cell job-list__cell--actions">
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
  .job-list-container {
    width: 100%;
    overflow-x: auto;
  }

  .job-list {
    width: 100%;
    border-collapse: collapse;
    border-spacing: 0;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    background: var(--smrt-color-surface, #ffffff);
  }

  .job-list.loading {
    opacity: 0.7;
    pointer-events: none;
  }

  .job-list__head {
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  /* Sortable headers are SortableHeader's own <th>: :global, and their
     control carries the padding. */
  .job-list__head :global(th) {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }

  .job-list__head :global(th.sortable-header) {
    padding: 0;
    --sortable-header-padding: var(--smrt-spacing-sm, 0.5rem)
      var(--smrt-spacing-md, 1rem);
  }

  .job-list__body tr {
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .job-list__body tr:hover:not(.job-list__row--loading):not(.job-list__row--empty) {
    background: var(--smrt-color-surface-container-low, #f9fafb);
    cursor: pointer;
  }

  .job-list__row--selected {
    background: var(--smrt-color-primary-container, #d6e3ff) !important;
  }

  @media (prefers-reduced-motion: reduce) {
    .job-list__body tr {
      transition: none;
    }
    
    .job-list__spinner {
      animation: none;
    }
  }

  .job-list__cell {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    vertical-align: middle;
  }

  .job-list__cell--checkbox {
    width: 40px;
    text-align: center;
  }

  .job-list__cell--checkbox input {
    cursor: pointer;
  }

  .job-list__cell--queue {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }

  .job-list__cell--object {
    max-width: 200px;
  }

  .object-type {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .object-id {
    margin-left: var(--smrt-spacing-xs, 0.25rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }

  .job-list__cell--method code {
    padding: 0.125rem 0.375rem;
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }

  .job-list__cell--priority {
    text-align: center;
  }

  .job-list__cell--attempts {
    text-align: center;
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }

  .job-list__cell--date {
    color: var(--smrt-color-on-surface-variant, #43474e);
    white-space: nowrap;
  }

  .job-list__cell--actions {
    white-space: nowrap;
  }

  .job-list__cell--loading,
  .job-list__cell--empty {
    padding: var(--smrt-spacing-xl, 2rem);
    text-align: center;
  }

  .job-list__loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-sm, 0.5rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .job-list__spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-top-color: var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-full, 9999px);
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .job-list__empty {
    color: var(--smrt-color-on-surface-variant, #43474e);
  }
</style>
