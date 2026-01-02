<script lang="ts">
/**
 * ProgressBar - Visual progress indicator
 *
 * Shows progress with optional status-based coloring.
 * Useful for budget tracking, task completion, etc.
 */

interface Props {
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

// Color based on status
const barColor = $derived.by(() => {
  switch (autoStatus) {
    case 'healthy':
      return '#22c55e';
    case 'warning':
      return '#f59e0b';
    case 'critical':
      return '#ef4444';
    case 'over':
      return '#dc2626';
    default:
      return '#3b82f6';
  }
});

// Background color
const bgColor = $derived.by(() => {
  switch (autoStatus) {
    case 'healthy':
      return '#dcfce7';
    case 'warning':
      return '#fef3c7';
    case 'critical':
    case 'over':
      return '#fee2e2';
    default:
      return '#e5e7eb';
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
    style:background-color={bgColor}
    role="progressbar"
    aria-valuenow={value}
    aria-valuemin={0}
    aria-valuemax={max}
  >
    <div
      class="progress-bar"
      style:width="{percentage}%"
      style:background-color={barColor}
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
    margin-bottom: 0.25rem;
  }

  .progress-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
  }

  .sm .progress-label {
    font-size: 0.75rem;
  }

  .over-badge {
    font-size: 0.75rem;
    font-weight: 500;
    color: #dc2626;
  }

  .progress-track {
    width: 100%;
    height: 0.5rem;
    border-radius: 9999px;
    overflow: hidden;
  }

  .sm .progress-track {
    height: 0.375rem;
  }

  .lg .progress-track {
    height: 0.75rem;
  }

  .progress-bar {
    height: 100%;
    border-radius: 9999px;
    transition: width 0.3s ease;
  }
</style>
