<script lang="ts">
/**
 * TimeSummary - Summary statistics for time entries
 * Shows total hours, amounts, and pending items
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
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

const { t } = useI18n();
</script>

<div class="time-summary" class:horizontal={layout === 'horizontal'}>
  <div class="summary-card">
    <span class="label">{t(M['projects.time_summary.total_hours'])}</span>
    <span class="value">{formatHours(totalHours)}</span>
    {#if entryCount !== undefined}
      <span class="count">{entryCount} {entryCount === 1 ? 'entry' : 'entries'}</span>
    {/if}
  </div>

  <div class="summary-card">
    <span class="label">{t(M['projects.time_summary.total_value'])}</span>
    <span class="value">{formatCurrency(totalAmount, currency)}</span>
  </div>

  {#if showPending && (pendingHours > 0 || pendingAmount > 0)}
    <div class="summary-card highlight">
      <span class="label">{t(M['projects.time_summary.pending_approval'])}</span>
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
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-medium, 12px);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .summary-card.highlight {
    background: var(--smrt-color-tertiary-container);
    border-color: var(--smrt-color-tertiary);
  }

  .summary-card.success {
    background: var(--smrt-color-primary-container);
    border-color: var(--smrt-color-primary);
  }

  .label {
    font-size: var(--smrt-typography-label-small-size, 0.75rem);
    font-weight: var(--smrt-typography-label-small-weight, 500);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.5px);
  }

  .value {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-headline-small-weight, 400);
    color: var(--smrt-color-on-surface);
  }

  .sub-value {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .count {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .highlight .label {
    color: var(--smrt-color-on-tertiary-container);
  }

  .highlight .value {
    color: var(--smrt-color-tertiary);
  }

  .highlight .sub-value {
    color: var(--smrt-color-on-tertiary-container);
  }

  .success .label {
    color: var(--smrt-color-on-primary-container);
  }

  .success .value {
    color: var(--smrt-color-primary);
  }

  .success .sub-value {
    color: var(--smrt-color-on-primary-container);
  }

  @media (max-width: 480px) {
    .time-summary {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
