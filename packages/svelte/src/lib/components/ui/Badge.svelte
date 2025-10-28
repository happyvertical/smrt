<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

type BadgeVariant =
  | 'default'
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';
type BadgeSize = 'sm' | 'md';

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
    font-weight: var(--font-weight-medium);
    border-radius: var(--radius-full);
    white-space: nowrap;
  }

  /* Sizes */
  .sm {
    padding: 0.125rem var(--spacing-sm);
    font-size: var(--font-size-xs);
  }

  .md {
    padding: 0.25rem var(--spacing-md);
    font-size: var(--font-size-sm);
  }

  /* Variants */
  .default {
    background: var(--color-neutral-gray200);
    color: var(--color-text-primary);
  }

  .primary {
    background: var(--color-primary-light);
    color: var(--color-primary-dark);
  }

  .success {
    background: #e8f5e9;
    color: #2e7d32;
  }

  .warning {
    background: #fff3e0;
    color: #e65100;
  }

  .error {
    background: #ffebee;
    color: #c62828;
  }

  .info {
    background: var(--color-primary-light);
    color: var(--color-primary-dark);
  }
</style>
