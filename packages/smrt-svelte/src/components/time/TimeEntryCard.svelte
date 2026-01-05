<script lang="ts">
/**
 * TimeEntryCard - Card component for displaying time entries
 * Supports selection mode for bulk operations
 */

import type { Snippet } from 'svelte';
import {
  type Currency,
  formatCurrency,
  formatDate,
  formatHours,
  statusColors,
  type TimeEntryStatus,
} from './utils.js';

export interface TimeEntry {
  id: string;
  date: Date | string;
  hours: number;
  description: string;
  status: TimeEntryStatus;
  amount?: number;
  workerName?: string;
  mileage?: number;
  hourlyRate?: number;
}

interface Props {
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
      <input
        type="checkbox"
        checked={selected}
        onchange={handleCheckboxChange}
        aria-label="Select time entry for {entry.description}"
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
      + {entry.mileage} km mileage
    </div>
  {/if}
{/snippet}

<style>
  .time-entry-card {
    display: flex;
    align-items: stretch;
    background: var(--md-sys-color-surface);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-medium, 12px);
    overflow: hidden;
    transition: all 0.2s var(--md-sys-motion-easing-standard);
  }

  .time-entry-card:hover {
    border-color: var(--md-sys-color-outline);
  }

  .time-entry-card.selected {
    border-color: var(--md-sys-color-primary);
    background: var(--md-sys-color-primary-container);
  }

  .time-entry-card.clickable .card-content {
    cursor: pointer;
  }

  .time-entry-card.clickable:hover {
    box-shadow: var(--md-sys-elevation-level1);
  }

  .checkbox-wrapper {
    display: flex;
    align-items: center;
    padding: 1rem;
    background: var(--md-sys-color-surface-container-low);
    border-right: 1px solid var(--md-sys-color-outline-variant);
  }

  .checkbox-wrapper input[type='checkbox'] {
    width: 1.25rem;
    height: 1.25rem;
    cursor: pointer;
    accent-color: var(--md-sys-color-primary);
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
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: -2px;
    border-radius: var(--md-sys-shape-corner-small, 8px);
  }

  .entry-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .date {
    font-size: var(--md-sys-typescale-body-medium-size, 0.875rem);
    color: var(--md-sys-color-on-surface-variant);
  }

  .status-badge {
    font-size: var(--md-sys-typescale-label-small-size, 0.625rem);
    font-weight: var(--md-sys-typescale-label-small-weight, 500);
    padding: 0.25rem 0.5rem;
    border-radius: var(--md-sys-shape-corner-small, 8px);
    background: var(--status-color);
    color: var(--md-sys-color-on-primary);
    letter-spacing: var(--md-sys-typescale-label-small-tracking, 0.5px);
  }

  .entry-body {
    margin-bottom: 0.75rem;
  }

  .description {
    margin: 0;
    font-size: var(--md-sys-typescale-body-large-size, 0.9375rem);
    color: var(--md-sys-color-on-surface);
    line-height: var(--md-sys-typescale-body-large-line-height, 1.5);
  }

  .worker {
    margin: 0.25rem 0 0;
    font-size: var(--md-sys-typescale-body-small-size, 0.8125rem);
    color: var(--md-sys-color-on-surface-variant);
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
    font-size: var(--md-sys-typescale-body-large-size, 1rem);
    font-weight: var(--md-sys-typescale-title-medium-weight, 500);
    color: var(--md-sys-color-primary);
  }

  .rate {
    font-size: var(--md-sys-typescale-body-small-size, 0.75rem);
    color: var(--md-sys-color-on-surface-variant);
  }

  .amount {
    font-size: var(--md-sys-typescale-body-large-size, 1rem);
    font-weight: var(--md-sys-typescale-title-medium-weight, 500);
    color: var(--md-sys-color-on-surface);
  }

  .mileage {
    margin-top: 0.5rem;
    font-size: var(--md-sys-typescale-body-small-size, 0.75rem);
    color: var(--md-sys-color-on-surface-variant);
  }

  .card-actions {
    display: flex;
    align-items: center;
    padding: 0.5rem;
    border-left: 1px solid var(--md-sys-color-outline-variant);
  }
</style>
