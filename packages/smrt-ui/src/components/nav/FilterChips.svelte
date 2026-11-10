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
  /** Target density; omit to inherit the ThemeProvider setting. */
  density?: 'comfortable' | 'touch';
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
  density,
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

<div data-density={density} class="smrt-filter-chips__root" class:smrt-filter-chips__sm={size === 'sm'} role="radiogroup" data-smrt-component="FilterChips">
  {#each allOptions as option (option.value)}
    {@const isActive = option.value === selected}
    <button
      type="button"
      class="smrt-filter-chips__chip"
      class:smrt-filter-chips__active={isActive}
      data-smrt-part="option"
      disabled={option.disabled}
      role="radio"
      aria-checked={isActive}
      onclick={() => handleClick(option.value)}
      use:ripple
    >
      {#if isActive}
        <span class="smrt-filter-chips__icon" data-smrt-part="icon">
          <Icon name="check" size={18} />
        </span>
      {/if}
      <span class="smrt-filter-chips__label" data-smrt-part="label">{option.label}</span>
      {#if option.count !== undefined}
        <span class="smrt-filter-chips__count" data-smrt-part="count">{option.count}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-filter-chips__root {
    display: flex;
    gap: var(--smrt-spacing-2);
    flex-wrap: wrap;
  }
  .smrt-filter-chips__chip {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    height: 32px;
    padding: 0 var(--smrt-spacing-4);
    cursor: pointer;
    white-space: nowrap;
    position: relative;
    overflow: hidden;
  }
  .smrt-filter-chips__sm .smrt-filter-chips__chip {
    height: 28px;
    padding: 0 var(--smrt-spacing-3);
    gap: var(--smrt-spacing-2);
  }
  .smrt-filter-chips__chip.smrt-filter-chips__active {
    padding-left: var(--smrt-spacing-3);
  }
  .smrt-filter-chips__sm .smrt-filter-chips__chip.smrt-filter-chips__active {
    padding-left: var(--smrt-spacing-2);
  }
  .smrt-filter-chips__chip:disabled {
    cursor: not-allowed;
  }
  .smrt-filter-chips__icon {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-filter-chips__count {
    margin-left: -2px;
  }
  .smrt-filter-chips__chip {
    min-height: var(--smrt-control-target-min);
    min-width: var(--smrt-control-target-min);
  }
  .smrt-filter-chips__root[data-density='touch'] {
    --smrt-control-target-min: var(--smrt-touch-target-min);
  }
  .smrt-filter-chips__root[data-density='comfortable'] {
    --smrt-control-target-min: 0px;
  }
}

@layer smrt.theme {
  .smrt-filter-chips__chip {
    font: var(--smrt-typography-label-large-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant);
    background-color: transparent;
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-md);
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  .smrt-filter-chips__sm .smrt-filter-chips__chip {
    font: var(--smrt-typography-label-medium-font);
  }
  .smrt-filter-chips__chip:hover:not(:disabled) {
    background-color: var(--smrt-color-surface-container-high);
  }
  .smrt-filter-chips__chip.smrt-filter-chips__active {
    background-color: var(--smrt-color-secondary-container);
    border-color: transparent;
    color: var(--smrt-color-on-secondary-container);
  }
  .smrt-filter-chips__chip:disabled {
    opacity: 0.38;
  }
  .smrt-filter-chips__icon {
    color: var(--smrt-color-on-secondary-container);
  }
  .smrt-filter-chips__count {
    font: var(--smrt-typography-label-small-font);
    opacity: 0.7;
  }
  .smrt-filter-chips__active .smrt-filter-chips__count {
    color: var(--smrt-color-on-secondary-container);
  }
  /* Forced colors (#3908): system colours where colour alone carries meaning. */
  @media (forced-colors: active) {
    .smrt-filter-chips__chip.smrt-filter-chips__active {
      background-color: Highlight;
      color: HighlightText;
      border-color: Highlight;
    }
    .smrt-filter-chips__chip:disabled, .smrt-filter-chips__chip.smrt-filter-chips__active:disabled {
      opacity: 1;
      background: Canvas;
      color: GrayText;
      border-color: GrayText;
    }
  }
}

</style>