<script lang="ts">
export interface Props {
  /** Current progress value, or undefined to show indeterminate state. */
  value?: number;
  /** Minimum progress value (start point). */
  min?: number;
  /** Maximum progress value (completion point). */
  max?: number;
  /** Accessibility label describing the progress. */
  label?: string;
  /** Display variant: linear progress bar or circular ring. */
  variant?: 'linear' | 'circular';
  /** Size of the progress indicator: sm, md, or lg. */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to display the percentage value. */
  showValue?: boolean;
  /** CSS class to apply to the progress container. */
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
  <div class="smrt-progress__root smrt-progress__circular smrt-progress__{size} {className}" class:smrt-progress__indeterminate={indeterminate} role="progressbar" aria-label={label}
    aria-valuemin={indeterminate ? undefined : min} aria-valuemax={indeterminate ? undefined : max} aria-valuenow={value} data-smrt-component="Progress">
    <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="smrt-progress__track" data-smrt-part="track" cx="22" cy="22" r="18"></circle><circle class="smrt-progress__indicator" data-smrt-part="indicator" cx="22" cy="22" r="18" style={`--smrt-progress-value: ${normalized}`}></circle></svg>
    {#if showValue && !indeterminate}<span>{displayValue}</span>{/if}
  </div>
{:else}
  <div class="smrt-progress__root smrt-progress__linear smrt-progress__{size} {className}" class:smrt-progress__indeterminate={indeterminate} role="progressbar" aria-label={label}
    aria-valuemin={indeterminate ? undefined : min} aria-valuemax={indeterminate ? undefined : max} aria-valuenow={value} data-smrt-component="Progress">
    <span class="smrt-progress__track" data-smrt-part="track"><span class="smrt-progress__indicator" data-smrt-part="indicator" style:width={indeterminate ? undefined : `${normalized}%`}></span></span>
    {#if showValue && !indeterminate}<span class="smrt-progress__value" data-smrt-part="value">{displayValue}</span>{/if}
  </div>
{/if}
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-progress__linear {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    width: 100%;
  }
  .smrt-progress__linear .smrt-progress__track {
    position: relative;
    display: block;
    flex: 1;
    height: 4px;
    overflow: hidden;
  }
  .smrt-progress__linear.smrt-progress__sm .smrt-progress__track {
    height: 2px;
  }
  .smrt-progress__linear.smrt-progress__lg .smrt-progress__track {
    height: 8px;
  }
  .smrt-progress__linear .smrt-progress__indicator {
    display: block;
    height: 100%;
  }
  .smrt-progress__linear.smrt-progress__indeterminate .smrt-progress__indicator {
    position: absolute;
    width: 35%;
  }
  .smrt-progress__value {
    min-width: 3ch;
  }
  .smrt-progress__circular {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
  }
  .smrt-progress__circular.smrt-progress__sm {
    width: 1.75rem;
    height: 1.75rem;
  }
  .smrt-progress__circular.smrt-progress__lg {
    width: 4rem;
    height: 4rem;
  }
  .smrt-progress__circular svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .smrt-progress__circular > span {
    position: absolute;
  }
}

@layer smrt.theme {
  .smrt-progress__linear .smrt-progress__track {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface-container-highest);
  }
  .smrt-progress__linear .smrt-progress__indicator {
    border-radius: inherit;
    background: var(--smrt-color-primary);
    transition: width var(--smrt-duration-short4) var(--smrt-easing-standard);
  }
  .smrt-progress__linear.smrt-progress__indeterminate .smrt-progress__indicator {
    animation: linear-progress 1.25s ease-in-out infinite;
  }
  .smrt-progress__value {
    font: var(--smrt-typography-label-small-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-progress__circular circle {
    fill: none;
    stroke-width: 4;
  }
  .smrt-progress__circular .smrt-progress__track {
    stroke: var(--smrt-color-surface-container-highest);
  }
  .smrt-progress__circular .smrt-progress__indicator {
    stroke: var(--smrt-color-primary);
    stroke-linecap: round;
    stroke-dasharray: 113.1;
    stroke-dashoffset: calc(113.1 - (113.1 * var(--smrt-progress-value)) / 100);
    transition: stroke-dashoffset var(--smrt-duration-short4);
  }
  .smrt-progress__circular.smrt-progress__indeterminate svg {
    animation: spin 1s linear infinite;
  }
  .smrt-progress__circular.smrt-progress__indeterminate .smrt-progress__indicator {
    stroke-dasharray: 70 113.1;
  }
  .smrt-progress__circular > span {
    font: var(--smrt-typography-label-small-font);
  }
  @keyframes linear-progress {
    from {
      left: -40%;
    }
    to {
      left: 105%;
    }
  }
  @keyframes spin {
    to {
      transform: rotate(270deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-progress__linear .smrt-progress__indicator, .smrt-progress__circular .smrt-progress__indicator {
      transition: none;
    }
    .smrt-progress__linear.smrt-progress__indeterminate .smrt-progress__indicator {
      animation-duration: 2.5s;
    }
  }
  /* Forced colors (#3908): system colours where colour alone carries meaning. */
  @media (forced-colors: active) {
    .smrt-progress__linear .smrt-progress__track {
      background: Canvas;
      border: var(--smrt-hairline-strong);
    }
    .smrt-progress__linear .smrt-progress__indicator {
      background: Highlight;
    }
    .smrt-progress__circular .smrt-progress__track {
      stroke: CanvasText;
    }
    .smrt-progress__circular .smrt-progress__indicator {
      stroke: Highlight;
    }
  }
}

</style>
