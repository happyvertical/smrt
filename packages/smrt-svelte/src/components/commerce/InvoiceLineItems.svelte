<script lang="ts">
/**
 * InvoiceLineItems - Line items table for invoices/estimates
 *
 * Displays line items with optional inline editing capabilities.
 * Supports both read-only and editable modes.
 */

import type { Snippet } from 'svelte';

export interface LineItem {
  /** Unique identifier */
  id: string;
  /** Item description */
  description: string;
  /** Quantity */
  quantity: number;
  /** Unit price in cents */
  unitPrice: number;
  /** Total amount in cents (quantity * unitPrice) */
  amount: number;
  /** Optional category */
  category?: string;
  /** Source type (expense, time, manual) */
  sourceType?: 'expense' | 'time' | 'manual';
}

interface Props {
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

// Format cents to dollars
function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
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
        <button type="button" class="add-btn" onclick={onadd}>
          Add Item
        </button>
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
          <th class="col-price">Unit Price</th>
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
                <button
                  type="button"
                  class="action-btn delete"
                  title="Remove item"
                  onclick={() => ondelete?.(item.id)}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 4l8 8M4 12l8-8" />
                  </svg>
                </button>
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
      <button type="button" class="add-btn add-btn-below" onclick={onadd}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M8 3v10M3 8h10" />
        </svg>
        Add Item
      </button>
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
    padding: 2rem 1rem;
    background: #f9fafb;
    border: 1px dashed #d1d5db;
    border-radius: 0.5rem;
    text-align: center;
  }

  .empty-state p {
    color: #6b7280;
    margin: 0 0 1rem;
  }

  .line-items-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  .line-items-table th {
    text-align: left;
    font-weight: 500;
    color: #6b7280;
    padding: 0.75rem 0.5rem;
    border-bottom: 1px solid #e5e7eb;
  }

  .line-items-table td {
    padding: 0.75rem 0.5rem;
    border-bottom: 1px solid #f3f4f6;
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
    font-size: 0.75rem;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .item-description {
    color: #111827;
  }

  .source-badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 500;
    border-radius: 9999px;
  }

  .source-expense {
    background: #dcfce7;
    color: #166534;
  }

  .source-time {
    background: #dbeafe;
    color: #1e40af;
  }

  .source-manual {
    background: #f3f4f6;
    color: #6b7280;
  }

  .total-row td {
    border-top: 2px solid #e5e7eb;
    border-bottom: none;
    font-weight: 600;
    padding-top: 1rem;
  }

  .total-label {
    text-align: right;
    color: #374151;
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
    color: #9ca3af;
    transition: all 0.15s;
  }

  .action-btn:hover {
    background: #f3f4f6;
    color: #374151;
  }

  .action-btn.delete:hover {
    background: #fee2e2;
    color: #dc2626;
  }

  .add-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #3b82f6;
    background: transparent;
    border: 1px dashed #3b82f6;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .add-btn:hover {
    background: #eff6ff;
  }

  .add-btn-below {
    margin-top: 0.75rem;
  }
</style>
