<script lang="ts">
/**
 * UnbilledItems - Selectable list of unbilled expenses/time
 *
 * Shows unbilled items with checkbox selection for invoice creation.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
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

// Format money. Amounts are decimal dollars (the commerce models store DECIMAL
// dollars — AGENTS.md "Currency in decimal fields"), not integer cents.
function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
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

<div class="smrt-unbilled-items__root" data-smrt-component="UnbilledItems">
  {#if items.length === 0}
    <div class="smrt-unbilled-items__empty" data-smrt-part="empty">
      <p>{emptyMessage}</p>
    </div>
  {:else}
    <div class="smrt-unbilled-items__header" data-smrt-part="header">
      <label class="smrt-unbilled-items__select-all" data-smrt-part="control">
        <!-- raw-primitive-allow: tri-state select-all checkbox needs the indeterminate flag for the some-but-not-all state; neither CheckboxInput nor Toggle exposes indeterminate, and a use action cannot be applied to a component -->
        <input
          type="checkbox"
          checked={allSelected}
          indeterminate={someSelected}
          onchange={toggleAll}
        />
        <span>{t(M['commerce.unbilled_items.select_all'])}</span>
      </label>
      <span class="smrt-unbilled-items__count" data-smrt-part="count">
        {t(M['commerce.unbilled_items.selected_count'], { selected: selectedIds.size, total: items.length })}
      </span>
    </div>

    <div class="smrt-unbilled-items__list" data-smrt-part="list">
      {#each items as item (item.id)}
        <label class="smrt-unbilled-items__item" data-smrt-part="item" class:smrt-unbilled-items__selected={selectedIds.has(item.id)}>
          <!-- raw-primitive-allow: native checkbox kept for visual + behavioral consistency with the indeterminate select-all checkbox above (which must stay native); the only checkbox primitive, CheckboxInput, also requires a smrt-svelte Provider in context, which this standalone presentational component does not assume -->
          <input
            type="checkbox"
            checked={selectedIds.has(item.id)}
            onchange={() => toggleItem(item.id)}
          />
          <div class="smrt-unbilled-items__content" data-smrt-part="body">
            <div class="smrt-unbilled-items__main" data-smrt-part="row">
              <span class="smrt-unbilled-items__type smrt-unbilled-items__type-{item.type}" data-smrt-part="badge">{item.type}</span>
              <span class="smrt-unbilled-items__description" data-smrt-part="title">{item.description}</span>
            </div>
            <div class="smrt-unbilled-items__meta" data-smrt-part="meta">
              {#if item.category}
                <span class="smrt-unbilled-items__category" data-smrt-part="label">{item.category}</span>
              {/if}
              <span class="smrt-unbilled-items__date" data-smrt-part="meta">{formatDate(item.date)}</span>
            </div>
          </div>
          <span class="smrt-unbilled-items__amount" data-smrt-part="value">{formatMoney(item.amount)}</span>
        </label>
      {/each}
    </div>

    {#if selectedIds.size > 0}
      <div class="smrt-unbilled-items__footer" data-smrt-part="footer">
        <div class="smrt-unbilled-items__summary" data-smrt-part="summary">
          <span class="smrt-unbilled-items__summary-label" data-smrt-part="label">{t(M['commerce.unbilled_items.selected_total'])}</span>
          <span class="smrt-unbilled-items__summary-value" data-smrt-part="value">{formatMoney(selectedTotal)}</span>
        </div>
        {#if oncreate}
          <Button
            variant="primary"
            onclick={() => oncreate?.([...selectedIds])}
          >
            {t(M['commerce.unbilled_items.create_invoice'])}
          </Button>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-unbilled-items__root {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .smrt-unbilled-items__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-8, 2rem) var(--smrt-spacing-4, 1rem);
  }
  .smrt-unbilled-items__empty p {
    margin: 0;
  }
  .smrt-unbilled-items__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
  }
  .smrt-unbilled-items__select-all {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    cursor: pointer;
  }
  .smrt-unbilled-items__list {
    display: flex;
    flex-direction: column;
    max-height: 400px;
    overflow-y: auto;
  }
  .smrt-unbilled-items__item {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
    cursor: pointer;
  }
  .smrt-unbilled-items__content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
    min-width: 0;
  }
  .smrt-unbilled-items__main {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-unbilled-items__type {
    display: inline-flex;
    padding: var(--smrt-spacing-0_5, 0.125rem) var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-unbilled-items__description {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-unbilled-items__meta {
    display: flex;
    gap: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-unbilled-items__footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--smrt-spacing-4, 1rem);
  }
  .smrt-unbilled-items__summary {
    display: flex;
    align-items: baseline;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
}

@layer smrt.theme {
  .smrt-unbilled-items__root {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }
  .smrt-unbilled-items__empty {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-unbilled-items__header {
    background: var(--smrt-color-surface-container-low);
    border-bottom: var(--smrt-hairline);
  }
  .smrt-unbilled-items__select-all {
    font: var(--smrt-typography-body-medium-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-unbilled-items__count {
    font: var(--smrt-typography-label-small-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-unbilled-items__list {
    background: var(--smrt-color-surface);
  }
  .smrt-unbilled-items__item {
    border-bottom: 1px solid var(--smrt-color-surface-variant);
    transition: background var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-unbilled-items__item {
      transition: none;
    }
  }
  .smrt-unbilled-items__item:hover {
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-unbilled-items__item.smrt-unbilled-items__selected {
    background: var(--smrt-color-primary-container);
  }
  .smrt-unbilled-items__item:last-child {
    border-bottom: none;
  }
  .smrt-unbilled-items__type {
    font: var(--smrt-typography-label-small-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    text-transform: uppercase;
    letter-spacing: 0.025em;
    border-radius: var(--smrt-radius-full);
  }
  .smrt-unbilled-items__type-expense {
    background: var(--smrt-color-tertiary-container);
    color: var(--smrt-color-on-tertiary-container);
  }
  .smrt-unbilled-items__type-time {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-unbilled-items__description {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface);
  }
  .smrt-unbilled-items__meta {
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-unbilled-items__category {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-unbilled-items__amount {
    font: var(--smrt-typography-body-medium-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
    font-variant-numeric: tabular-nums;
  }
  .smrt-unbilled-items__footer {
    background: var(--smrt-color-surface-container-low);
    border-top: var(--smrt-hairline);
  }
  .smrt-unbilled-items__summary-label {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-unbilled-items__summary-value {
    font: var(--smrt-typography-title-large-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
  }
}

</style>
