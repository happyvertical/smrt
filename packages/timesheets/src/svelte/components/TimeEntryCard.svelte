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
  type HoursFormatter,
  statusColors,
  type TimeEntry,
} from './utils.js';

/** Props for TimeEntryCard component */
export interface Props {
  /** Time entry data to display. */
  entry: TimeEntry;
  /** URL to navigate to when the card is clicked. */
  href?: string;
  /** Invoked when the card content is clicked. */
  onclick?: () => void;
  /** Shows a checkbox for selecting the entry. */
  selectable?: boolean;
  /** Indicates whether the entry is selected. */
  selected?: boolean;
  /** Invoked when the selection checkbox is toggled. */
  onselect?: (id: string, selected: boolean) => void;
  /** Currency code for formatting hourly rates and amounts. */
  currency?: Currency;
  /** Formats decimal hours; defaults to the legacy one-decimal display. */
  hoursFormatter?: HoursFormatter;
  /** Renders caller-owned evidence below the standard entry fields. */
  details?: Snippet<[TimeEntry]>;
  /** Renders action buttons on the right side of the card. */
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
  hoursFormatter = formatHours,
  details,
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
  class="smrt-time-entry-card__root"
  class:smrt-time-entry-card__selectable={selectable}
  class:smrt-time-entry-card__selected={selected}
  class:smrt-time-entry-card__clickable={!!href || !!onclick} data-smrt-component="TimeEntryCard"
>
  {#if selectable}
    <div class="smrt-time-entry-card__checkbox" data-smrt-part="checkbox">
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
      class="smrt-time-entry-card__content" data-smrt-part="body"
      onclick={handleCardClick}
      onkeydown={handleKeydown}
    >
      {@render cardBody()}
    </a>
  {:else if onclick}
    <!-- raw-primitive-allow: pressable selection card wrapping rich content; structural, not a standard action button -->
    <button
      type="button"
      class="smrt-time-entry-card__content" data-smrt-part="body"
      onclick={() => onclick?.()}
    >
      {@render cardBody()}
    </button>
  {:else}
    <div class="smrt-time-entry-card__content" data-smrt-part="body">
      {@render cardBody()}
    </div>
  {/if}

  {#if actions}
    <div class="smrt-time-entry-card__actions" data-smrt-part="actions">
      {@render actions()}
    </div>
  {/if}
</div>

{#snippet cardBody()}
  <div class="smrt-time-entry-card__header" data-smrt-part="header">
    <span class="smrt-time-entry-card__date" data-smrt-part="date">{formatDate(entry.date)}</span>
    <span class="smrt-time-entry-card__status" data-smrt-part="badge" style="--smrt-time-entry-card-status-color: {statusColors[entry.status]}">
      {entry.status.toUpperCase()}
    </span>
  </div>

  <div class="smrt-time-entry-card__body" data-smrt-part="body">
    <p class="smrt-time-entry-card__description" data-smrt-part="description">{entry.description}</p>
    {#if entry.workerName}
      <p class="smrt-time-entry-card__worker" data-smrt-part="meta">{entry.workerName}</p>
    {/if}
  </div>

  <div class="smrt-time-entry-card__footer" data-smrt-part="footer">
    <div class="smrt-time-entry-card__hours" data-smrt-part="hours">
      <span class="smrt-time-entry-card__hours-value" data-smrt-part="value">{hoursFormatter(entry.hours)}</span>
      {#if entry.hourlyRate}
        <span class="smrt-time-entry-card__rate" data-smrt-part="meta">@ {formatCurrency(entry.hourlyRate, currency)}/hr</span>
      {/if}
    </div>
    {#if entry.amount !== undefined}
      <span class="smrt-time-entry-card__amount" data-smrt-part="amount">{formatCurrency(entry.amount, currency)}</span>
    {/if}
  </div>

  {#if entry.mileage && entry.mileage > 0}
    <div class="smrt-time-entry-card__mileage" data-smrt-part="mileage">
      {t(M['projects.time_entry_card.mileage'], { mileage: entry.mileage })}
    </div>
  {/if}

  {@render details?.(entry)}
{/snippet}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-time-entry-card__root {
    display: flex;
    align-items: stretch;
    overflow: hidden;
  }
  .smrt-time-entry-card__root.smrt-time-entry-card__clickable .smrt-time-entry-card__content {
    cursor: pointer;
  }
  .smrt-time-entry-card__checkbox {
    display: flex;
    align-items: center;
    padding: 1rem;
  }
  .smrt-time-entry-card__checkbox input[type='checkbox'] {
    width: 1.25rem;
    height: 1.25rem;
    cursor: pointer;
  }
  .smrt-time-entry-card__content {
    flex: 1;
    padding: 1rem;
    min-width: 0;
    display: block;
    width: 100%;
  }
  .smrt-time-entry-card__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  .smrt-time-entry-card__status {
    padding: 0.25rem 0.5rem;
  }
  .smrt-time-entry-card__body {
    margin-bottom: 0.75rem;
  }
  .smrt-time-entry-card__description {
    margin: 0;
  }
  .smrt-time-entry-card__worker {
    margin: 0.25rem 0 0;
  }
  .smrt-time-entry-card__footer {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .smrt-time-entry-card__hours {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .smrt-time-entry-card__mileage {
    margin-top: 0.5rem;
  }
  .smrt-time-entry-card__actions {
    display: flex;
    align-items: center;
    padding: 0.5rem;
  }
}

@layer smrt.theme {
  .smrt-time-entry-card__root {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
    transition: all 0.2s var(--smrt-easing-standard);
  }
  .smrt-time-entry-card__root:hover {
    border-color: var(--smrt-hairline-strong-color);
  }
  .smrt-time-entry-card__root.smrt-time-entry-card__selected {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }
  .smrt-time-entry-card__root.smrt-time-entry-card__clickable:hover {
    box-shadow: var(--smrt-elevation-1);
  }
  .smrt-time-entry-card__checkbox {
    background: var(--smrt-color-surface-container-low);
    border-right: var(--smrt-hairline);
  }
  .smrt-time-entry-card__checkbox input[type='checkbox'] {
    accent-color: var(--smrt-color-primary);
  }
  .smrt-time-entry-card__content {
    text-decoration: none;
    color: inherit;
    background: transparent;
    border: none;
    text-align: left;
    font: inherit;
  }
  a.smrt-time-entry-card__content:focus,
  button.smrt-time-entry-card__content:focus {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
    border-radius: var(--smrt-radius-small);
  }
  .smrt-time-entry-card__date {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-time-entry-card__status {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    font-weight: var(--smrt-typography-label-small-weight, 500);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-time-entry-card-status-color);
    color: var(--smrt-color-on-primary);
    letter-spacing: var(--smrt-typography-label-small-tracking);
  }
  .smrt-time-entry-card__description {
    font-size: var(--smrt-typography-body-large-size, 0.9375rem);
    color: var(--smrt-color-on-surface);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
  }
  .smrt-time-entry-card__worker {
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-time-entry-card__hours-value {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    color: var(--smrt-color-primary);
  }
  .smrt-time-entry-card__rate {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-time-entry-card__amount {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-time-entry-card__mileage {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-time-entry-card__actions {
    border-left: var(--smrt-hairline);
  }
}

</style>
