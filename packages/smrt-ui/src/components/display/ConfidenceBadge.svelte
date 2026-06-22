<script lang="ts">
/**
 * ConfidenceBadge - Displays AI confidence level indicator
 *
 * Shows a visual indicator for confidence scores (0-100).
 * Useful for OCR results, AI predictions, etc.
 *
 * Accessibility: Uses role="meter" with aria-valuenow for screen readers
 */

/** Props for ConfidenceBadge component */
export interface Props {
  /** Confidence value (0-100) */
  confidence: number;
  /** Show percentage value */
  showPercent?: boolean;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Optional CSS class */
  class?: string;
  /** Accessible label */
  'aria-label'?: string;
}

const {
  confidence,
  showPercent = true,
  size = 'md',
  class: className = '',
  'aria-label': ariaLabel,
}: Props = $props();

// Clamp confidence to valid range
const clampedConfidence = $derived(Math.max(0, Math.min(100, confidence)));

// Determine level based on confidence
const level = $derived.by(() => {
  if (clampedConfidence >= 80) return 'high';
  if (clampedConfidence >= 50) return 'medium';
  return 'low';
});

// Color scheme based on level - uses CSS variables with fallbacks
const colors = $derived.by(() => {
  switch (level) {
    case 'high':
      return {
        bg: 'var(--smrt-color-primary-container, #dcfce7)',
        text: 'var(--smrt-color-on-primary-container, #166534)',
        bar: 'var(--smrt-color-primary, #22c55e)',
      };
    case 'medium':
      return {
        bg: 'var(--smrt-color-secondary-container, #fef3c7)',
        text: 'var(--smrt-color-on-secondary-container, #92400e)',
        bar: 'var(--smrt-color-secondary, #f59e0b)',
      };
    case 'low':
      return {
        bg: 'var(--smrt-color-error-container, #fee2e2)',
        text: 'var(--smrt-color-on-error-container, #dc2626)',
        bar: 'var(--smrt-color-error, #ef4444)',
      };
  }
});

// Format percentage
const percentText = $derived(`${Math.round(clampedConfidence)}%`);

// Accessible label
const defaultLabel = $derived(`Confidence: ${Math.round(clampedConfidence)}%`);

// Human-readable value text for screen readers
const valueText = $derived(
  `${level} confidence (${Math.round(clampedConfidence)}%)`,
);
</script>

<span
  class="confidence-badge {className}"
  class:sm={size === 'sm'}
  class:lg={size === 'lg'}
  style:--badge-bg={colors.bg}
  style:--badge-text={colors.text}
  style:--bar-color={colors.bar}
  role="meter"
  aria-valuenow={clampedConfidence}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuetext={valueText}
  aria-label={ariaLabel ?? defaultLabel}
>
  <span class="confidence-bar" style:width="{clampedConfidence}%"></span>
  {#if showPercent}
    <span class="confidence-value" aria-hidden="true">{percentText}</span>
  {/if}
</span>

<style>
  .confidence-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border-radius: var(--smrt-radius-sm, 4px);
    background-color: var(--badge-bg);
    color: var(--badge-text);
    position: relative;
    overflow: hidden;
    min-width: 60px;
  }

  .confidence-badge.sm {
    padding: 0.125rem 0.375rem;
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    min-width: 48px;
  }

  .confidence-badge.lg {
    padding: 0.375rem 0.75rem;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    min-width: 80px;
  }

  .confidence-bar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background-color: var(--bar-color);
    opacity: 0.3;
    transition: width var(--smrt-duration-short4, 300ms) var(--smrt-easing-standard, ease);
  }

  .confidence-value {
    position: relative;
    z-index: 1;
    font-variant-numeric: tabular-nums;
  }
</style>
