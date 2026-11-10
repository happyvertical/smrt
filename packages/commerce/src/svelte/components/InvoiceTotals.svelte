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

<div class="smrt-invoice-totals__root" class:smrt-invoice-totals__sm={size === 'sm'} class:smrt-invoice-totals__lg={size === 'lg'} data-smrt-component="InvoiceTotals">
  <div class="smrt-invoice-totals__row" data-smrt-part="row"><span class="smrt-invoice-totals__label" data-smrt-part="label">Subtotal</span><span class="smrt-invoice-totals__value" data-smrt-part="value">{formatInvoiceMinorUnits(retained.subtotalMinor, retained.currency)}</span></div>
  {#if retained.discountMinor !== undefined}<div class="smrt-invoice-totals__row" data-smrt-part="row"><span class="smrt-invoice-totals__label" data-smrt-part="label">Discount</span><span class="smrt-invoice-totals__value" data-smrt-part="value">{formatInvoiceMinorUnits(retained.discountMinor, retained.currency)}</span></div>{/if}
  {#each retained.taxes ?? [] as tax (tax.id)}<div class="smrt-invoice-totals__row" data-smrt-part="row"><span class="smrt-invoice-totals__label" data-smrt-part="label">{tax.label}</span><span class="smrt-invoice-totals__value" data-smrt-part="value">{formatInvoiceMinorUnits(tax.amountMinor, retained.currency)}</span></div>{/each}
  {#if retained.holdbackMinor !== undefined}<div class="smrt-invoice-totals__row" data-smrt-part="row"><span class="smrt-invoice-totals__label" data-smrt-part="label">{retained.holdbackLabel ?? 'Holdback'}</span><span class="smrt-invoice-totals__value" data-smrt-part="value">{formatInvoiceMinorUnits(retained.holdbackMinor, retained.currency)}</span></div>{/if}
  <div class="smrt-invoice-totals__row smrt-invoice-totals__total" data-smrt-part="row"><span class="smrt-invoice-totals__label" data-smrt-part="label">Total</span><span class="smrt-invoice-totals__value" data-smrt-part="value">{formatInvoiceMinorUnits(retained.totalMinor, retained.currency)}</span></div>
  {#if retained.paidMinor !== undefined}<div class="smrt-invoice-totals__row smrt-invoice-totals__paid" data-smrt-part="row"><span class="smrt-invoice-totals__label" data-smrt-part="label">{t(M['commerce.invoice_totals.amount_paid'])}</span><span class="smrt-invoice-totals__value" data-smrt-part="value">{formatInvoiceMinorUnits(retained.paidMinor, retained.currency)}</span></div>{/if}
  {#if retained.payableMinor !== undefined}<div class="smrt-invoice-totals__row smrt-invoice-totals__balance" data-smrt-part="row"><span class="smrt-invoice-totals__label" data-smrt-part="label">Payable</span><span class="smrt-invoice-totals__value" data-smrt-part="value">{formatInvoiceMinorUnits(retained.payableMinor, retained.currency)}</span></div>{/if}
  {@render details?.(retained)}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-invoice-totals__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
    width: 100%;
    max-width: 280px;
    margin-left: auto;
  }
  .smrt-invoice-totals__root.smrt-invoice-totals__sm {
    max-width: 220px;
    gap: var(--smrt-spacing-1_5, 0.375rem);
  }
  .smrt-invoice-totals__root.smrt-invoice-totals__lg {
    max-width: 320px;
    gap: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-invoice-totals__row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .smrt-invoice-totals__row.smrt-invoice-totals__total {
    padding-top: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-invoice-totals__row.smrt-invoice-totals__balance {
    padding-top: var(--smrt-spacing-2, 0.5rem);
  }
}

@layer smrt.theme {
  .smrt-invoice-totals__row {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface);
  }
  .smrt-invoice-totals__sm .smrt-invoice-totals__row {
    font: var(--smrt-typography-body-small-font);
  }
  .smrt-invoice-totals__lg .smrt-invoice-totals__row {
    font: var(--smrt-typography-body-large-font);
  }
  .smrt-invoice-totals__label {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-invoice-totals__value {
    font-variant-numeric: tabular-nums;
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-invoice-totals__row.smrt-invoice-totals__total {
    border-top: 2px solid var(--smrt-color-outline-variant);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-invoice-totals__row.smrt-invoice-totals__total .smrt-invoice-totals__label,
  .smrt-invoice-totals__row.smrt-invoice-totals__total .smrt-invoice-totals__value {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }
  .smrt-invoice-totals__lg .smrt-invoice-totals__row.smrt-invoice-totals__total .smrt-invoice-totals__label,
  .smrt-invoice-totals__lg .smrt-invoice-totals__row.smrt-invoice-totals__total .smrt-invoice-totals__value {
    font: var(--smrt-typography-title-large-font);
  }
  .smrt-invoice-totals__row.smrt-invoice-totals__paid {
    color: var(--smrt-color-tertiary);
  }
  .smrt-invoice-totals__row.smrt-invoice-totals__paid .smrt-invoice-totals__label {
    color: var(--smrt-color-tertiary);
  }
  .smrt-invoice-totals__row.smrt-invoice-totals__balance {
    border-top: var(--smrt-hairline);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
}

</style>
