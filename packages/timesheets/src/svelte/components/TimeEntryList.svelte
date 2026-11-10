<script lang="ts">
/**
 * TimeEntryList - List of time entries with optional selection
 * Supports bulk selection and grouping
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { M } from '../i18n.js';
import {
  type Currency,
  formatCurrency,
  formatDate,
  formatHours,
  type HoursFormatter,
  statusColors,
  type TimeEntry,
} from './utils.js';

const { t } = useI18n();

/** Props for TimeEntryList component */
export interface Props {
  /** Time entries to display in the list. */
  entries: TimeEntry[];
  /** Shows checkboxes for selecting entries. */
  selectable?: boolean;
  /** Identifiers of currently selected entries. */
  selectedIds?: string[];
  /** Invoked when the selection changes. */
  onselectionchange?: (ids: string[]) => void;
  /** Message shown when the entries list is empty. */
  emptyMessage?: string;
  /** Base URL to construct entry detail links. */
  baseHref?: string;
  /** Currency code for formatting amounts. */
  currency?: Currency;
  /** Formats decimal hours; defaults to the legacy one-decimal display. */
  hoursFormatter?: HoursFormatter;
  /** Renders caller-owned evidence in each entry row. */
  details?: Snippet<[TimeEntry]>;
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
  hoursFormatter = formatHours,
  details,
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
  <div class="smrt-time-entry-list__empty" data-smrt-component="TimeEntryList">
    <p>{emptyMessage}</p>
  </div>
{:else}
  <div class="smrt-time-entry-list__root" data-smrt-component="TimeEntryList">
    {#if selectable && selectableEntries.length > 0}
      <div class="smrt-time-entry-list__header" data-smrt-part="header">
        <label class="smrt-time-entry-list__select-all" data-smrt-part="label">
          <!-- raw-primitive-allow: select-all checkbox needs the indeterminate state; must stay native -->
          <input
            type="checkbox"
            checked={allSelected}
            indeterminate={someSelected}
            onchange={handleSelectAll}
            aria-label={t(M['projects.time_entry_list.select_all_aria'])}
          />
          <span>{t(M['projects.time_entry_list.select_all'])}</span>
        </label>
        <span class="smrt-time-entry-list__count" data-smrt-part="count">
          {t(M['projects.time_entry_list.selection_count'], { selected: selectedIds.length, total: selectableEntries.length })}
        </span>
      </div>
    {/if}

    <div class="smrt-time-entry-list__entries" data-smrt-part="list">
      {#each entries as entry (entry.id)}
        {@const isSelected = selectedIds.includes(entry.id)}
        {@const isSelectable = selectable && canSelect(entry)}
        {@const entryHref = getEntryHref(entry)}
        <div
          class="smrt-time-entry-list__row" data-smrt-part="row"
          class:smrt-time-entry-list__selected={isSelected}
          class:smrt-time-entry-list__selectable={isSelectable}
          class:smrt-time-entry-list__has-checkbox={selectable && selectableEntries.length > 0}
        >
          {#if selectable && selectableEntries.length > 0}
            <div class="smrt-time-entry-list__cell-checkbox" data-smrt-part="cell">
              {#if isSelectable}
                <!-- raw-primitive-allow: native row checkbox; no Provider-free checkbox primitive, kept native to match the indeterminate select-all -->
                <input
                  type="checkbox"
                  checked={isSelected}
                  onchange={(e) => handleSelect(entry.id, (e.target as HTMLInputElement).checked, e)}
                  aria-label={t(M['projects.time_entry_list.select_entry_aria'], { description: entry.description })}
                />
              {/if}
            </div>
          {/if}

          {#if entryHref}
            <a href={entryHref} class="smrt-time-entry-list__content" data-smrt-part="body">
              {@render entryDetails(entry)}
            </a>
          {:else}
            <div class="smrt-time-entry-list__content" data-smrt-part="body">
              {@render entryDetails(entry)}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}

{#snippet entryDetails(entry: TimeEntry)}
  <div class="smrt-time-entry-list__cell-date" data-smrt-part="cell">
    {formatDate(entry.date)}
  </div>

  <div class="smrt-time-entry-list__cell-description" data-smrt-part="cell">
    <span class="smrt-time-entry-list__description" data-smrt-part="description">{entry.description}</span>
    {#if entry.workerName}
      <span class="smrt-time-entry-list__worker" data-smrt-part="meta">{entry.workerName}</span>
    {/if}
  </div>

  <div class="smrt-time-entry-list__cell-hours" data-smrt-part="cell">
    {hoursFormatter(entry.hours)}
  </div>

  <div class="smrt-time-entry-list__cell-status" data-smrt-part="cell">
    <span class="smrt-time-entry-list__status" data-smrt-part="badge" style="--smrt-time-entry-list-status-color: {statusColors[entry.status]}">
      {entry.status}
    </span>
  </div>

  {#if entry.amount !== undefined}
    <div class="smrt-time-entry-list__cell-amount" data-smrt-part="cell">
      {formatCurrency(entry.amount, currency)}
    </div>
  {/if}

  {@render details?.(entry)}
{/snippet}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-time-entry-list__empty {
    padding: 3rem 1rem;
  }
  .smrt-time-entry-list__root {
    overflow: hidden;
  }
  .smrt-time-entry-list__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
  }
  .smrt-time-entry-list__select-all {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }
  .smrt-time-entry-list__select-all input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }
  .smrt-time-entry-list__entries {
    display: flex;
    flex-direction: column;
  }
  .smrt-time-entry-list__row {
    display: flex;
    align-items: center;
  }
  .smrt-time-entry-list__cell-checkbox {
    width: 2rem;
    flex-shrink: 0;
    padding-left: 1rem;
  }
  .smrt-time-entry-list__cell-checkbox input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }
  .smrt-time-entry-list__content {
    display: flex;
    align-items: center;
    flex: 1;
    padding: 0.875rem 1rem;
    min-width: 0;
  }
  .smrt-time-entry-list__cell-date {
    width: 4.5rem;
    flex-shrink: 0;
  }
  .smrt-time-entry-list__cell-description {
    flex: 1;
    min-width: 0;
    padding-right: 1rem;
  }
  .smrt-time-entry-list__description {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-time-entry-list__worker {
    display: block;
    margin-top: 0.125rem;
  }
  .smrt-time-entry-list__cell-hours {
    width: 4rem;
    flex-shrink: 0;
    padding-right: 1rem;
  }
  .smrt-time-entry-list__cell-status {
    width: 6rem;
    flex-shrink: 0;
  }
  .smrt-time-entry-list__status {
    display: inline-block;
    padding: 0.25rem 0.5rem;
  }
  .smrt-time-entry-list__cell-amount {
    width: 6rem;
    flex-shrink: 0;
  }
  @media (max-width: 640px) {
    .smrt-time-entry-list__content {
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .smrt-time-entry-list__cell-description {
      order: 1;
      width: 100%;
      padding-right: 0;
    }
    .smrt-time-entry-list__cell-date,
    .smrt-time-entry-list__cell-hours,
    .smrt-time-entry-list__cell-status,
    .smrt-time-entry-list__cell-amount {
      flex: none;
    }
  }
}

@layer smrt.theme {
  .smrt-time-entry-list__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-time-entry-list__root {
    background: var(--smrt-color-surface);
    border-radius: var(--smrt-radius-large);
    border: var(--smrt-hairline);
  }
  .smrt-time-entry-list__header {
    background: var(--smrt-color-surface-container-low);
    border-bottom: var(--smrt-hairline);
  }
  .smrt-time-entry-list__select-all {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-label-large-weight, 500);
  }
  .smrt-time-entry-list__select-all input[type='checkbox'] {
    accent-color: var(--smrt-color-primary);
  }
  .smrt-time-entry-list__count {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-time-entry-list__row {
    border-bottom: var(--smrt-hairline);
    transition: background 0.15s var(--smrt-easing-standard);
  }
  .smrt-time-entry-list__row:last-child {
    border-bottom: none;
  }
  .smrt-time-entry-list__row:hover {
    background: var(--smrt-color-surface-container-lowest);
  }
  .smrt-time-entry-list__row.smrt-time-entry-list__selected {
    background: var(--smrt-color-primary-container);
  }
  .smrt-time-entry-list__cell-checkbox input[type='checkbox'] {
    accent-color: var(--smrt-color-primary);
  }
  .smrt-time-entry-list__content {
    text-decoration: none;
    color: inherit;
  }
  a.smrt-time-entry-list__content:focus {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  .smrt-time-entry-list__cell-date {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-time-entry-list__description {
    font-size: var(--smrt-typography-body-large-size, 0.9375rem);
    color: var(--smrt-color-on-surface);
  }
  .smrt-time-entry-list__worker {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-time-entry-list__cell-hours {
    font-size: var(--smrt-typography-body-large-size, 0.9375rem);
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    color: var(--smrt-color-primary);
    text-align: right;
  }
  .smrt-time-entry-list__cell-status {
    text-align: center;
  }
  .smrt-time-entry-list__status {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    font-weight: var(--smrt-typography-label-small-weight, 500);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-time-entry-list-status-color);
    color: var(--smrt-color-on-primary);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking);
  }
  .smrt-time-entry-list__cell-amount {
    font-size: var(--smrt-typography-body-large-size, 0.9375rem);
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    text-align: right;
  }
}

</style>
