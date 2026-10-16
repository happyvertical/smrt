<script lang="ts">
/**
 * InvoiceTotals - Totals section for invoices/estimates
 *
 * Displays stored subtotal, discount, tax lines, total, paid and payable facts.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { M } from '../i18n.js';
import {
  formatInvoiceMinorUnits,
  type RetainedInvoiceTotalsView,
} from '../invoice-display.js';

const { t } = useI18n();

/** Exact stored totals; the component never derives tax from a rate. */
export interface RetainedInvoiceTotalsProps {
  /** Caller-authoritative totals; omitted facts remain omitted. */
  retained: RetainedInvoiceTotalsView;
  /** Renders additional retained totals evidence. */
  details?: Snippet<[RetainedInvoiceTotalsView]>;
  /** Size variant. */
  size?: 'sm' | 'md' | 'lg';
}

/** Stored invoice totals, displayed exactly as supplied in integer minor units. */
export type Props = RetainedInvoiceTotalsProps;

const { retained, details, size = 'md' }: Props = $props();
</script>

<div class="invoice-totals" class:sm={size === 'sm'} class:lg={size === 'lg'} data-smrt-component="InvoiceTotals">
  <div class="totals-row"><span class="totals-label">Subtotal</span><span class="totals-value">{formatInvoiceMinorUnits(retained.subtotalMinor, retained.currency)}</span></div>
  {#if retained.discountMinor !== undefined}<div class="totals-row"><span class="totals-label">Discount</span><span class="totals-value">{formatInvoiceMinorUnits(retained.discountMinor, retained.currency)}</span></div>{/if}
  {#each retained.taxes ?? [] as tax (tax.id)}<div class="totals-row"><span class="totals-label">{tax.label}</span><span class="totals-value">{formatInvoiceMinorUnits(tax.amountMinor, retained.currency)}</span></div>{/each}
  {#if retained.holdbackMinor !== undefined}<div class="totals-row"><span class="totals-label">{retained.holdbackLabel ?? 'Holdback'}</span><span class="totals-value">{formatInvoiceMinorUnits(retained.holdbackMinor, retained.currency)}</span></div>{/if}
  <div class="totals-row total"><span class="totals-label">Total</span><span class="totals-value">{formatInvoiceMinorUnits(retained.totalMinor, retained.currency)}</span></div>
  {#if retained.paidMinor !== undefined}<div class="totals-row paid"><span class="totals-label">{t(M['commerce.invoice_totals.amount_paid'])}</span><span class="totals-value">{formatInvoiceMinorUnits(retained.paidMinor, retained.currency)}</span></div>{/if}
  {#if retained.payableMinor !== undefined}<div class="totals-row balance"><span class="totals-label">Payable</span><span class="totals-value">{formatInvoiceMinorUnits(retained.payableMinor, retained.currency)}</span></div>{/if}
  {@render details?.(retained)}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
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
    color: var(--smrt-color-on-surface);
  }

  .sm .totals-row {
    font: var(--smrt-typography-body-small-font);
  }

  .lg .totals-row {
    font: var(--smrt-typography-body-large-font);
  }

  .totals-label {
    color: var(--smrt-color-on-surface-variant);
  }

  .totals-value {
    font-variant-numeric: tabular-nums;
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }

  .totals-row.total {
    padding-top: var(--smrt-spacing-2, 0.5rem);
    border-top: 2px solid var(--smrt-color-outline-variant);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .totals-row.total .totals-label,
  .totals-row.total .totals-value {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }

  .lg .totals-row.total .totals-label,
  .lg .totals-row.total .totals-value {
    font: var(--smrt-typography-title-large-font);
  }

  .totals-row.paid {
    color: var(--smrt-color-tertiary);
  }

  .totals-row.paid .totals-label {
    color: var(--smrt-color-tertiary);
  }

  .totals-row.balance {
    padding-top: var(--smrt-spacing-2, 0.5rem);
    border-top: var(--smrt-hairline);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
}
</style>
