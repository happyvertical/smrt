<script lang="ts">
export interface Props {
  value: number;
  min?: number;
  max?: number;
  low?: number;
  high?: number;
  optimum?: number;
  label: string;
  showValue?: boolean;
  formatValue?: (value: number) => string;
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
