<script lang="ts">
/**
 * InvoiceLineItems - Line items table for invoices/estimates
 *
 * Displays line items with optional inline editing capabilities.
 * Supports both read-only and editable modes.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { M } from '../i18n.js';
import {
  formatInvoiceMinorUnits,
  type RetainedInvoiceLineItemsView,
  type RetainedInvoiceLineView,
} from '../invoice-display.js';
import type { LineItem } from '../types.js';

const { t } = useI18n();

/** Props for InvoiceLineItems component */
export interface LegacyInvoiceLineItemsProps {
  /** Line items to display */
  items: LineItem[];
  /** Enable editing mode */
  editable?: boolean;
  /** Currency code */
  currency?: 'CAD' | 'USD';
  /** Called when item is updated */
  onupdate?: (id: string, item: Partial<LineItem>) => void;
  /** Called when item is deleted */
  ondelete?: (id: string) => void;
  /** Called when add button is clicked */
  onadd?: () => void;
  /** Show source type column */
  showSource?: boolean;
  /** Empty state message */
  emptyMessage?: string;
}

/** Exact retained line-items branch. */
export interface RetainedInvoiceLineItemsProps {
  /** Caller-authoritative retained line items and subtotal. */
  retained: RetainedInvoiceLineItemsView;
  /** Renders additional retained evidence for each line. */
  details?: Snippet<[RetainedInvoiceLineView]>;
  /** Empty state message. */
  emptyMessage?: string;
}

/** Legacy decimal-major items or exact retained items. */
export type Props = LegacyInvoiceLineItemsProps | RetainedInvoiceLineItemsProps;

const props: Props = $props();
const retained = $derived('retained' in props ? props.retained : null);
const details = $derived('details' in props ? props.details : undefined);
const legacy = $derived(
  retained ? null : (props as LegacyInvoiceLineItemsProps),
);
const items = $derived(legacy?.items ?? []);
const editable = $derived(legacy?.editable ?? false);
const currency = $derived(legacy?.currency ?? 'CAD');
const ondelete = $derived(legacy?.ondelete);
const onadd = $derived(legacy?.onadd);
const showSource = $derived(legacy?.showSource ?? false);
const emptyMessage = $derived(props.emptyMessage ?? 'No line items');

// This legacy branch receives decimal-major values from its historical API.
// Exact retained views above use integer minor units through formatInvoiceMinorUnits.
function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

// Source type labels
const sourceLabels: Record<string, string> = {
  expense: 'Expense',
  time: 'Time',
  manual: 'Manual',
};

// Calculate total
const total = $derived(items.reduce((sum, item) => sum + item.amount, 0));
</script>

