<script lang="ts">
/**
 * FilterChips - Horizontal filter navigation
 *
 * Provides a row of selectable filter chips for filtering lists.
 * Supports optional counts and "all" option.
 */

import type { FilterOption } from './types.js';

interface Props {
  /** Available filter options */
  options: FilterOption[];
  /** Currently selected value */
  selected: string;
  /** Called when selection changes */
  onchange?: (value: string) => void;
  /** Size variant */
  size?: 'sm' | 'md';
  /** Show "All" option */
  showAll?: boolean;
  /** All option label */
  allLabel?: string;
}

const {
  options,
  selected,
  onchange,
  size = 'md',
  showAll = false,
  allLabel = 'All',
}: Props = $props();

// Build full options list with optional "all"
const allOptions = $derived.by(() => {
  if (!showAll) return options;

  const totalCount = options.reduce((sum, opt) => sum + (opt.count ?? 0), 0);
  const allOption: FilterOption = {
    value: '',
    label: allLabel,
    count: totalCount > 0 ? totalCount : undefined,
  };
  return [allOption, ...options];
});

function handleClick(value: string) {
  if (value !== selected) {
    onchange?.(value);
  }
}
</script>

<div class="filter-chips" class:sm={size === 'sm'} role="radiogroup">
  {#each allOptions as option (option.value)}
    <button
      type="button"
      class="filter-chip"
      class:active={option.value === selected}
      disabled={option.disabled}
      role="radio"
      aria-checked={option.value === selected}
      onclick={() => handleClick(option.value)}
    >
      <span class="chip-label">{option.label}</span>
      {#if option.count !== undefined}
        <span class="chip-count">{option.count}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .filter-chips {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #6b7280;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 9999px;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .sm .filter-chip {
    padding: 0.375rem 0.75rem;
    font-size: 0.75rem;
  }

  .filter-chip:hover:not(:disabled) {
    border-color: #3b82f6;
    color: #3b82f6;
  }

  .filter-chip.active {
    background: #3b82f6;
    border-color: #3b82f6;
    color: white;
  }

  .filter-chip:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .chip-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    font-size: 0.75rem;
    font-weight: 500;
    background: #e5e7eb;
    color: #374151;
    border-radius: 9999px;
  }

  .filter-chip.active .chip-count {
    background: rgba(255, 255, 255, 0.2);
    color: white;
  }
</style>
