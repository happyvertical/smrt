<script lang="ts">
/**
 * FilterChips - Horizontal filter navigation
 * refactored for Material 3
 *
 * Provides a row of selectable filter chips for filtering lists.
 * Supports optional counts and "all" option.
 */
import { ripple } from '../../actions/ripple.js';
import { Icon } from '../display/index.js';
import type { FilterOption } from './types.js';

export interface Props {
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
    {@const isActive = option.value === selected}
    <button
      type="button"
      class="filter-chip"
      class:active={isActive}
      disabled={option.disabled}
      role="radio"
      aria-checked={isActive}
      onclick={() => handleClick(option.value)}
      use:ripple
    >
      {#if isActive}
        <span class="chip-icon">
          <Icon name="check" size={18} />
        </span>
      {/if}
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
    gap: 8px;
    flex-wrap: wrap;
  }

  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 16px;
    font: var(--smrt-typography-label-large-font);
    font-weight: 500;
    color: var(--smrt-color-on-surface-variant);
    background-color: transparent;
    border: 1px solid var(--smrt-color-outline);
    border-radius: 8px;
    cursor: pointer;
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    white-space: nowrap;
    position: relative;
    overflow: hidden;
  }

  .sm .filter-chip {
    height: 28px;
    padding: 0 12px;
    font: var(--smrt-typography-label-medium-font);
    gap: 6px;
  }

  .filter-chip:hover:not(:disabled) {
    background-color: var(--smrt-color-surface-container-high);
  }

  .filter-chip.active {
    background-color: var(--smrt-color-secondary-container);
    border-color: transparent;
    color: var(--smrt-color-on-secondary-container);
    padding-left: 12px;
  }

  .sm .filter-chip.active {
    padding-left: 8px;
  }

  .filter-chip:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }

  .chip-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--smrt-color-on-secondary-container);
  }

  .chip-count {
    font: var(--smrt-typography-label-small-font);
    opacity: 0.7;
    margin-left: -2px;
  }

  .active .chip-count {
    color: var(--smrt-color-on-secondary-container);
  }
</style>