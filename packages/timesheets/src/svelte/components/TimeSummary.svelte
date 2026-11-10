<script lang="ts">
/**
 * TimeSummary - Summary statistics for time entries
 * Shows total hours, amounts, and pending items
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import {
  type Currency,
  formatCurrency,
  formatHours,
  type HoursFormatter,
} from './utils.js';

/** Props for TimeSummary component */
export interface Props {
  /** Total hours across all time entries. */
  totalHours: number;
  /** Total charged or invoiced amount. */
  totalAmount: number;
  /** Hours awaiting approval. */
  pendingHours?: number;
  /** Amount awaiting approval. */
  pendingAmount?: number;
  /** Hours that have been approved. */
  approvedHours?: number;
  /** Amount that has been approved. */
  approvedAmount?: number;
  /** Number of time entries included in the summary. */
  entryCount?: number;
  /** Currency code for formatting amounts. */
  currency?: Currency;
  /** Formats decimal hours; defaults to the legacy one-decimal display. */
  hoursFormatter?: HoursFormatter;
  /** Shows the pending hours and amount card when there are pending items. */
  showPending?: boolean;
  /** Shows the approved hours and amount card when there are approved items. */
  showApproved?: boolean;
  /** Arranges summary cards in a grid or flexbox layout. */
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
  hoursFormatter = formatHours,
  showPending = true,
  showApproved = false,
  layout = 'grid',
}: Props = $props();

const { t } = useI18n();
</script>

<div class="smrt-time-summary__root" class:smrt-time-summary__horizontal={layout === 'horizontal'} data-smrt-component="TimeSummary">
  <div class="smrt-time-summary__card" data-smrt-part="card">
    <span class="smrt-time-summary__label" data-smrt-part="label">{t(M['projects.time_summary.total_hours'])}</span>
    <span class="smrt-time-summary__value" data-smrt-part="value">{hoursFormatter(totalHours)}</span>
    {#if entryCount !== undefined}
      <span class="smrt-time-summary__count" data-smrt-part="count">{entryCount} {entryCount === 1 ? 'entry' : 'entries'}</span>
    {/if}
  </div>

  <div class="smrt-time-summary__card" data-smrt-part="card">
    <span class="smrt-time-summary__label" data-smrt-part="label">{t(M['projects.time_summary.total_value'])}</span>
    <span class="smrt-time-summary__value" data-smrt-part="value">{formatCurrency(totalAmount, currency)}</span>
  </div>

  {#if showPending && (pendingHours > 0 || pendingAmount > 0)}
    <div class="smrt-time-summary__card smrt-time-summary__highlight" data-smrt-part="card">
      <span class="smrt-time-summary__label" data-smrt-part="label">{t(M['projects.time_summary.pending_approval'])}</span>
      <span class="smrt-time-summary__value" data-smrt-part="value">{hoursFormatter(pendingHours)}</span>
      <span class="smrt-time-summary__sub-value" data-smrt-part="meta">{formatCurrency(pendingAmount, currency)}</span>
    </div>
  {/if}

  {#if showApproved && (approvedHours > 0 || approvedAmount > 0)}
    <div class="smrt-time-summary__card smrt-time-summary__success" data-smrt-part="card">
      <span class="smrt-time-summary__label" data-smrt-part="label">Approved</span>
      <span class="smrt-time-summary__value" data-smrt-part="value">{hoursFormatter(approvedHours)}</span>
      <span class="smrt-time-summary__sub-value" data-smrt-part="meta">{formatCurrency(approvedAmount, currency)}</span>
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-time-summary__root {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 1rem;
  }
  .smrt-time-summary__root.smrt-time-summary__horizontal {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .smrt-time-summary__root.smrt-time-summary__horizontal .smrt-time-summary__card {
    flex: 1 1 140px;
    min-width: 140px;
  }
  .smrt-time-summary__card {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  @media (max-width: 480px) {
    .smrt-time-summary__root {
      grid-template-columns: 1fr 1fr;
    }
  }
}

@layer smrt.theme {
  .smrt-time-summary__card {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
  }
  .smrt-time-summary__card.smrt-time-summary__highlight {
    background: var(--smrt-color-tertiary-container);
    border-color: var(--smrt-color-tertiary);
  }
  .smrt-time-summary__card.smrt-time-summary__success {
    background: var(--smrt-color-primary-container);
    border-color: var(--smrt-color-primary);
  }
  .smrt-time-summary__label {
    font-size: var(--smrt-typography-label-small-size, 0.75rem);
    font-weight: var(--smrt-typography-label-small-weight, 500);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking);
  }
  .smrt-time-summary__value {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-headline-small-weight, 400);
    color: var(--smrt-color-on-surface);
  }
  .smrt-time-summary__sub-value {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-time-summary__count {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-time-summary__highlight .smrt-time-summary__label {
    color: var(--smrt-color-on-tertiary-container);
  }
  .smrt-time-summary__highlight .smrt-time-summary__value {
    color: var(--smrt-color-tertiary);
  }
  .smrt-time-summary__highlight .smrt-time-summary__sub-value {
    color: var(--smrt-color-on-tertiary-container);
  }
  .smrt-time-summary__success .smrt-time-summary__label {
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-time-summary__success .smrt-time-summary__value {
    color: var(--smrt-color-primary);
  }
  .smrt-time-summary__success .smrt-time-summary__sub-value {
    color: var(--smrt-color-on-primary-container);
  }
}

</style>
