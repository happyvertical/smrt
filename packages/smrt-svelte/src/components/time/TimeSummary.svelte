<script lang="ts">
/**
 * TimeSummary - Summary statistics for time entries
 * Shows total hours, amounts, and pending items
 */

interface Props {
  totalHours: number;
  totalAmount: number;
  pendingHours?: number;
  pendingAmount?: number;
  approvedHours?: number;
  approvedAmount?: number;
  entryCount?: number;
  currency?: 'CAD' | 'USD';
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
    <span class="value">{formatCurrency(totalAmount)}</span>
  </div>

  {#if showPending && (pendingHours > 0 || pendingAmount > 0)}
    <div class="summary-card highlight">
      <span class="label">Pending Approval</span>
      <span class="value">{formatHours(pendingHours)}</span>
      <span class="sub-value">{formatCurrency(pendingAmount)}</span>
    </div>
  {/if}

  {#if showApproved && (approvedHours > 0 || approvedAmount > 0)}
    <div class="summary-card success">
      <span class="label">Approved</span>
      <span class="value">{formatHours(approvedHours)}</span>
      <span class="sub-value">{formatCurrency(approvedAmount)}</span>
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
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .summary-card.highlight {
    background: var(--color-warning-bg, #fffbeb);
    border-color: var(--color-warning-border, #fcd34d);
  }

  .summary-card.success {
    background: var(--color-success-bg, #ecfdf5);
    border-color: var(--color-success-border, #6ee7b7);
  }

  .label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-muted, #6b7280);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .value {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--color-text, #1f2937);
  }

  .sub-value {
    font-size: 0.875rem;
    color: var(--color-text-muted, #6b7280);
  }

  .count {
    font-size: 0.75rem;
    color: var(--color-text-muted, #6b7280);
  }

  .highlight .value {
    color: var(--color-warning, #f59e0b);
  }

  .success .value {
    color: var(--color-success, #10b981);
  }

  @media (max-width: 480px) {
    .time-summary {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
