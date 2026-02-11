<script lang="ts">
/**
 * DurationDisplay - Formats hours for display
 * Supports decimal (8.5) or HH:MM (8:30) formats
 */

import { formatHoursHHMM } from './utils.js';

/** Props for DurationDisplay component */
export interface Props {
  hours: number;
  format?: 'decimal' | 'hhmm';
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

let {
  hours,
  format = 'decimal',
  size = 'md',
  showLabel = false,
}: Props = $props();

// $derived creates a reactive value, not a function - no wrapper or parentheses needed
const formattedValue = $derived(
  format === 'hhmm' ? formatHoursHHMM(hours) : hours.toFixed(1),
);
</script>

<span class="duration" class:sm={size === 'sm'} class:lg={size === 'lg'}>
  <span class="value">{formattedValue}</span>
  {#if showLabel || format === 'decimal'}
    <span class="unit">{format === 'hhmm' ? '' : 'h'}</span>
  {/if}
</span>

<style>
  .duration {
    display: inline-flex;
    align-items: baseline;
    gap: 0.125rem;
    font-variant-numeric: tabular-nums;
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }

  .value {
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    color: var(--smrt-color-on-surface);
  }

  .unit {
    font-weight: var(--smrt-typography-body-medium-weight, 400);
    color: var(--smrt-color-on-surface-variant);
  }

  /* Size variants */
  .duration.sm {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .duration.sm .value {
    font-weight: var(--smrt-typography-body-medium-weight, 400);
  }

  .duration.lg {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
  }
</style>
