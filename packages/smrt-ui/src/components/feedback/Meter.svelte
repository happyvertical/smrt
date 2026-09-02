<script lang="ts">
export interface Props {
  /** Current meter value to display. */
  value: number;
  /** Minimum value on the meter scale. */
  min?: number;
  /** Maximum value on the meter scale. */
  max?: number;
  /** Threshold where value transitions from low to normal. */
  low?: number;
  /** Threshold where value transitions to high. */
  high?: number;
  /** Ideal target value that optimizes the meter display. */
  optimum?: number;
  /** Text label displayed above the meter gauge. */
  label: string;
  /** Whether to display the numeric value in the header. */
  showValue?: boolean;
  /** Function to format the displayed numeric value. */
  formatValue?: (value: number) => string;
  /** CSS class to apply to the meter container. */
  class?: string;
}
let {
  value,
  min = 0,
  max = 100,
  low,
  high,
  optimum,
  label,
  showValue = true,
  formatValue = (next) => String(next),
  class: className = '',
}: Props = $props();
</script>
<div class="meter {className}"><div class="meter__header"><span>{label}</span>{#if showValue}<span>{formatValue(value)}</span>{/if}</div>
  <meter {value} {min} {max} {low} {high} {optimum}>{formatValue(value)}</meter></div>
<style>
  .meter { display: grid; gap: var(--smrt-spacing-2); color: var(--smrt-color-on-surface); }
  .meter__header { display: flex; justify-content: space-between; font: var(--smrt-typography-label-large-font); }
  meter { width: 100%; height: .75rem; accent-color: var(--smrt-color-primary); }
</style>
