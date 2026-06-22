<script lang="ts">
/**
 * UnbilledItems - Selectable list of unbilled expenses/time
 *
 * Shows unbilled items with checkbox selection for invoice creation.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import type { UnbilledItem } from '../types.js';

const { t } = useI18n();

/** Props for UnbilledItems component */
export interface Props {
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
        <span>{t(M['commerce.unbilled_items.select_all'])}</span>
      </label>
      <span class="selected-count">
        {t(M['commerce.unbilled_items.selected_count'], { selected: selectedIds.size, total: items.length })}
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
          <span class="summary-label">{t(M['commerce.unbilled_items.selected_total'])}</span>
          <span class="summary-value">{formatMoney(selectedTotal)}</span>
        </div>
        {#if oncreate}
          <button
            type="button"
            class="create-btn"
            onclick={() => oncreate?.([...selectedIds])}
          >
            {t(M['commerce.unbilled_items.create_invoice'])}
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
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    overflow: hidden;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-8, 2rem) var(--smrt-spacing-4, 1rem);
    color: var(--smrt-color-on-surface-variant, #49454f);
  }

  .empty-state p {
    margin: 0;
  }

  .items-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
    background: var(--smrt-color-surface-container-low, #f7f2fa);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .select-all {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    font: var(--smrt-typography-body-medium-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #1c1b1f);
    cursor: pointer;
  }

  .selected-count {
    font: var(--smrt-typography-label-small-font);
    color: var(--smrt-color-on-surface-variant, #49454f);
  }

  .items-list {
    display: flex;
    flex-direction: column;
    max-height: 400px;
    overflow-y: auto;
    background: var(--smrt-color-surface, #ffffff);
  }

  .item-row {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
    border-bottom: 1px solid var(--smrt-color-surface-variant, #e7e0ec);
    cursor: pointer;
    transition: background var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }

  @media (prefers-reduced-motion: reduce) {
    .item-row {
      transition: none;
    }
  }

  .item-row:hover {
    background: var(--smrt-color-surface-container-low, #f7f2fa);
  }

  .item-row.selected {
    background: var(--smrt-color-primary-container, #d3e3fd);
  }

  .item-row:last-child {
    border-bottom: none;
  }

  .item-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
    min-width: 0;
  }

  .item-main {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .item-type {
    display: inline-flex;
    padding: var(--smrt-spacing-0_5, 0.125rem) var(--smrt-spacing-2, 0.5rem);
    font: var(--smrt-typography-label-small-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    text-transform: uppercase;
    letter-spacing: 0.025em;
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .type-expense {
    background: var(--smrt-color-tertiary-container, #ddf5e5);
    color: var(--smrt-color-on-tertiary-container, #0c1f15);
  }

  .type-time {
    background: var(--smrt-color-primary-container, #d3e3fd);
    color: var(--smrt-color-on-primary-container, #041e49);
  }

  .item-description {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface, #1c1b1f);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-meta {
    display: flex;
    gap: var(--smrt-spacing-3, 0.75rem);
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant, #49454f);
  }

  .item-category {
    color: var(--smrt-color-on-surface-variant, #49454f);
  }

  .item-amount {
    font: var(--smrt-typography-body-medium-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #1c1b1f);
    font-variant-numeric: tabular-nums;
  }

  .items-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--smrt-spacing-4, 1rem);
    background: var(--smrt-color-surface-container-low, #f7f2fa);
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .selected-summary {
    display: flex;
    align-items: baseline;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .summary-label {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface-variant, #49454f);
  }

  .summary-value {
    font: var(--smrt-typography-title-large-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface, #1c1b1f);
  }

  .create-btn {
    display: inline-flex;
    align-items: center;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-4, 1rem);
    font: var(--smrt-typography-label-large-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-primary, #ffffff);
    background: var(--smrt-color-primary, #005ac1);
    border: none;
    border-radius: var(--smrt-radius-small, 0.375rem);
    cursor: pointer;
    transition: background var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }

  @media (prefers-reduced-motion: reduce) {
    .create-btn {
      transition: none;
    }
  }

  .create-btn:hover {
    background: color-mix(in srgb, var(--smrt-color-primary, #005ac1) 85%, var(--smrt-color-shadow, #000));
  }
</style>
