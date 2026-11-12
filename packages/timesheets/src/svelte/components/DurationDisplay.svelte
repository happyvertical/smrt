<script lang="ts">
/**
 * DurationDisplay - Formats hours for display
 * Supports decimal (8.5) or HH:MM (8:30) formats
 */

import { formatHoursHHMM } from './utils.js';

/** Props for DurationDisplay component */
export interface Props {
  /** Duration in hours to display. */
  hours: number;
  /** Format duration as decimal (8.5) or hours:minutes (8:30). */
  format?: 'decimal' | 'hhmm';
  /** Sets the font size of the duration display. */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Renders the `h` unit after a `decimal` value; set `false` for a bare
   * number, such as in a column whose header already names the unit. An
   * `hhmm` value spells its own unit in the `8:30` shape and never appends a
   * separate one, so this prop does not affect that format.
   */
  showLabel?: boolean;
}

let {
  hours,
  format = 'decimal',
  size = 'md',
  showLabel = true,
}: Props = $props();

// $derived creates a reactive value, not a function - no wrapper or parentheses needed
const formattedValue = $derived(
  format === 'hhmm' ? formatHoursHHMM(hours) : hours.toFixed(1),
);

// Only the decimal form needs a unit appended: `8:30` already reads as hours
// and minutes. That makes `h` the one unit `showLabel` has to gate.
const unit = $derived(format === 'hhmm' ? '' : 'h');
</script>

<span class="smrt-duration-display__root" class:smrt-duration-display__sm={size === 'sm'} class:smrt-duration-display__lg={size === 'lg'} data-smrt-component="DurationDisplay">
  <span class="smrt-duration-display__value" data-smrt-part="value">{formattedValue}</span>
  {#if showLabel && unit}
    <span class="smrt-duration-display__unit" data-smrt-part="unit">{unit}</span>
  {/if}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-duration-display__root {
    display: inline-flex;
    align-items: baseline;
    gap: 0.125rem;
  }
}

@layer smrt.theme {
  .smrt-duration-display__root {
    font-variant-numeric: tabular-nums;
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
  .smrt-duration-display__value {
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-duration-display__unit {
    font-weight: var(--smrt-typography-body-medium-weight, 400);
    color: var(--smrt-color-on-surface-variant);
  }
  /* Size variants */
  .smrt-duration-display__root.smrt-duration-display__sm {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-duration-display__root.smrt-duration-display__sm .smrt-duration-display__value {
    font-weight: var(--smrt-typography-body-medium-weight, 400);
  }
  .smrt-duration-display__root.smrt-duration-display__lg {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
  }
}

</style>
