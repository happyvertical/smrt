<script lang="ts">
/**
 * TimeEntryList - List of time entries with optional selection
 * Supports bulk selection and grouping
 */

import type { TimeEntry } from './TimeEntryCard.svelte';

interface Props {
  entries: TimeEntry[];
  selectable?: boolean;
  selectedIds?: string[];
  onselectionchange?: (ids: string[]) => void;
  emptyMessage?: string;
  baseHref?: string;
  currency?: 'CAD' | 'USD';
  /** Filter function to determine which entries can be selected */
  canSelect?: (entry: TimeEntry) => boolean;
}

let {
  entries,
  selectable = false,
  selectedIds = [],
  onselectionchange,
  emptyMessage = 'No time entries',
  baseHref,
  currency = 'CAD',
  canSelect = () => true,
}: Props = $props();

// Filter entries that can actually be selected
const selectableEntries = $derived(selectable ? entries.filter(canSelect) : []);

const allSelected = $derived(
  selectableEntries.length > 0 &&
    selectableEntries.every((e) => selectedIds.includes(e.id)),
);

const someSelected = $derived(selectedIds.length > 0 && !allSelected);

function handleSelectAll(event: Event) {
  const target = event.target as HTMLInputElement;
  if (target.checked) {
    onselectionchange?.(selectableEntries.map((e) => e.id));
  } else {
    onselectionchange?.([]);
  }
}

function handleSelect(id: string, selected: boolean) {
  if (selected) {
    onselectionchange?.([...selectedIds, id]);
  } else {
    onselectionchange?.(selectedIds.filter((i) => i !== id));
  }
}

function getEntryHref(entry: TimeEntry): string | undefined {
  if (!baseHref) return undefined;
  return `${baseHref}/${entry.id}`;
}

const statusColors: Record<string, string> = {
  draft: 'var(--color-status-draft, #6b7280)',
  submitted: 'var(--color-status-pending, #f59e0b)',
  approved: 'var(--color-status-success, #10b981)',
  rejected: 'var(--color-status-error, #ef4444)',
};

function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatHours(hours: number): string {
  return `${hours.toFixed(1)}h`;
}
</script>

{#if entries.length === 0}
  <div class="empty-state">
    <p>{emptyMessage}</p>
  </div>
{:else}
  <div class="time-entry-list">
    {#if selectable && selectableEntries.length > 0}
      <div class="list-header">
        <label class="select-all">
          <input
            type="checkbox"
            checked={allSelected}
            indeterminate={someSelected}
            onchange={handleSelectAll}
          />
          <span>Select All</span>
        </label>
        <span class="selection-count">
          {selectedIds.length} of {selectableEntries.length} selected
        </span>
      </div>
    {/if}

    <div class="entries">
      {#each entries as entry (entry.id)}
        {@const isSelected = selectedIds.includes(entry.id)}
        {@const isSelectable = selectable && canSelect(entry)}
        <a
          href={getEntryHref(entry)}
          class="entry-row"
          class:selected={isSelected}
          class:selectable={isSelectable}
          class:has-checkbox={selectable && selectableEntries.length > 0}
        >
          {#if selectable && selectableEntries.length > 0}
            <div class="checkbox-cell">
              {#if isSelectable}
                <input
                  type="checkbox"
                  checked={isSelected}
                  onclick={(e) => e.stopPropagation()}
                  onchange={(e) => handleSelect(entry.id, (e.target as HTMLInputElement).checked)}
                  aria-label="Select entry"
                />
              {/if}
            </div>
          {/if}

          <div class="date-cell">
            {formatDate(entry.date)}
          </div>

          <div class="description-cell">
            <span class="description">{entry.description}</span>
            {#if entry.workerName}
              <span class="worker">{entry.workerName}</span>
            {/if}
          </div>

          <div class="hours-cell">
            {formatHours(entry.hours)}
          </div>

          <div class="status-cell">
            <span class="status-badge" style="--status-color: {statusColors[entry.status]}">
              {entry.status}
            </span>
          </div>

          {#if entry.amount !== undefined}
            <div class="amount-cell">
              {formatCurrency(entry.amount)}
            </div>
          {/if}
        </a>
      {/each}
    </div>
  </div>
{/if}

<style>
  .empty-state {
    padding: 3rem 1rem;
    text-align: center;
    color: var(--color-text-muted, #6b7280);
  }

  .time-entry-list {
    background: var(--color-surface, #fff);
    border-radius: var(--radius-lg, 12px);
    overflow: hidden;
    border: 1px solid var(--color-border, #e5e7eb);
  }

  .list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--color-surface-elevated, #f9fafb);
    border-bottom: 1px solid var(--color-border, #e5e7eb);
  }

  .select-all {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .select-all input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }

  .selection-count {
    font-size: 0.875rem;
    color: var(--color-text-muted, #6b7280);
  }

  .entries {
    display: flex;
    flex-direction: column;
  }

  .entry-row {
    display: flex;
    align-items: center;
    padding: 0.875rem 1rem;
    border-bottom: 1px solid var(--color-border, #e5e7eb);
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }

  .entry-row:last-child {
    border-bottom: none;
  }

  .entry-row:hover {
    background: var(--color-surface-hover, #f9fafb);
  }

  .entry-row.selected {
    background: var(--color-primary-bg, #eff6ff);
  }

  .checkbox-cell {
    width: 2rem;
    flex-shrink: 0;
  }

  .checkbox-cell input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }

  .date-cell {
    width: 4.5rem;
    flex-shrink: 0;
    font-size: 0.875rem;
    color: var(--color-text-muted, #6b7280);
  }

  .description-cell {
    flex: 1;
    min-width: 0;
    padding-right: 1rem;
  }

  .description {
    display: block;
    font-size: 0.9375rem;
    color: var(--color-text, #1f2937);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .worker {
    display: block;
    font-size: 0.75rem;
    color: var(--color-text-muted, #6b7280);
    margin-top: 0.125rem;
  }

  .hours-cell {
    width: 4rem;
    flex-shrink: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-primary, #3b82f6);
    text-align: right;
    padding-right: 1rem;
  }

  .status-cell {
    width: 6rem;
    flex-shrink: 0;
    text-align: center;
  }

  .status-badge {
    display: inline-block;
    font-size: 0.625rem;
    font-weight: 600;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm, 4px);
    background: var(--status-color);
    color: white;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .amount-cell {
    width: 6rem;
    flex-shrink: 0;
    font-size: 0.9375rem;
    font-weight: 500;
    text-align: right;
  }

  @media (max-width: 640px) {
    .entry-row {
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .description-cell {
      order: 1;
      width: 100%;
      padding-right: 0;
    }

    .date-cell,
    .hours-cell,
    .status-cell,
    .amount-cell {
      flex: none;
    }
  }
</style>
