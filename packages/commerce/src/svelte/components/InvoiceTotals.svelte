<script lang="ts">
/**
 * InvoiceTotals - Totals section for invoices/estimates
 *
 * Displays subtotal, tax, total, and optional amount paid/balance due.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';

const { t } = useI18n();

/** Props for InvoiceTotals component */
export interface Props {
  /** Subtotal in decimal dollars */
  subtotal: number;
  /** Tax rate as percentage (e.g., 5 for 5%) */
  taxRate?: number;
  /** Tax amount in decimal dollars (calculated from rate if not provided) */
  taxAmount?: number;
  /** Total in decimal dollars */
  total: number;
  /** Amount already paid in decimal dollars */
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

// Calculate tax if not provided. `taxRate` is a percentage (e.g. 5 for 5%), so
// the `/ 100` converts percent → fraction — it is NOT a cents conversion. The
// result is decimal dollars and must not be rounded to whole units.
const calculatedTax = $derived(taxAmount ?? subtotal * (taxRate / 100));

// Calculate balance due
const balanceDue = $derived(total - amountPaid);

// Format decimal-dollar amounts. The commerce models store DECIMAL dollars
// (AGENTS.md "Currency in decimal fields"), not integer cents.
function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
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
      <span class="totals-label">{t(M['commerce.invoice_totals.amount_paid'])}</span>
      <span class="totals-value">-{formatMoney(amountPaid)}</span>
    </div>

    <div class="totals-row balance" class:due={balanceDue > 0} class:credit={balanceDue < 0}>
      <span class="totals-label">
        {#if balanceDue > 0}
          {t(M['commerce.invoice_totals.balance_due'])}
        {:else if balanceDue < 0}
          {t(M['commerce.invoice_totals.credit'])}
        {:else}
          {t(M['commerce.invoice_totals.paid_in_full'])}
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
    gap: var(--smrt-spacing-2, 0.5rem);
    width: 100%;
    max-width: 280px;
    margin-left: auto;
  }

  .invoice-totals.sm {
    max-width: 220px;
    gap: var(--smrt-spacing-1_5, 0.375rem);
  }

  .invoice-totals.lg {
    max-width: 320px;
    gap: var(--smrt-spacing-3, 0.75rem);
  }

  .totals-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface, #1c1b1f);
  }

  .sm .totals-row {
    font: var(--smrt-typography-body-small-font);
  }

  .lg .totals-row {
    font: var(--smrt-typography-body-large-font);
  }

  .totals-label {
    color: var(--smrt-color-on-surface-variant, #49454f);
  }

  .totals-value {
    font-variant-numeric: tabular-nums;
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #1c1b1f);
  }

  .totals-row.total {
    padding-top: var(--smrt-spacing-2, 0.5rem);
    border-top: 2px solid var(--smrt-color-outline-variant, #c4c6d0);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .totals-row.total .totals-label,
  .totals-row.total .totals-value {
    color: var(--smrt-color-on-surface, #1c1b1f);
    font: var(--smrt-typography-title-medium-font);
  }

  .lg .totals-row.total .totals-label,
  .lg .totals-row.total .totals-value {
    font: var(--smrt-typography-title-large-font);
  }

  .totals-row.paid {
    color: var(--smrt-color-tertiary, #006c4c);
  }

  .totals-row.paid .totals-label {
    color: var(--smrt-color-tertiary, #006c4c);
  }

  .totals-row.balance {
    padding-top: var(--smrt-spacing-2, 0.5rem);
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .totals-row.balance.due .totals-label,
  .totals-row.balance.due .totals-value {
    color: var(--smrt-color-error, #ba1a1a);
  }

  .totals-row.balance.credit .totals-label,
  .totals-row.balance.credit .totals-value {
    color: var(--smrt-color-tertiary, #006c4c);
  }
</style>
