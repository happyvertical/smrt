<script lang="ts">
/**
 * TimeSummary - Summary statistics for time entries
 * Shows total hours, amounts, and pending items
 */

import { type Currency, formatCurrency, formatHours } from './utils.js';

/** Props for TimeSummary component */
export interface Props {
  totalHours: number;
  totalAmount: number;
  pendingHours?: number;
  pendingAmount?: number;
  approvedHours?: number;
  approvedAmount?: number;
  entryCount?: number;
  currency?: Currency;
  showPending?: boolean;
  showApproved?: boolean;
  layout?: 'horizontal' | 'grid';
}

let {
  totalHours,
  totalAmount,
  pendingHours = 0,
  pendingAmount = 0,
  approvedHours = 0,
  approvedAmount = 0,
  entryCount,
  currency = 'CAD',
  showPending = true,
  showApproved = false,
  layout = 'grid',
}: Props = $props();
</script>

<div class="time-summary" class:horizontal={layout === 'horizontal'}>
  <div class="summary-card">
    <span class="label">Total Hours</span>
    <span class="value">{formatHours(totalHours)}</span>
    {#if entryCount !== undefined}
      <span class="count">{entryCount} {entryCount === 1 ? 'entry' : 'entries'}</span>
    {/if}
  </div>

  <div class="summary-card">
    <span class="label">Total Value</span>
    <span class="value">{formatCurrency(totalAmount, currency)}</span>
  </div>

  {#if showPending && (pendingHours > 0 || pendingAmount > 0)}
    <div class="summary-card highlight">
      <span class="label">Pending Approval</span>
      <span class="value">{formatHours(pendingHours)}</span>
      <span class="sub-value">{formatCurrency(pendingAmount, currency)}</span>
    </div>
  {/if}

  {#if showApproved && (approvedHours > 0 || approvedAmount > 0)}
    <div class="summary-card success">
      <span class="label">Approved</span>
      <span class="value">{formatHours(approvedHours)}</span>
      <span class="sub-value">{formatCurrency(approvedAmount, currency)}</span>
    </div>
  {/if}
</div>

<style>
  .time-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 1rem;
  }

  .time-summary.horizontal {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .time-summary.horizontal .summary-card {
    flex: 1 1 140px;
    min-width: 140px;
  }

  .summary-card {
    background: var(--md-sys-color-surface);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-medium, 12px);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .summary-card.highlight {
    background: var(--md-sys-color-tertiary-container);
    border-color: var(--md-sys-color-tertiary);
  }

  .summary-card.success {
    background: var(--md-sys-color-primary-container);
    border-color: var(--md-sys-color-primary);
  }

  .label {
    font-size: var(--md-sys-typescale-label-small-size, 0.75rem);
    font-weight: var(--md-sys-typescale-label-small-weight, 500);
    color: var(--md-sys-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--md-sys-typescale-label-small-tracking, 0.5px);
  }

  .value {
    font-size: var(--md-sys-typescale-headline-small-size, 1.5rem);
    font-weight: var(--md-sys-typescale-headline-small-weight, 400);
    color: var(--md-sys-color-on-surface);
  }

  .sub-value {
    font-size: var(--md-sys-typescale-body-medium-size, 0.875rem);
    color: var(--md-sys-color-on-surface-variant);
  }

  .count {
    font-size: var(--md-sys-typescale-body-small-size, 0.75rem);
    color: var(--md-sys-color-on-surface-variant);
  }

  .highlight .label {
    color: var(--md-sys-color-on-tertiary-container);
  }

  .highlight .value {
    color: var(--md-sys-color-tertiary);
  }

  .highlight .sub-value {
    color: var(--md-sys-color-on-tertiary-container);
  }

  .success .label {
    color: var(--md-sys-color-on-primary-container);
  }

  .success .value {
    color: var(--md-sys-color-primary);
  }

  .success .sub-value {
    color: var(--md-sys-color-on-primary-container);
  }

  @media (max-width: 480px) {
    .time-summary {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
