<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
import type { BadgeSize, BadgeVariant } from '../../types-generic';

interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, 'class'> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  children?: Snippet;
}

const { variant = 'default', size = 'md', children, ...rest }: Props = $props();
</script>

<span class="badge {variant} {size}" {...rest}>
  {@render children?.()}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: var(--smrt-typography-body-medium-weight);
    border-radius: var(--smrt-radius-full);
    white-space: nowrap;
  }

  /* Sizes */
  .sm {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
    font-size: var(--smrt-typography-body-small-size);
  }

  .md {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
    font-size: var(--smrt-typography-body-medium-size);
  }

  /* Variants */
  .default {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
  }

  .primary {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .success {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }

  .warning {
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }

  .error {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  .info {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
</style>
