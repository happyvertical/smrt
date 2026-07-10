<script lang="ts">
export interface Props {
  value?: number;
  min?: number;
  max?: number;
  label?: string;
  variant?: 'linear' | 'circular';
  size?: 'sm' | 'md' | 'lg';
  showValue?: boolean;
  class?: string;
}
let {
  value,
  min = 0,
  max = 100,
  label = 'Progress',
  variant = 'linear',
  size = 'md',
  showValue = false,
  class: className = '',
}: Props = $props();
const indeterminate = $derived(value === undefined);
const normalized = $derived(
  indeterminate || max <= min
    ? 0
    : Math.min(100, Math.max(0, (((value ?? min) - min) / (max - min)) * 100)),
);
const displayValue = $derived(
  value === undefined ? '' : `${Math.round(normalized)}%`,
);
</script>
{#if variant === 'circular'}
  <div class="progress progress--circular progress--{size} {className}" class:indeterminate role="progressbar" aria-label={label}
    aria-valuemin={indeterminate ? undefined : min} aria-valuemax={indeterminate ? undefined : max} aria-valuenow={value}>
    <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="track" cx="22" cy="22" r="18"></circle><circle class="indicator" cx="22" cy="22" r="18" style={`--progress: ${normalized}`}></circle></svg>
    {#if showValue && !indeterminate}<span>{displayValue}</span>{/if}
  </div>
{:else}
  <div class="progress progress--linear progress--{size} {className}" class:indeterminate role="progressbar" aria-label={label}
    aria-valuemin={indeterminate ? undefined : min} aria-valuemax={indeterminate ? undefined : max} aria-valuenow={value}>
    <span class="track"><span class="indicator" style:width={indeterminate ? undefined : `${normalized}%`}></span></span>
    {#if showValue && !indeterminate}<span class="value">{displayValue}</span>{/if}
  </div>
{/if}
<style>
  .progress--linear { display: flex; align-items: center; gap: var(--smrt-spacing-2); width: 100%; }
  .progress--linear .track { position: relative; display: block; flex: 1; height: 4px; overflow: hidden; border-radius: var(--smrt-radius-full); background: var(--smrt-color-surface-container-highest); }
  .progress--linear.progress--sm .track { height: 2px; } .progress--linear.progress--lg .track { height: 8px; }
  .progress--linear .indicator { display: block; height: 100%; border-radius: inherit; background: var(--smrt-color-primary); transition: width var(--smrt-duration-short4) var(--smrt-easing-standard); }
  .progress--linear.indeterminate .indicator { position: absolute; width: 35%; animation: linear-progress 1.25s ease-in-out infinite; }
  .value { min-width: 3ch; font: var(--smrt-typography-label-small-font); color: var(--smrt-color-on-surface-variant); }
  .progress--circular { position: relative; display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; }
  .progress--circular.progress--sm { width: 1.75rem; height: 1.75rem; } .progress--circular.progress--lg { width: 4rem; height: 4rem; }
  .progress--circular svg { width: 100%; height: 100%; transform: rotate(-90deg); }
  .progress--circular circle { fill: none; stroke-width: 4; } .progress--circular .track { stroke: var(--smrt-color-surface-container-highest); }
  .progress--circular .indicator { stroke: var(--smrt-color-primary); stroke-linecap: round; stroke-dasharray: 113.1; stroke-dashoffset: calc(113.1 - (113.1 * var(--progress)) / 100); transition: stroke-dashoffset var(--smrt-duration-short4); }
  .progress--circular.indeterminate svg { animation: spin 1s linear infinite; } .progress--circular.indeterminate .indicator { stroke-dasharray: 70 113.1; }
  .progress--circular > span { position: absolute; font: var(--smrt-typography-label-small-font); }
  @keyframes linear-progress { from { left: -40%; } to { left: 105%; } } @keyframes spin { to { transform: rotate(270deg); } }
  @media (prefers-reduced-motion: reduce) { .indicator { transition: none !important; animation-duration: 2.5s !important; } }
</style>
