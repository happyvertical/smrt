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
import type { LineItem } from '../types.js';

const { t } = useI18n();

/** Props for InvoiceLineItems component */
export interface Props {
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

const {
  items,
  editable = false,
  currency = 'CAD',
  onupdate,
  ondelete,
  onadd,
  showSource = false,
  emptyMessage = 'No line items',
}: Props = $props();

// Format decimal-dollar amounts. The commerce models store DECIMAL dollars
// (AGENTS.md "Currency in decimal fields"), not integer cents.
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

<div class="line-items-container">
  {#if items.length === 0}
    <div class="empty-state">
      <p>{emptyMessage}</p>
      {#if editable && onadd}
        <Button variant="ghost" class="add-btn" onclick={onadd}>
          {t(M['commerce.invoice_line_items.add_item'])}
        </Button>
      {/if}
    </div>
  {:else}
    <table class="line-items-table">
      <thead>
        <tr>
          <th class="col-description">Description</th>
          {#if showSource}
            <th class="col-source">Source</th>
          {/if}
          <th class="col-qty">Qty</th>
          <th class="col-price">{t(M['commerce.invoice_line_items.unit_price'])}</th>
          <th class="col-amount">Amount</th>
          {#if editable}
            <th class="col-actions"></th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#each items as item (item.id)}
          <tr>
            <td class="col-description">
              {#if item.category}
                <span class="item-category">{item.category}</span>
              {/if}
              <span class="item-description">{item.description}</span>
            </td>
            {#if showSource}
              <td class="col-source">
                <span class="source-badge source-{item.sourceType ?? 'manual'}">
                  {sourceLabels[item.sourceType ?? 'manual']}
                </span>
              </td>
            {/if}
            <td class="col-qty">{item.quantity}</td>
            <td class="col-price">{formatMoney(item.unitPrice)}</td>
            <td class="col-amount">{formatMoney(item.amount)}</td>
            {#if editable}
              <td class="col-actions">
                <Button
                  variant="ghost"
                  class="action-btn delete"
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
        <tr class="total-row">
          <td colspan={showSource ? 4 : 3} class="total-label">Subtotal</td>
          <td class="col-amount">{formatMoney(total)}</td>
          {#if editable}
            <td></td>
          {/if}
        </tr>
      </tfoot>
    </table>

    {#if editable && onadd}
      <Button variant="ghost" class="add-btn add-btn-below" onclick={onadd}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M8 3v10M3 8h10" />
        </svg>
        {t(M['commerce.invoice_line_items.add_item'])}
      </Button>
    {/if}
  {/if}
</div>

<style>
  .line-items-container {
    width: 100%;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--smrt-spacing-8, 2rem) var(--smrt-spacing-4, 1rem);
    background: var(--smrt-color-surface-container-low, #f7f2fa);
    border: 1px dashed var(--smrt-color-outline, #79747e);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    text-align: center;
  }

  .empty-state p {
    color: var(--smrt-color-on-surface-variant, #49454f);
    margin: 0 0 var(--smrt-spacing-4, 1rem);
  }

  .line-items-table {
    width: 100%;
    border-collapse: collapse;
    font: var(--smrt-typography-body-medium-font);
  }

  .line-items-table th {
    text-align: left;
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant, #49454f);
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-2, 0.5rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .line-items-table td {
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-2, 0.5rem);
    border-bottom: 1px solid var(--smrt-color-surface-variant, #e7e0ec);
    vertical-align: top;
  }

  .col-description {
    width: 50%;
  }

  .col-source {
    width: 80px;
  }

  .col-qty {
    width: 60px;
    text-align: right;
  }

  .col-price,
  .col-amount {
    width: 100px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .col-actions {
    width: 40px;
    text-align: center;
  }

  .item-category {
    display: block;
    font: var(--smrt-typography-label-small-font);
    color: var(--smrt-color-on-surface-variant, #49454f);
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .item-description {
    color: var(--smrt-color-on-surface, #1c1b1f);
  }

  .source-badge {
    display: inline-block;
    padding: var(--smrt-spacing-0_5, 0.125rem) var(--smrt-spacing-2, 0.5rem);
    font: var(--smrt-typography-label-small-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .source-expense {
    background: var(--smrt-color-tertiary-container, #ddf5e5);
    color: var(--smrt-color-on-tertiary-container, #0c1f15);
  }

  .source-time {
    background: var(--smrt-color-primary-container, #d3e3fd);
    color: var(--smrt-color-on-primary-container, #041e49);
  }

  .source-manual {
    background: var(--smrt-color-surface-variant, #e7e0ec);
    color: var(--smrt-color-on-surface-variant, #49454f);
  }

  .total-row td {
    border-top: 2px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-bottom: none;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    padding-top: var(--smrt-spacing-4, 1rem);
  }

  .total-label {
    text-align: right;
    color: var(--smrt-color-on-surface, #1c1b1f);
  }

  /*
   * These rules style the <button> rendered *inside* the smrt-ui <Button>
   * child component (issue #1589). A plain scoped `.action-btn {}` rule would
   * not reach it (no parent scope hash), so each is written as
   * `.line-items-container :global(.class)` — Svelte compiles the ancestor to
   * `.line-items-container.svelte-HASH .class`, which pierces into the child.
   * Overrides cover sizing/shape/color; the ghost variant owns the base.
   */
  .line-items-container :global(.action-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: var(--smrt-radius-extra-small, 0.25rem);
    color: var(--smrt-color-on-surface-variant, #49454f);
    transition: all var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }

  @media (prefers-reduced-motion: reduce) {
    .line-items-container :global(.action-btn) {
      transition: none;
    }
  }

  .line-items-container :global(.action-btn:hover) {
    background: var(--smrt-color-surface-variant, #e7e0ec);
    color: var(--smrt-color-on-surface, #1c1b1f);
  }

  .line-items-container :global(.action-btn.delete:hover) {
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-error, #ba1a1a);
  }

  .line-items-container :global(.add-btn) {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-4, 1rem);
    font: var(--smrt-typography-label-large-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-primary, #005ac1);
    background: transparent;
    border: 1px dashed var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-small, 0.375rem);
    transition: all var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }

  @media (prefers-reduced-motion: reduce) {
    .line-items-container :global(.add-btn) {
      transition: none;
    }
  }

  .line-items-container :global(.add-btn:hover) {
    background: var(--smrt-color-primary-container, #d3e3fd);
  }

  .line-items-container :global(.add-btn-below) {
    margin-top: var(--smrt-spacing-3, 0.75rem);
  }
</style>
