<script lang="ts">
/**
 * UnbilledItems - Selectable list of unbilled expenses/time
 *
 * Shows unbilled items with checkbox selection for invoice creation.
 */

import type { UnbilledItem } from './types.js';

interface Props {
  /** Unbilled items */
  items: UnbilledItem[];
  /** Currency code */
  currency?: 'CAD' | 'USD';
  /** Called when selection changes */
  onselectionchange?: (selectedIds: string[]) => void;
  /** Called when create invoice is clicked */
  oncreate?: (selectedIds: string[]) => void;
  /** Empty state message */
  emptyMessage?: string;
}

let {
  items = $bindable([]),
  currency = 'CAD',
  onselectionchange,
  oncreate,
  emptyMessage = 'No unbilled items',
}: Props = $props();

// Track selection state
let selectedIds = $state<Set<string>>(
  new Set(items.filter((i) => i.selected).map((i) => i.id)),
);

// Update parent when selection changes
$effect(() => {
  onselectionchange?.([...selectedIds]);
});

// Format money
function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

// Format date
function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
  }).format(d);
}

// Toggle item selection
function toggleItem(id: string) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  selectedIds = new Set(selectedIds); // Trigger reactivity
}

// Toggle all items
function toggleAll() {
  if (selectedIds.size === items.length) {
    selectedIds = new Set();
  } else {
    selectedIds = new Set(items.map((i) => i.id));
  }
}

// Calculate selected total
const selectedTotal = $derived(
  items
    .filter((i) => selectedIds.has(i.id))
    .reduce((sum, i) => sum + i.amount, 0),
);

// All selected
const allSelected = $derived(
  selectedIds.size === items.length && items.length > 0,
);
const someSelected = $derived(
  selectedIds.size > 0 && selectedIds.size < items.length,
);
</script>

<div class="unbilled-items">
  {#if items.length === 0}
    <div class="empty-state">
      <p>{emptyMessage}</p>
    </div>
  {:else}
    <div class="items-header">
      <label class="select-all">
        <input
          type="checkbox"
          checked={allSelected}
          indeterminate={someSelected}
          onchange={toggleAll}
        />
        <span>Select All</span>
      </label>
      <span class="selected-count">
        {selectedIds.size} of {items.length} selected
      </span>
    </div>

    <div class="items-list">
      {#each items as item (item.id)}
        <label class="item-row" class:selected={selectedIds.has(item.id)}>
          <input
            type="checkbox"
            checked={selectedIds.has(item.id)}
            onchange={() => toggleItem(item.id)}
          />
          <div class="item-content">
            <div class="item-main">
              <span class="item-type type-{item.type}">{item.type}</span>
              <span class="item-description">{item.description}</span>
            </div>
            <div class="item-meta">
              {#if item.category}
                <span class="item-category">{item.category}</span>
              {/if}
              <span class="item-date">{formatDate(item.date)}</span>
            </div>
          </div>
          <span class="item-amount">{formatMoney(item.amount)}</span>
        </label>
      {/each}
    </div>

    {#if selectedIds.size > 0}
      <div class="items-footer">
        <div class="selected-summary">
          <span class="summary-label">Selected Total:</span>
          <span class="summary-value">{formatMoney(selectedTotal)}</span>
        </div>
        {#if oncreate}
          <button
            type="button"
            class="create-btn"
            onclick={() => oncreate?.([...selectedIds])}
          >
            Create Invoice
          </button>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .unbilled-items {
    display: flex;
    flex-direction: column;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    overflow: hidden;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    color: #6b7280;
  }

  .empty-state p {
    margin: 0;
  }

  .items-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
  }

  .select-all {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
    cursor: pointer;
  }

  .selected-count {
    font-size: 0.75rem;
    color: #6b7280;
  }

  .items-list {
    display: flex;
    flex-direction: column;
    max-height: 400px;
    overflow-y: auto;
  }

  .item-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #f3f4f6;
    cursor: pointer;
    transition: background 0.1s;
  }

  .item-row:hover {
    background: #f9fafb;
  }

  .item-row.selected {
    background: #eff6ff;
  }

  .item-row:last-child {
    border-bottom: none;
  }

  .item-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .item-main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .item-type {
    display: inline-flex;
    padding: 0.125rem 0.5rem;
    font-size: 0.625rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    border-radius: 9999px;
  }

  .type-expense {
    background: #dcfce7;
    color: #166534;
  }

  .type-time {
    background: #dbeafe;
    color: #1e40af;
  }

  .item-description {
    font-size: 0.875rem;
    color: #111827;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-meta {
    display: flex;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: #6b7280;
  }

  .item-category {
    color: #9ca3af;
  }

  .item-amount {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
    font-variant-numeric: tabular-nums;
  }

  .items-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    background: #f9fafb;
    border-top: 1px solid #e5e7eb;
  }

  .selected-summary {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .summary-label {
    font-size: 0.875rem;
    color: #6b7280;
  }

  .summary-value {
    font-size: 1.125rem;
    font-weight: 600;
    color: #111827;
  }

  .create-btn {
    display: inline-flex;
    align-items: center;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: white;
    background: #3b82f6;
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: background 0.15s;
  }

  .create-btn:hover {
    background: #2563eb;
  }
</style>
