<script lang="ts">
/**
 * InvoiceTotals - Totals section for invoices/estimates
 *
 * Displays subtotal, tax, total, and optional amount paid/balance due.
 */

interface Props {
  /** Subtotal in cents */
  subtotal: number;
  /** Tax rate as percentage (e.g., 5 for 5%) */
  taxRate?: number;
  /** Tax amount in cents (calculated from rate if not provided) */
  taxAmount?: number;
  /** Total in cents */
  total: number;
  /** Amount already paid in cents */
  amountPaid?: number;
  /** Currency code */
  currency?: 'CAD' | 'USD';
  /** Show tax breakdown */
  showTax?: boolean;
  /** Show payment status */
  showPaid?: boolean;
  /** Tax label */
  taxLabel?: string;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
}

const {
  subtotal,
  taxRate = 0,
  taxAmount,
  total,
  amountPaid = 0,
  currency = 'CAD',
  showTax = true,
  showPaid = false,
  taxLabel = 'GST',
  size = 'md',
}: Props = $props();

// Calculate tax if not provided
const calculatedTax = $derived(
  taxAmount ?? Math.round(subtotal * (taxRate / 100)),
);

// Calculate balance due
const balanceDue = $derived(total - amountPaid);

// Format cents to dollars
function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
</script>

<div class="invoice-totals" class:sm={size === 'sm'} class:lg={size === 'lg'}>
  <div class="totals-row">
    <span class="totals-label">Subtotal</span>
    <span class="totals-value">{formatMoney(subtotal)}</span>
  </div>

  {#if showTax && (taxRate > 0 || calculatedTax > 0)}
    <div class="totals-row">
      <span class="totals-label">{taxLabel} ({taxRate}%)</span>
      <span class="totals-value">{formatMoney(calculatedTax)}</span>
    </div>
  {/if}

  <div class="totals-row total">
    <span class="totals-label">Total</span>
    <span class="totals-value">{formatMoney(total)}</span>
  </div>

  {#if showPaid && amountPaid > 0}
    <div class="totals-row paid">
      <span class="totals-label">Amount Paid</span>
      <span class="totals-value">-{formatMoney(amountPaid)}</span>
    </div>

    <div class="totals-row balance" class:due={balanceDue > 0} class:credit={balanceDue < 0}>
      <span class="totals-label">
        {#if balanceDue > 0}
          Balance Due
        {:else if balanceDue < 0}
          Credit
        {:else}
          Paid in Full
        {/if}
      </span>
      <span class="totals-value">{formatMoney(Math.abs(balanceDue))}</span>
    </div>
  {/if}
</div>

<style>
  .invoice-totals {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
    max-width: 280px;
    margin-left: auto;
  }

  .invoice-totals.sm {
    max-width: 220px;
    gap: 0.375rem;
  }

  .invoice-totals.lg {
    max-width: 320px;
    gap: 0.75rem;
  }

  .totals-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.875rem;
    color: #374151;
  }

  .sm .totals-row {
    font-size: 0.75rem;
  }

  .lg .totals-row {
    font-size: 1rem;
  }

  .totals-label {
    color: #6b7280;
  }

  .totals-value {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }

  .totals-row.total {
    padding-top: 0.5rem;
    border-top: 2px solid #e5e7eb;
    font-weight: 600;
  }

  .totals-row.total .totals-label,
  .totals-row.total .totals-value {
    color: #111827;
    font-size: 1rem;
  }

  .lg .totals-row.total .totals-label,
  .lg .totals-row.total .totals-value {
    font-size: 1.125rem;
  }

  .totals-row.paid {
    color: #16a34a;
  }

  .totals-row.paid .totals-label {
    color: #16a34a;
  }

  .totals-row.balance {
    padding-top: 0.5rem;
    border-top: 1px solid #e5e7eb;
    font-weight: 600;
  }

  .totals-row.balance.due .totals-label,
  .totals-row.balance.due .totals-value {
    color: #dc2626;
  }

  .totals-row.balance.credit .totals-label,
  .totals-row.balance.credit .totals-value {
    color: #16a34a;
  }
</style>
