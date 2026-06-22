<script lang="ts">
/**
 * Skeleton — shape-matching loading placeholder.
 *
 * Variants: `text` (one or more lines), `circle`, `rect`. The wrapper is a
 * polite `role="status"` region with an sr-only label so assistive tech
 * announces that content is loading; the shimmer honors `prefers-reduced-motion`.
 */
export type SkeletonVariant = 'text' | 'circle' | 'rect';

export interface Props {
  /** Placeholder shape. */
  variant?: SkeletonVariant;
  /** CSS width (e.g. '100%', '8rem'). */
  width?: string;
  /** CSS height (e.g. '1rem', '48px'). */
  height?: string;
  /** Number of lines for the `text` variant. */
  lines?: number;
  /** Accessible loading label. */
  label?: string;
}

const {
  variant = 'text',
  width,
  height,
  lines = 1,
  label = 'Loading…',
}: Props = $props();

const lineIndexes = $derived(
  variant === 'text'
    ? Array.from({ length: Math.max(1, lines) }, (_, i) => i)
    : [0],
);
</script>

<span class="skeleton-wrap" role="status" aria-label={label}>
  {#if variant === 'text'}
    {#each lineIndexes as i (i)}
      <span
        class="skeleton skeleton--text"
        style:width={width}
        style:height={height}
        aria-hidden="true"
      ></span>
    {/each}
  {:else}
    <span
      class="skeleton skeleton--{variant}"
      style:width={width}
      style:height={height}
      aria-hidden="true"
    ></span>
  {/if}
</span>

<style>
  .skeleton-wrap {
    display: inline-flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 8px);
    width: 100%;
  }

  .skeleton {
    display: block;
    background: var(--smrt-color-surface-container-highest, #e7e0ec);
    background-image: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--smrt-color-surface) 60%, transparent) 50%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: smrt-skeleton-shimmer 1.4s ease-in-out infinite;
    border-radius: var(--smrt-radius-small, 4px);
  }

  .skeleton--text {
    width: 100%;
    height: var(--smrt-typography-body-medium-size, 1rem);
    border-radius: var(--smrt-radius-extra-small, 4px);
  }

  .skeleton--circle {
    width: 48px;
    height: 48px;
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .skeleton--rect {
    width: 100%;
    height: 96px;
    border-radius: var(--smrt-radius-medium, 8px);
  }

  @keyframes smrt-skeleton-shimmer {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -200% 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
  }
</style>
