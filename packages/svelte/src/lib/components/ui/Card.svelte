<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

type CardVariant = 'default' | 'outlined' | 'elevated';
type CardPadding = 'none' | 'sm' | 'md' | 'lg';

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
  variant?: CardVariant;
  padding?: CardPadding;
  hoverable?: boolean;
  children?: Snippet;
  header?: Snippet;
  footer?: Snippet;
}

const {
  variant = 'default',
  padding = 'md',
  hoverable = false,
  children,
  header,
  footer,
  ...rest
}: Props = $props();
</script>

<div
  class="card {variant} padding-{padding}"
  class:hoverable
  {...rest}
>
  {#if header}
    <div class="card-header">
      {@render header()}
    </div>
  {/if}

  <div class="card-content">
    {@render children?.()}
  </div>

  {#if footer}
    <div class="card-footer">
      {@render footer()}
    </div>
  {/if}
</div>

<style>
  .card {
    background: var(--color-neutral-white);
    border-radius: var(--radius-md);
    transition: all var(--transition-base);
  }

  /* Variants */
  .default {
    border: 1px solid var(--color-neutral-gray200);
  }

  .outlined {
    border: 2px solid var(--color-neutral-gray300);
  }

  .elevated {
    border: 1px solid var(--color-neutral-gray200);
    box-shadow: var(--shadow-md);
  }

  /* Hoverable state */
  .hoverable:hover {
    box-shadow: var(--shadow-lg);
    transform: translateY(-2px);
  }

  /* Padding */
  .padding-none .card-content {
    padding: 0;
  }

  .padding-sm .card-content {
    padding: var(--spacing-md);
  }

  .padding-md .card-content {
    padding: var(--spacing-lg);
  }

  .padding-lg .card-content {
    padding: var(--spacing-xl);
  }

  /* Header */
  .card-header {
    padding: var(--spacing-lg);
    border-bottom: 1px solid var(--color-neutral-gray200);
  }

  .padding-sm .card-header {
    padding: var(--spacing-md);
  }

  .padding-lg .card-header {
    padding: var(--spacing-xl);
  }

  /* Footer */
  .card-footer {
    padding: var(--spacing-lg);
    border-top: 1px solid var(--color-neutral-gray200);
    background: var(--color-neutral-gray100);
    border-bottom-left-radius: var(--radius-md);
    border-bottom-right-radius: var(--radius-md);
  }

  .padding-sm .card-footer {
    padding: var(--spacing-md);
  }

  .padding-lg .card-footer {
    padding: var(--spacing-xl);
  }
</style>
