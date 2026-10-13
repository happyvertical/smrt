<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
import type { CardPadding, CardVariant } from '../../types-generic';

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
  /** Visual variant affecting borders and shadows. */
  variant?: CardVariant;
  /** Interior padding size for the card content. */
  padding?: CardPadding;
  /** Adds hover effects including elevation and lift. */
  hoverable?: boolean;
  /** The main card content. */
  children?: Snippet;
  /** Optional header content displayed at the top. */
  header?: Snippet;
  /** Optional footer content displayed at the bottom. */
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
  {...rest} data-smrt-component="Card"
>
  {#if header}
    <div class="card-header" data-smrt-part="header">
      {@render header()}
    </div>
  {/if}

  <div class="card-content" data-smrt-part="body">
    {@render children?.()}
  </div>

  {#if footer}
    <div class="card-footer" data-smrt-part="footer">
      {@render footer()}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  /*
   * Themeable look (app-level custom properties; defaults keep the stock look):
   *   --smrt-card-border      edge of default and elevated cards
   *   --smrt-card-background  card fill
   *   --smrt-card-shadow      shadow of default cards (elevated keeps its elevation)
   *   --smrt-card-divider     rule between the header/footer and the content
   * The `outlined` variant always draws its outline.
   */
  .card {
    background: var(--smrt-card-background, var(--smrt-surface-panel));
    border-radius: var(--smrt-radius-medium);
    transition: all var(--smrt-duration-short2) var(--smrt-easing-standard);
  }

  /* Variants */
  .default {
    border: var(--smrt-card-border, var(--smrt-hairline));
    box-shadow: var(--smrt-card-shadow, var(--smrt-inset-highlight));
  }

  .outlined {
    border: var(--smrt-hairline-strong);
    box-shadow: var(--smrt-inset-highlight);
  }

  .elevated {
    border: var(--smrt-card-border, var(--smrt-hairline));
    box-shadow: var(--smrt-inset-highlight), var(--smrt-elevation-2);
  }

  /* Hoverable state */
  .hoverable:hover {
    box-shadow: var(--smrt-inset-highlight), var(--smrt-elevation-3);
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
    border-bottom: var(--smrt-card-divider, var(--smrt-hairline));
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
    border-top: var(--smrt-card-divider, var(--smrt-hairline));
    background: var(--smrt-surface-sunken);
    border-bottom-left-radius: var(--smrt-radius-medium);
    border-bottom-right-radius: var(--smrt-radius-medium);
  }

  .padding-sm .card-footer {
    padding: var(--smrt-spacing-4);
  }

  .padding-lg .card-footer {
    padding: var(--smrt-spacing-8);
  }
}
</style>
