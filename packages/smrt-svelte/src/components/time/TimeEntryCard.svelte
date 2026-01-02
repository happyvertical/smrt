<script lang="ts">
/**
 * TimeEntryCard - Card component for displaying time entries
 * Supports selection mode for bulk operations
 */

import type { Snippet } from 'svelte';

export interface TimeEntry {
  id: string;
  date: Date | string;
  hours: number;
  description: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
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
  currency?: 'CAD' | 'USD';
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

function handleCheckboxChange(event: Event) {
  const target = event.target as HTMLInputElement;
  onselect?.(entry.id, target.checked);
}

function handleClick() {
  if (onclick) {
    onclick();
  } else if (href) {
    window.location.href = href;
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    handleClick();
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
        aria-label="Select entry"
      />
    </div>
  {/if}

  <div
    class="card-content"
    role={href || onclick ? 'button' : undefined}
    tabindex={href || onclick ? 0 : undefined}
    onclick={handleClick}
    onkeydown={handleKeydown}
  >
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
          <span class="rate">@ {formatCurrency(entry.hourlyRate)}/hr</span>
        {/if}
      </div>
      {#if entry.amount !== undefined}
        <span class="amount">{formatCurrency(entry.amount)}</span>
      {/if}
    </div>

    {#if entry.mileage && entry.mileage > 0}
      <div class="mileage">
        + {entry.mileage} km mileage
      </div>
    {/if}
  </div>

  {#if actions}
    <div class="card-actions">
      {@render actions()}
    </div>
  {/if}
</div>

<style>
  .time-entry-card {
    display: flex;
    align-items: stretch;
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    overflow: hidden;
    transition: all 0.2s;
  }

  .time-entry-card:hover {
    border-color: var(--color-border-hover, #d1d5db);
  }

  .time-entry-card.selected {
    border-color: var(--color-primary, #3b82f6);
    background: var(--color-primary-bg, #eff6ff);
  }

  .time-entry-card.clickable .card-content {
    cursor: pointer;
  }

  .time-entry-card.clickable:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  }

  .checkbox-wrapper {
    display: flex;
    align-items: center;
    padding: 1rem;
    background: var(--color-surface-elevated, #f9fafb);
    border-right: 1px solid var(--color-border, #e5e7eb);
  }

  .checkbox-wrapper input[type='checkbox'] {
    width: 1.25rem;
    height: 1.25rem;
    cursor: pointer;
  }

  .card-content {
    flex: 1;
    padding: 1rem;
    min-width: 0;
  }

  .card-content:focus {
    outline: 2px solid var(--color-primary, #3b82f6);
    outline-offset: -2px;
  }

  .entry-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .date {
    font-size: 0.875rem;
    color: var(--color-text-muted, #6b7280);
  }

  .status-badge {
    font-size: 0.625rem;
    font-weight: 600;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm, 4px);
    background: var(--status-color);
    color: white;
    letter-spacing: 0.05em;
  }

  .entry-body {
    margin-bottom: 0.75rem;
  }

  .description {
    margin: 0;
    font-size: 0.9375rem;
    color: var(--color-text, #1f2937);
    line-height: 1.4;
  }

  .worker {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    color: var(--color-text-muted, #6b7280);
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
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-primary, #3b82f6);
  }

  .rate {
    font-size: 0.75rem;
    color: var(--color-text-muted, #6b7280);
  }

  .amount {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text, #1f2937);
  }

  .mileage {
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: var(--color-text-muted, #6b7280);
  }

  .card-actions {
    display: flex;
    align-items: center;
    padding: 0.5rem;
    border-left: 1px solid var(--color-border, #e5e7eb);
  }
</style>
