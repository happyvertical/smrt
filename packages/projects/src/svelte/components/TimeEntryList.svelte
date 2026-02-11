<script lang="ts">
/**
 * TimeEntryList - List of time entries with optional selection
 * Supports bulk selection and grouping
 */

import {
  type Currency,
  formatCurrency,
  formatDate,
  formatHours,
  statusColors,
  type TimeEntry,
} from './utils.js';

/** Props for TimeEntryList component */
export interface Props {
  entries: TimeEntry[];
  selectable?: boolean;
  selectedIds?: string[];
  onselectionchange?: (ids: string[]) => void;
  emptyMessage?: string;
  baseHref?: string;
  currency?: Currency;
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

function handleSelect(id: string, selected: boolean, event: Event) {
  event.preventDefault();
  event.stopPropagation();
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
            aria-label="Select all time entries"
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
        {@const entryHref = getEntryHref(entry)}
        <div
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
                  onchange={(e) => handleSelect(entry.id, (e.target as HTMLInputElement).checked, e)}
                  aria-label="Select entry: {entry.description}"
                />
              {/if}
            </div>
          {/if}

          {#if entryHref}
            <a href={entryHref} class="entry-content">
              {@render entryDetails(entry)}
            </a>
          {:else}
            <div class="entry-content">
              {@render entryDetails(entry)}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}

{#snippet entryDetails(entry: TimeEntry)}
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
      {formatCurrency(entry.amount, currency)}
    </div>
  {/if}
{/snippet}

<style>
  .empty-state {
    padding: 3rem 1rem;
    text-align: center;
    color: var(--md-sys-color-on-surface-variant);
  }

  .time-entry-list {
    background: var(--md-sys-color-surface);
    border-radius: var(--md-sys-shape-corner-large, 16px);
    overflow: hidden;
    border: 1px solid var(--md-sys-color-outline-variant);
  }

  .list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--md-sys-color-surface-container-low);
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }

  .select-all {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: var(--md-sys-typescale-body-medium-size, 0.875rem);
    font-weight: var(--md-sys-typescale-label-large-weight, 500);
  }

  .select-all input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
    accent-color: var(--md-sys-color-primary);
  }

  .selection-count {
    font-size: var(--md-sys-typescale-body-medium-size, 0.875rem);
    color: var(--md-sys-color-on-surface-variant);
  }

  .entries {
    display: flex;
    flex-direction: column;
  }

  .entry-row {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
    transition: background 0.15s var(--md-sys-motion-easing-standard);
  }

  .entry-row:last-child {
    border-bottom: none;
  }

  .entry-row:hover {
    background: var(--md-sys-color-surface-container-lowest);
  }

  .entry-row.selected {
    background: var(--md-sys-color-primary-container);
  }

  .checkbox-cell {
    width: 2rem;
    flex-shrink: 0;
    padding-left: 1rem;
  }

  .checkbox-cell input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
    accent-color: var(--md-sys-color-primary);
  }

  .entry-content {
    display: flex;
    align-items: center;
    flex: 1;
    padding: 0.875rem 1rem;
    text-decoration: none;
    color: inherit;
    min-width: 0;
  }

  a.entry-content:focus {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: -2px;
  }

  .date-cell {
    width: 4.5rem;
    flex-shrink: 0;
    font-size: var(--md-sys-typescale-body-medium-size, 0.875rem);
    color: var(--md-sys-color-on-surface-variant);
  }

  .description-cell {
    flex: 1;
    min-width: 0;
    padding-right: 1rem;
  }

  .description {
    display: block;
    font-size: var(--md-sys-typescale-body-large-size, 0.9375rem);
    color: var(--md-sys-color-on-surface);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .worker {
    display: block;
    font-size: var(--md-sys-typescale-body-small-size, 0.75rem);
    color: var(--md-sys-color-on-surface-variant);
    margin-top: 0.125rem;
  }

  .hours-cell {
    width: 4rem;
    flex-shrink: 0;
    font-size: var(--md-sys-typescale-body-large-size, 0.9375rem);
    font-weight: var(--md-sys-typescale-title-medium-weight, 500);
    color: var(--md-sys-color-primary);
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
    font-size: var(--md-sys-typescale-label-small-size, 0.625rem);
    font-weight: var(--md-sys-typescale-label-small-weight, 500);
    padding: 0.25rem 0.5rem;
    border-radius: var(--md-sys-shape-corner-small, 8px);
    background: var(--status-color);
    color: var(--md-sys-color-on-primary);
    text-transform: uppercase;
    letter-spacing: var(--md-sys-typescale-label-small-tracking, 0.5px);
  }

  .amount-cell {
    width: 6rem;
    flex-shrink: 0;
    font-size: var(--md-sys-typescale-body-large-size, 0.9375rem);
    font-weight: var(--md-sys-typescale-title-medium-weight, 500);
    text-align: right;
  }

  @media (max-width: 640px) {
    .entry-content {
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
