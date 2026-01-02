<script lang="ts">
/**
 * DurationDisplay - Formats hours for display
 * Supports decimal (8.5) or HH:MM (8:30) formats
 */

interface Props {
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

const formattedValue = $derived(() => {
  if (format === 'hhmm') {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}:${m.toString().padStart(2, '0')}`;
  }
  return hours.toFixed(1);
});
</script>

<span class="duration" class:sm={size === 'sm'} class:lg={size === 'lg'}>
  <span class="value">{formattedValue()}</span>
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
  }

  .value {
    font-weight: 600;
    color: var(--color-text, #1f2937);
  }

  .unit {
    font-weight: 400;
    color: var(--color-text-muted, #6b7280);
  }

  /* Size variants */
  .duration {
    font-size: 1rem;
  }

  .duration.sm {
    font-size: 0.875rem;
  }

  .duration.sm .value {
    font-weight: 500;
  }

  .duration.lg {
    font-size: 1.5rem;
  }
</style>
