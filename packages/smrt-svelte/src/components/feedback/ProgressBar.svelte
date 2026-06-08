<script lang="ts">
/**
 * ProgressBar - Visual progress indicator
 * refactored for Material 3
 *
 * Shows progress with optional status-based coloring.
 * Useful for budget tracking, task completion, etc.
 */

/** Props for ProgressBar component */
export interface Props {
  /** Current value (0-100 or custom range) */
  value: number;
  /** Maximum value (default 100) */
  max?: number;
  /** Status determines color */
  status?: 'default' | 'healthy' | 'warning' | 'critical' | 'over';
  /** Show percentage label */
  showLabel?: boolean;
  /** Custom label text */
  label?: string;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Show value over max (e.g., "75/100") */
  showValue?: boolean;
}

const {
  value,
  max = 100,
  status = 'default',
  showLabel = false,
  label,
  size = 'md',
  showValue = false,
}: Props = $props();

// Calculate percentage (capped at 100 for display)
const percentage = $derived(Math.min((value / max) * 100, 100));

// Auto-determine status if not provided
const autoStatus = $derived.by(() => {
  if (status !== 'default') return status;
  const pct = (value / max) * 100;
  if (pct > 100) return 'over';
  if (pct >= 90) return 'critical';
  if (pct >= 75) return 'warning';
  return 'healthy';
});

// Map status to M3 colors
const barColorClass = $derived.by(() => {
  switch (autoStatus) {
    case 'healthy':
      return 'color-primary';
    case 'warning':
      return 'color-tertiary';
    case 'critical':
    case 'over':
      return 'color-error';
    default:
      return 'color-primary';
  }
});

// Format display label
const displayLabel = $derived.by(() => {
  if (label) return label;
  if (showValue) return `${value.toLocaleString()} / ${max.toLocaleString()}`;
  return `${Math.round(percentage)}%`;
});
</script>

<div class="progress-container" class:sm={size === 'sm'} class:lg={size === 'lg'}>
  {#if showLabel || showValue}
    <div class="progress-header">
      <span class="progress-label">{displayLabel}</span>
      {#if value > max}
        <span class="over-badge">Over by {Math.round(value - max).toLocaleString()}</span>
      {/if}
    </div>
  {/if}

  <div
    class="progress-track"
    role="progressbar"
    aria-valuenow={value}
    aria-valuemin={0}
    aria-valuemax={max}
  >
    <div
      class="progress-bar {barColorClass}"
      style:width="{percentage}%"
    ></div>
  </div>
</div>

<style>
  .progress-container {
    width: 100%;
  }

  .progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--smrt-spacing-2, 8px);
  }

  .progress-label {
    font: var(--smrt-typography-label-large-font);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .sm .progress-label {
    font: var(--smrt-typography-label-medium-font);
  }

  .over-badge {
    font: var(--smrt-typography-label-small-font);
    font-weight: 600;
    color: var(--smrt-color-error, #ba1a1a);
  }

  .progress-track {
    width: 100%;
    height: 4px;
    background-color: var(--smrt-color-surface-container-highest, #e0e2ec);
    border-radius: var(--smrt-radius-sm, 4px);
    overflow: hidden;
  }

  .sm .progress-track {
    height: 2px;
  }

  .lg .progress-track {
    height: 8px;
    border-radius: var(--smrt-radius-sm, 4px);
  }

  .progress-bar {
    height: 100%;
    transition: width var(--smrt-duration-medium2, 300ms) var(--smrt-easing-standard, cubic-bezier(0.4, 0, 0.2, 1));
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-bar {
      transition: none;
    }
  }

  .color-primary { background-color: var(--smrt-color-primary, #005ac1); }
  .color-tertiary { background-color: var(--smrt-color-tertiary, #6b5778); }
  .color-error { background-color: var(--smrt-color-error, #ba1a1a); }
</style>