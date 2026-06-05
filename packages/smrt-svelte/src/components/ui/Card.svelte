<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
import type { CardPadding, CardVariant } from '../../types-generic';

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
    background: var(--smrt-color-surface);
    border-radius: var(--smrt-radius-medium);
    transition: all var(--smrt-duration-short2) var(--smrt-easing-standard);
  }

  /* Variants */
  .default {
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .outlined {
    border: 2px solid var(--smrt-color-outline);
  }

  .elevated {
    border: 1px solid var(--smrt-color-outline-variant);
    box-shadow: var(--smrt-elevation-2);
  }

  /* Hoverable state */
  .hoverable:hover {
    box-shadow: var(--smrt-elevation-3);
    transform: translateY(-2px);
  }

  /* Padding */
  .padding-none .card-content {
    padding: var(--smrt-spacing-0);
  }

  .padding-sm .card-content {
    padding: var(--smrt-spacing-4);
  }

  .padding-md .card-content {
    padding: var(--smrt-spacing-6);
  }

  .padding-lg .card-content {
    padding: var(--smrt-spacing-8);
  }

  /* Header */
  .card-header {
    padding: var(--smrt-spacing-6);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .padding-sm .card-header {
    padding: var(--smrt-spacing-4);
  }

  .padding-lg .card-header {
    padding: var(--smrt-spacing-8);
  }

  /* Footer */
  .card-footer {
    padding: var(--smrt-spacing-6);
    border-top: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container-low);
    border-bottom-left-radius: var(--radius-md);
    border-bottom-right-radius: var(--radius-md);
  }

  .padding-sm .card-footer {
    padding: var(--smrt-spacing-4);
  }

  .padding-lg .card-footer {
    padding: var(--smrt-spacing-8);
  }
</style>