<div class="smrt-invoice-line-items__root" data-smrt-component="InvoiceLineItems">
  {#if retained}
    {#if retained.lines.length === 0}
      <div class="smrt-invoice-line-items__empty" data-smrt-part="empty"><p>{emptyMessage}</p></div>
    {:else}
      <table class="smrt-invoice-line-items__table" data-smrt-part="list">
        <thead><tr><th class="smrt-invoice-line-items__cell-description" data-smrt-part="cell">Description</th><th class="smrt-invoice-line-items__cell-source" data-smrt-part="cell">Source</th><th class="smrt-invoice-line-items__cell-qty" data-smrt-part="cell">Qty</th><th class="smrt-invoice-line-items__cell-price" data-smrt-part="cell">{t(M['commerce.invoice_line_items.unit_price'])}</th><th class="smrt-invoice-line-items__cell-amount" data-smrt-part="cell">Amount</th></tr></thead>
        <tbody>
          {#each retained.lines as line (line.id)}
            <tr>
              <td class="smrt-invoice-line-items__cell-description" data-smrt-part="cell">
                {#if line.category}<span class="smrt-invoice-line-items__category" data-smrt-part="label">{line.category}</span>{/if}
                <span class="smrt-invoice-line-items__description" data-smrt-part="title">{line.description}</span>
                {#if line.discountLabel}<span>{line.discountLabel}</span>{/if}
                {#each line.taxLabels ?? [] as tax}<span>{tax}</span>{/each}
                {#if line.correctionLabel}<span>{line.correctionLabel}</span>{/if}
                {@render details?.(line)}
              </td>
              <td class="smrt-invoice-line-items__cell-source" data-smrt-part="cell">{line.sourceLabel ?? '—'}</td>
              <td class="smrt-invoice-line-items__cell-qty" data-smrt-part="cell">{line.quantity}</td>
              <td class="smrt-invoice-line-items__cell-price" data-smrt-part="cell">{line.unitPriceMinor === undefined || line.unitPriceMinor === null ? '—' : formatInvoiceMinorUnits(line.unitPriceMinor, retained.currency)}</td>
              <td class="smrt-invoice-line-items__cell-amount" data-smrt-part="cell">{formatInvoiceMinorUnits(line.amountMinor, retained.currency)}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot><tr class="smrt-invoice-line-items__total-row" data-smrt-part="row"><td colspan="4" class="smrt-invoice-line-items__total-label" data-smrt-part="label">Subtotal</td><td class="smrt-invoice-line-items__cell-amount" data-smrt-part="cell">{formatInvoiceMinorUnits(retained.subtotalMinor, retained.currency)}</td></tr></tfoot>
      </table>
    {/if}
  {:else if items.length === 0}
    <div class="smrt-invoice-line-items__empty" data-smrt-part="empty">
      <p>{emptyMessage}</p>
      {#if editable && onadd}
        <Button class="smrt-invoice-line-items__add" variant="ghost" onclick={onadd}>
          {t(M['commerce.invoice_line_items.add_item'])}
        </Button>
      {/if}
    </div>
  {:else}
    <table class="smrt-invoice-line-items__table" data-smrt-part="list">
      <thead>
        <tr>
          <th class="smrt-invoice-line-items__cell-description" data-smrt-part="cell">Description</th>
          {#if showSource}
            <th class="smrt-invoice-line-items__cell-source" data-smrt-part="cell">Source</th>
          {/if}
          <th class="smrt-invoice-line-items__cell-qty" data-smrt-part="cell">Qty</th>
          <th class="smrt-invoice-line-items__cell-price" data-smrt-part="cell">{t(M['commerce.invoice_line_items.unit_price'])}</th>
          <th class="smrt-invoice-line-items__cell-amount" data-smrt-part="cell">Amount</th>
          {#if editable}
            <th class="smrt-invoice-line-items__cell-actions" data-smrt-part="cell"></th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#each items as item (item.id)}
          <tr>
            <td class="smrt-invoice-line-items__cell-description" data-smrt-part="cell">
              {#if item.category}
                <span class="smrt-invoice-line-items__category" data-smrt-part="label">{item.category}</span>
              {/if}
              <span class="smrt-invoice-line-items__description" data-smrt-part="title">{item.description}</span>
            </td>
            {#if showSource}
              <td class="smrt-invoice-line-items__cell-source" data-smrt-part="cell">
                <span class="smrt-invoice-line-items__badge smrt-invoice-line-items__source-{item.sourceType ?? 'manual'}" data-smrt-part="badge">
                  {sourceLabels[item.sourceType ?? 'manual']}
                </span>
              </td>
            {/if}
            <td class="smrt-invoice-line-items__cell-qty" data-smrt-part="cell">{item.quantity}</td>
            <td class="smrt-invoice-line-items__cell-price" data-smrt-part="cell">{formatMoney(item.unitPrice)}</td>
            <td class="smrt-invoice-line-items__cell-amount" data-smrt-part="cell">{formatMoney(item.amount)}</td>
            {#if editable}
              <td class="smrt-invoice-line-items__cell-actions" data-smrt-part="cell">
                <Button
                  variant="ghost"
                  class="smrt-invoice-line-items__delete"
                  title={t(M['commerce.invoice_line_items.remove_item'])}
                  onclick={() => ondelete?.(item.id)}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 4l8 8M4 12l8-8" />
                  </svg>
                </Button>
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
      <tfoot>
        <tr class="smrt-invoice-line-items__total-row" data-smrt-part="row">
          <td colspan={showSource ? 4 : 3} class="smrt-invoice-line-items__total-label" data-smrt-part="label">{t(M['commerce.invoice_line_items.line_total'])}</td>
          <td class="smrt-invoice-line-items__cell-amount" data-smrt-part="cell">{formatMoney(total)}</td>
          {#if editable}
            <td></td>
          {/if}
        </tr>
      </tfoot>
    </table>

    {#if editable && onadd}
      <Button class="smrt-invoice-line-items__add" variant="ghost" onclick={onadd}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M8 3v10M3 8h10" />
        </svg>
        {t(M['commerce.invoice_line_items.add_item'])}
      </Button>
    {/if}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-invoice-line-items__root {
    width: 100%;
  }
  .smrt-invoice-line-items__empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--smrt-spacing-8, 2rem) var(--smrt-spacing-4, 1rem);
  }
  .smrt-invoice-line-items__empty p {
    margin: 0 0 var(--smrt-spacing-4, 1rem);
  }
  .smrt-invoice-line-items__table {
    width: 100%;
  }
  .smrt-invoice-line-items__table th {
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-invoice-line-items__table td {
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-invoice-line-items__cell-description {
    width: 50%;
  }
  .smrt-invoice-line-items__cell-source {
    width: 80px;
  }
  .smrt-invoice-line-items__cell-qty {
    width: 60px;
  }
  .smrt-invoice-line-items__cell-price,
  .smrt-invoice-line-items__cell-amount {
    width: 100px;
  }
  .smrt-invoice-line-items__cell-actions {
    width: 40px;
  }
  .smrt-invoice-line-items__category {
    display: block;
  }
  .smrt-invoice-line-items__badge {
    display: inline-block;
    padding: var(--smrt-spacing-0_5, 0.125rem) var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-invoice-line-items__total-row td {
    padding-top: var(--smrt-spacing-4, 1rem);
  }
  /*
  * These rules style the <button> rendered *inside* the smrt-ui <Button>
  * child component (issue #1589). A plain scoped `.smrt-invoice-line-items__root
  * [data-smrt-component="Button"] {}` rule would not reach it (no parent scope
  * hash), so each is written as `.smrt-invoice-line-items__root
  * :global([data-smrt-component="Button"])` — Svelte compiles the ancestor to
  * `.smrt-invoice-line-items__root.svelte-HASH [data-smrt-component="Button"]`,
  * which pierces into the child. Each rule anchors on the container that owns
  * the button so the delete and add actions stay distinct.
  * Overrides cover sizing/shape/color; the ghost variant owns the base.
  */
  .smrt-invoice-line-items__cell-actions :global([data-smrt-component="Button"]) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
  }
  .smrt-invoice-line-items__root :global(.smrt-invoice-line-items__add) {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-4, 1rem);
  }
  .smrt-invoice-line-items__root > :global([data-smrt-component="Button"]) {
    margin-top: var(--smrt-spacing-3, 0.75rem);
  }
}

@layer smrt.theme {
  .smrt-invoice-line-items__empty {
    background: var(--smrt-color-surface-container-low);
    border: 1px dashed var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    text-align: center;
  }
  .smrt-invoice-line-items__empty p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-invoice-line-items__table {
    border-collapse: collapse;
    font: var(--smrt-typography-body-medium-font);
  }
  .smrt-invoice-line-items__table th {
    text-align: left;
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant);
    border-bottom: var(--smrt-hairline);
  }
  .smrt-invoice-line-items__table td {
    border-bottom: 1px solid var(--smrt-color-surface-variant);
    vertical-align: top;
  }
  .smrt-invoice-line-items__cell-qty {
    text-align: right;
  }
  .smrt-invoice-line-items__cell-price,
  .smrt-invoice-line-items__cell-amount {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .smrt-invoice-line-items__cell-actions {
    text-align: center;
  }
  .smrt-invoice-line-items__category {
    font: var(--smrt-typography-label-small-font);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }
  .smrt-invoice-line-items__description {
    color: var(--smrt-color-on-surface);
  }
  .smrt-invoice-line-items__badge {
    font: var(--smrt-typography-label-small-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-invoice-line-items__source-expense {
    background: var(--smrt-color-tertiary-container);
    color: var(--smrt-color-on-tertiary-container);
  }
  .smrt-invoice-line-items__source-time {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-invoice-line-items__source-manual {
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-invoice-line-items__total-row td {
    border-top: 2px solid var(--smrt-color-outline-variant);
    border-bottom: none;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-invoice-line-items__total-label {
    text-align: right;
    color: var(--smrt-color-on-surface);
  }
  /*
  * These rules style the <button> rendered *inside* the smrt-ui <Button>
  * child component (issue #1589). A plain scoped `.smrt-invoice-line-items__root
  * [data-smrt-component="Button"] {}` rule would not reach it (no parent scope
  * hash), so each is written as `.smrt-invoice-line-items__root
  * :global([data-smrt-component="Button"])` — Svelte compiles the ancestor to
  * `.smrt-invoice-line-items__root.svelte-HASH [data-smrt-component="Button"]`,
  * which pierces into the child. Each rule anchors on the container that owns
  * the button so the delete and add actions stay distinct.
  * Overrides cover sizing/shape/color; the ghost variant owns the base.
  */
  .smrt-invoice-line-items__cell-actions :global([data-smrt-component="Button"]) {
    background: transparent;
    border: none;
    border-radius: var(--smrt-radius-extra-small, 0.25rem);
    color: var(--smrt-color-on-surface-variant);
    transition: all var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-invoice-line-items__cell-actions :global([data-smrt-component="Button"]) {
      transition: none;
    }
  }
  .smrt-invoice-line-items__cell-actions :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface);
  }
  .smrt-invoice-line-items__cell-actions :global([data-smrt-component="Button"].smrt-invoice-line-items__delete:hover) {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-error);
  }
  .smrt-invoice-line-items__root :global(.smrt-invoice-line-items__add) {
    font: var(--smrt-typography-label-large-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-primary);
    background: transparent;
    border: 1px dashed var(--smrt-color-primary);
    border-radius: var(--smrt-radius-small, 0.375rem);
    transition: all var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-invoice-line-items__root :global(.smrt-invoice-line-items__add) {
      transition: none;
    }
  }
  .smrt-invoice-line-items__root :global(.smrt-invoice-line-items__add:hover) {
    background: var(--smrt-color-primary-container);
  }
}

</style>
