<script lang="ts">
/**
 * TimeEntryCard - Card component for displaying time entries
 * Supports selection mode for bulk operations
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { M } from '../i18n.js';
import {
  type Currency,
  formatCurrency,
  formatDate,
  formatHours,
  statusColors,
  type TimeEntry,
} from './utils.js';

/** Props for TimeEntryCard component */
export interface Props {
  entry: TimeEntry;
  href?: string;
  onclick?: () => void;
  selectable?: boolean;
  selected?: boolean;
  onselect?: (id: string, selected: boolean) => void;
  currency?: Currency;
  actions?: Snippet;
}

let {
  entry,
  href,
  onclick,
  selectable = false,
  selected = false,
  onselect,
  currency = 'CAD',
  actions,
}: Props = $props();

const { t } = useI18n();

function handleCheckboxChange(event: Event) {
  const target = event.target as HTMLInputElement;
  onselect?.(entry.id, target.checked);
}

function handleCardClick(event: MouseEvent) {
  // If there's an onclick handler, use it
  if (onclick) {
    event.preventDefault();
    onclick();
  }
  // If href is provided, let the anchor handle navigation naturally
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    if (onclick) {
      event.preventDefault();
      onclick();
    }
    // For href, let the anchor handle it naturally
  }
}
</script>

<div
  class="time-entry-card"
  class:selectable
  class:selected
  class:clickable={!!href || !!onclick}
>
  {#if selectable}
    <div class="checkbox-wrapper">
      <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive, kept native to match the indeterminate select-all in TimeEntryList -->
      <input
        type="checkbox"
        checked={selected}
        onchange={handleCheckboxChange}
        aria-label={t(M['projects.time_entry_card.select_entry'], { description: entry.description })}
      />
    </div>
  {/if}

  {#if href}
    <a
      {href}
      class="card-content"
      onclick={handleCardClick}
      onkeydown={handleKeydown}
    >
      {@render cardBody()}
    </a>
  {:else if onclick}
    <!-- raw-primitive-allow: pressable selection card wrapping rich content; structural, not a standard action button -->
    <button
      type="button"
      class="card-content"
      onclick={() => onclick?.()}
    >
      {@render cardBody()}
    </button>
  {:else}
    <div class="card-content">
      {@render cardBody()}
    </div>
  {/if}

  {#if actions}
    <div class="card-actions">
      {@render actions()}
    </div>
  {/if}
</div>

{#snippet cardBody()}
  <div class="entry-header">
    <span class="date">{formatDate(entry.date)}</span>
    <span class="status-badge" style="--status-color: {statusColors[entry.status]}">
      {entry.status.toUpperCase()}
    </span>
  </div>

  <div class="entry-body">
    <p class="description">{entry.description}</p>
    {#if entry.workerName}
      <p class="worker">{entry.workerName}</p>
    {/if}
  </div>

  <div class="entry-footer">
    <div class="hours">
      <span class="hours-value">{formatHours(entry.hours)}</span>
      {#if entry.hourlyRate}
        <span class="rate">@ {formatCurrency(entry.hourlyRate, currency)}/hr</span>
      {/if}
    </div>
    {#if entry.amount !== undefined}
      <span class="amount">{formatCurrency(entry.amount, currency)}</span>
    {/if}
  </div>

  {#if entry.mileage && entry.mileage > 0}
    <div class="mileage">
      {t(M['projects.time_entry_card.mileage'], { mileage: entry.mileage })}
    </div>
  {/if}
{/snippet}

<style>
  .time-entry-card {
    display: flex;
    align-items: stretch;
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-medium, 12px);
    overflow: hidden;
    transition: all 0.2s var(--smrt-easing-standard);
  }

  .time-entry-card:hover {
    border-color: var(--smrt-color-outline);
  }

  .time-entry-card.selected {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }

  .time-entry-card.clickable .card-content {
    cursor: pointer;
  }

  .time-entry-card.clickable:hover {
    box-shadow: var(--smrt-elevation-1);
  }

  .checkbox-wrapper {
    display: flex;
    align-items: center;
    padding: 1rem;
    background: var(--smrt-color-surface-container-low);
    border-right: 1px solid var(--smrt-color-outline-variant);
  }

  .checkbox-wrapper input[type='checkbox'] {
    width: 1.25rem;
    height: 1.25rem;
    cursor: pointer;
    accent-color: var(--smrt-color-primary);
  }

  .card-content {
    flex: 1;
    padding: 1rem;
    min-width: 0;
    text-decoration: none;
    color: inherit;
    background: transparent;
    border: none;
    text-align: left;
    font: inherit;
    display: block;
    width: 100%;
  }

  a.card-content:focus,
  button.card-content:focus {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
    border-radius: var(--smrt-radius-small, 8px);
  }

  .entry-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .date {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .status-badge {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    font-weight: var(--smrt-typography-label-small-weight, 500);
    padding: 0.25rem 0.5rem;
    border-radius: var(--smrt-radius-small, 8px);
    background: var(--status-color);
    color: var(--smrt-color-on-primary);
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.5px);
  }

  .entry-body {
    margin-bottom: 0.75rem;
  }

  .description {
    margin: 0;
    font-size: var(--smrt-typography-body-large-size, 0.9375rem);
    color: var(--smrt-color-on-surface);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
  }

  .worker {
    margin: 0.25rem 0 0;
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .entry-footer {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .hours {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .hours-value {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    color: var(--smrt-color-primary);
  }

  .rate {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .amount {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    color: var(--smrt-color-on-surface);
  }

  .mileage {
    margin-top: 0.5rem;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .card-actions {
    display: flex;
    align-items: center;
    padding: 0.5rem;
    border-left: 1px solid var(--smrt-color-outline-variant);
  }
</style>
